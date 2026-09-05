import { contentHash } from "./rev";
import type { Env } from "./env";
import type { NoteIndex } from "./vault";

export { VaultDO } from "./vault";

/** Cloudflare のアカウントプラン依存の上限(§2-4)。超過は multipart にせず素直に弾く。 */
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * WebSocket API はカスタムヘッダを送れないので、`Sec-WebSocket-Protocol` に
 * `bearer, <token>` を載せる形も受ける。トークンをクエリ文字列に置くとアクセスログに残る。
 */
const bearer = (request: Request): string | null => {
  const header = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/)?.[1];
  if (header) return header;
  const offered = request.headers.get("Sec-WebSocket-Protocol")?.split(",").map((v) => v.trim());
  return offered?.[0] === "bearer" && offered[1] ? offered[1] : null;
};

/** タイミング差でシークレットを推測されないよう、長さと内容を一定時間で比べる。 */
const secretEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      // 例外をそのまま投げると HTML のエラーページが返り、クライアントが JSON を
      // 期待している経路が読めない失敗をする。境界で JSON に落とす。
      console.error(error);
      return json({ error: "internal", detail: String(error) }, 500);
    }
  }
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.match(/^\/vault\/([^/]+)\/(.+)$/);
    if (!route) return env.SETUP_UI.fetch(request);

    const [, vaultId, action] = route;
    const vault = env.VAULT.getByName(vaultId);

    // 管理操作は ADMIN_SECRET で守る。デバイストークンの発行元がここ(§4)。
    if (action === "devices") {
      const token = bearer(request);
      if (!token || !secretEquals(token, env.ADMIN_SECRET)) {
        return json({ error: "unauthorized" }, 401);
      }
      if (request.method === "POST") {
        const { name, scope = "sync" } = await request.json<{ name: string; scope?: string }>();
        const deviceToken = crypto.randomUUID().replaceAll("-", "");
        const { id } = await vault.createDevice(name, scope, deviceToken);
        // 平文のトークンを返すのはこの一度だけ。以降はハッシュしか持たない。
        return json({ id, name, scope, token: deviceToken }, 201);
      }
      if (request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "id required" }, 400);
        await vault.revokeDevice(id);
        return json({ revoked: id });
      }
      return json({ devices: await vault.listDevices() });
    }

    const token = bearer(request);
    // ADMIN_SECRET は全 Vault の管理権限を兼ねる。`/setup` が状態や削除一覧を
    // 読むのに、わざわざ自分用のデバイストークンを発行させる必要はない。
    const device = !token
      ? null
      : secretEquals(token, env.ADMIN_SECRET)
        ? { id: "admin", scope: "admin" }
        : await vault.authenticate(token);
    if (!device) return json({ error: "unauthorized" }, 401);

    switch (action) {
      case "ws":
        // タグに使うデバイス ID はクライアントの自己申告ではなく認証結果を使う。
        return vault.fetch(new Request(request, {
          headers: { ...Object.fromEntries(request.headers), "X-Device-Id": device.id }
        }));

      case "status":
        return json(await vault.status());

      case "changes": {
        const since = Number(url.searchParams.get("since") ?? 0);
        const result = await vault.changes(since, device.id === "admin" ? null : device.id);
        return result.status === "resync-required"
          ? json({ error: "resync-required", seq: result.seq }, 412)
          : json(result);
      }

      case "file": {
        const path = url.searchParams.get("path");
        if (!path) return json({ error: "path required" }, 400);
        const head = await vault.head(path);
        if (!head || head.deleted === 1) return json({ error: "not found" }, 404);
        if (head.kind === "note") {
          const note = await vault.readNote(path);
          return json(note);
        }
        // asset は content hash をキーにしているので、再送しても同じ場所に落ちる。
        const object = await env.ASSETS.get(`assets/${head.rev}`);
        if (!object) return json({ error: "object missing" }, 404);
        return new Response(object.body, {
          headers: { "content-type": "application/octet-stream", etag: head.rev }
        });
      }

      case "push": {
        if (device.scope === "mcp-read") return json({ error: "read-only token" }, 403);
        const input = await request.json<{
          path: string; baseRev: string | null; mtime: number;
          body?: string; deleted?: boolean; index?: NoteIndex;
        }>();
        const result = await vault.push({ ...input, kind: "note" });
        return result.status === "conflict" ? json(result, 409) : json(result);
      }

      case "asset": {
        if (device.scope === "mcp-read") return json({ error: "read-only token" }, 403);
        const path = url.searchParams.get("path");
        if (!path) return json({ error: "path required" }, 400);
        const size = Number(request.headers.get("content-length") ?? 0);
        if (size > MAX_ASSET_BYTES) {
          return json({ error: "too large", maxBytes: MAX_ASSET_BYTES }, 413);
        }
        const bytes = await request.arrayBuffer();
        const rev = await contentHash(bytes);
        // R2 に先に置く。DO の記録に失敗しても、キーが content hash なので
        // 再送すれば同じ場所を上書きするだけで済む(orphan は GC 対象の重複でしかない)。
        await env.ASSETS.put(`assets/${rev}`, bytes);
        const result = await vault.push({
          path, baseRev: url.searchParams.get("baseRev"), kind: "asset",
          mtime: Number(url.searchParams.get("mtime") ?? Date.now()),
          rev, size: bytes.byteLength
        });
        return result.status === "conflict" ? json(result, 409) : json(result);
      }

      case "deleted":
        return json({ files: await vault.deletedFiles() });

      case "restore": {
        const path = url.searchParams.get("path");
        if (!path) return json({ error: "path required" }, 400);
        const result = await vault.restore(path);
        return result.status === "conflict" ? json(result, 409) : json(result);
      }

      default:
        return json({ error: "not found" }, 404);
    }
}
