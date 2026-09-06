import { Hono } from "hono";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { authorize } from "./authorize";
import mcpApi from "./mcp-api";
import { contentHash } from "./rev";
import { forgetVault, knownVaults, rememberVault } from "./registry";
import { allowedOriginsFrom, createVaultMcpHandler, originAllowed } from "./mcp";
import type { Env } from "./env";
import type { NoteIndex, VaultDO } from "./vault";

export { VaultDO } from "./vault";

/** Cloudflare のアカウントプラン依存の上限(§2-4)。超過は multipart にせず素直に弾く。 */
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

type Device = { id: string; scope: string };

type Variables = {
  vault: DurableObjectStub<VaultDO>;
  device: Device;
};

const bearer = (request: Request): string | null => {
  const header = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/)?.[1];
  if (header) return header;
  // WebSocket API はカスタムヘッダを送れないので、`Sec-WebSocket-Protocol` に
  // `bearer, <token>` を載せる形も受ける。トークンをクエリ文字列に置くとアクセスログに残る。
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

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError((error, c) => {
  // 例外をそのまま投げると HTML のエラーページが返り、クライアントが JSON を
  // 期待している経路が読めない失敗をする。境界で JSON に落とす。
  console.error(error);
  return c.json({ error: "internal", detail: String(error) }, 500);
});

app.use("/vault/:vaultId/*", async (c, next) => {
  c.set("vault", c.env.VAULT.getByName(c.req.param("vaultId")));
  await next();
});

/** 管理操作は ADMIN_SECRET で守る。デバイストークンの発行元がここ(§4)。 */
const requireAdmin = async (c: any, next: any) => {
  const token = bearer(c.req.raw);
  if (!token || !secretEquals(token, c.env.ADMIN_SECRET)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

const requireDevice = async (c: any, next: any) => {
  const token = bearer(c.req.raw);
  // ADMIN_SECRET は全 Vault の管理権限を兼ねる。`/setup` が状態や削除一覧を
  // 読むのに、わざわざ自分用のデバイストークンを発行させる必要はない。
  const device: Device | null = !token
    ? null
    : secretEquals(token, c.env.ADMIN_SECRET)
      ? { id: "admin", scope: "admin" }
      : await c.get("vault").authenticate(token);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  c.set("device", device);
  await next();
};

const requireWrite = async (c: any, next: any) => {
  if (c.get("device").scope === "mcp-read") return c.json({ error: "read-only token" }, 403);
  await next();
};

// --- 管理 -------------------------------------------------------------------

app.get("/vault/:vaultId/devices", requireAdmin, async (c) =>
  c.json({ devices: await c.get("vault").listDevices() }));

app.post("/vault/:vaultId/devices", requireAdmin, async (c) => {
  const { name, scope = "sync" } = await c.req.json<{ name: string; scope?: string }>();
  const deviceToken = crypto.randomUUID().replaceAll("-", "");
  const { id } = await c.get("vault").createDevice(name, scope, deviceToken);
  await rememberVault(c.env, c.req.param("vaultId"));
  // 平文のトークンを返すのはこの一度だけ。以降はハッシュしか持たない。
  return c.json({ id, name, scope, token: deviceToken }, 201);
});

app.delete("/vault/:vaultId/devices", requireAdmin, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id required" }, 400);
  await c.get("vault").revokeDevice(id);
  return c.json({ revoked: id });
});

/**
 * どのクライアントがどの Vault に紐づいているか。
 * これが見えないと、空の結果が「同期されていない」のか
 * 「別の Vault を見ている」のか区別できない(§24.2)。
 */
app.get("/grants", requireAdmin, async (c) => {
  const page = await c.env.OAUTH_PROVIDER.listUserGrants("owner");
  // grant はクライアント名を持たないので引き直す。ID だけでは
  // 「どのアプリがどの Vault を見ているか」が読めず、パネルの意味が無い。
  const named = await Promise.all(page.items.map(async (grant: any) => {
    const client = await c.env.OAUTH_PROVIDER.lookupClient(grant.clientId).catch(() => null);
    return {
      id: grant.id,
      vaultId: grant.metadata?.vaultId ?? null,
      clientName: client?.clientName ?? grant.clientId,
      scope: grant.scope,
      createdAt: grant.createdAt
    };
  }));
  return c.json({ grants: named });
});

app.delete("/grants", requireAdmin, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id required" }, 400);
  await c.env.OAUTH_PROVIDER.revokeGrant(id, "owner");
  return c.json({ revoked: id });
});

app.get("/vaults", requireAdmin, async (c) => c.json({ vaults: await knownVaults(c.env) }));

