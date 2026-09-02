import { DurableObject } from "cloudflare:workers";
import { ALL_TOOLS } from "@microlith/haft";
import { SCHEMA } from "./schema";

type Env = {
  VAULT: DurableObjectNamespace<VaultDO>;
  ASSETS: R2Bucket;
  SETUP_UI: Fetcher;
  ADMIN_SECRET: string;
};

/** 石核(core) — Vault ごとに1つ。メタデータ・本文・インデックス・通知の中心。 */
export class VaultDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // hibernation から復帰するたび constructor が走るため、ここは冪等でなければならない。
    for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
    // keepalive を自前で処理すると毎回 DO が起きて hibernation が無意味になる。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async status() {
    const [row] = [...this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM files")];
    return {
      files: row.n,
      seq: this.currentSeq(),
      databaseSize: this.ctx.storage.sql.databaseSize,
      connectedDevices: this.ctx.getWebSockets().length,
      tools: ALL_TOOLS.map((tool) => tool.name)
    };
  }

  private currentSeq(): number {
    const [row] = [...this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'seq'"
    )];
    return row ? Number(row.value) : 0;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    const deviceId = new URL(request.url).searchParams.get("device") ?? "unknown";
    // accept() ではなく acceptWebSocket() を使う。前者は接続中ずっと duration 課金され、
    // 3端末を掴みっぱなしにすると無料枠の 13,000 GB-s/日 すら超える。
    // tag に deviceId を入れておくと、発信元を除いたブロードキャストが書ける。
    this.ctx.acceptWebSocket(server, [deviceId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const origin = this.ctx.getTags(ws)[0];
    for (const peer of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(peer)[0] !== origin) peer.send(message);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // §5.3 のパス形。同期 API はこの下に生やす。
    const vaultRoute = url.pathname.match(/^\/vault\/([^/]+)\/(ws|status)$/);
    if (vaultRoute) {
      const [, vaultId, action] = vaultRoute;
      const vault = env.VAULT.getByName(vaultId);
      return action === "ws"
        ? vault.fetch(request)
        : Response.json(await vault.status());
    }

    return env.SETUP_UI.fetch(request);
  }
} satisfies ExportedHandler<Env>;
