import { allowedOriginsFrom, createVaultMcpHandler, originAllowed } from "./mcp";
import type { Env, GrantProps } from "./env";

/**
 * OAuth で保護された MCP エンドポイント。
 *
 * `apiRoute` はパスの前缀しか受けないため `/vault/:id/mcp` の形にはできない。
 * 代わりに **どの Vault かはアクセストークンに埋まっている**(同意画面で選ぶ)。
 * claude.ai には URL を1つ渡せばよく、トークンが Vault に束縛される。
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!originAllowed(request, allowedOriginsFrom(env.MCP_ALLOWED_ORIGINS))) {
      return Response.json({ error: "origin not allowed" }, { status: 403 });
    }
    const props = (ctx as ExecutionContext & { props?: GrantProps }).props;
    if (!props?.vaultId) {
      return Response.json({ error: "grant is missing a vault" }, { status: 403 });
    }
    return createVaultMcpHandler(env.VAULT.getByName(props.vaultId), {
      canWrite: props.scope === "mcp-write",
    }).fetch(request);
  },
};