/** 添付は content hash をキーにしていて他 Vault と共有しうるので、R2 には触らない。 */
app.delete("/vault/:vaultId/destroy", requireAdmin, async (c) => {
  const vaultId = c.req.param("vaultId");
  const result = await c.get("vault").destroy();
  await forgetVault(c.env, vaultId);
  return c.json({ destroyed: vaultId, ...result });
});

// --- 同期 -------------------------------------------------------------------

// bearer で使う経路。OAuth を通さないクライアント(Claude Code や Messages API)向けに残す。
app.all("/vault/:vaultId/mcp", requireDevice, (c) => {
  if (!originAllowed(c.req.raw, allowedOriginsFrom(c.env.MCP_ALLOWED_ORIGINS))) {
    return c.json({ error: "origin not allowed" }, 403);
  }
  return createVaultMcpHandler(c.get("vault")).fetch(c.req.raw);
});

app.get("/vault/:vaultId/ws", requireDevice, (c) =>
  // タグに使うデバイス ID はクライアントの自己申告ではなく認証結果を使う。
  c.get("vault").fetch(new Request(c.req.raw, {
    headers: { ...Object.fromEntries(c.req.raw.headers), "X-Device-Id": c.get("device").id }
  })));

app.get("/vault/:vaultId/status", requireDevice, async (c) =>
  c.json(await c.get("vault").status()));

app.get("/vault/:vaultId/changes", requireDevice, async (c) => {
  const device = c.get("device");
  const result = await c.get("vault").changes(
    Number(c.req.query("since") ?? 0),
    device.id === "admin" ? null : device.id
  );
  return result.status === "resync-required"
    ? c.json({ error: "resync-required", seq: result.seq }, 412)
    : c.json(result);
});

app.get("/vault/:vaultId/file", requireDevice, async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path required" }, 400);
  const vault = c.get("vault");
  const head = await vault.head(path);
  if (!head || head.deleted === 1) return c.json({ error: "not found" }, 404);
  if (head.kind === "note") return c.json(await vault.readNote(path));
  // asset は content hash をキーにしているので、再送しても同じ場所に落ちる。
  const object = await c.env.ASSETS.get(`assets/${head.rev}`);
  if (!object) return c.json({ error: "object missing" }, 404);
  return new Response(object.body, {
    headers: { "content-type": "application/octet-stream", etag: head.rev }
  });
});

app.post("/vault/:vaultId/push", requireDevice, requireWrite, async (c) => {
  const input = await c.req.json<{
    path: string; baseRev: string | null; mtime: number;
    body?: string; deleted?: boolean; index?: NoteIndex;
  }>();
  const result = await c.get("vault").push({ ...input, kind: "note" });
  return result.status === "conflict" ? c.json(result, 409) : c.json(result);
});

app.post("/vault/:vaultId/asset", requireDevice, requireWrite, async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path required" }, 400);
  if (Number(c.req.header("content-length") ?? 0) > MAX_ASSET_BYTES) {
    return c.json({ error: "too large", maxBytes: MAX_ASSET_BYTES }, 413);
  }
  const bytes = await c.req.arrayBuffer();
  const rev = await contentHash(bytes);
  // R2 に先に置く。DO の記録に失敗しても、キーが content hash なので
  // 再送すれば同じ場所を上書きするだけで済む(orphan は GC 対象の重複でしかない)。
  await c.env.ASSETS.put(`assets/${rev}`, bytes);
  const result = await c.get("vault").push({
    path, baseRev: c.req.query("baseRev") ?? null, kind: "asset",
    mtime: Number(c.req.query("mtime") ?? Date.now()), rev, size: bytes.byteLength
  });
  return result.status === "conflict" ? c.json(result, 409) : c.json(result);
});

app.get("/vault/:vaultId/deleted", requireDevice, async (c) =>
  c.json({ files: await c.get("vault").deletedFiles() }));

app.post("/vault/:vaultId/restore", requireDevice, requireWrite, async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path required" }, 400);
  const result = await c.get("vault").restore(path);
  return result.status === "conflict" ? c.json(result, 409) : c.json(result);
});

// --- OAuth の同意画面と `/setup` ------------------------------------------------

app.route("/", authorize);
app.all("*", (c) => c.env.SETUP_UI.fetch(c.req.raw));

/**
 * OAuth 2.1 のプロバイダで全体を包む。MCP の認可仕様は
 * PKCE / 動的クライアント登録 / トークンの audience 検証まで要求していて、
 * 自前で書くには危険が大きすぎる(§21)。
 *
 * `/mcp` だけがトークンで守られ、それ以外(同期 API、`/setup`、同意画面)は
 * これまで通り Hono のアプリが受ける。
 */
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApi as any,
  defaultHandler: app as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp-read", "mcp-write"]
});
