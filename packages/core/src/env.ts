import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { VaultDO } from "./vault";

export type Env = {
  VAULT: DurableObjectNamespace<VaultDO>;
  ASSETS: R2Bucket;
  SETUP_UI: Fetcher;
  ADMIN_SECRET: string;
  /** MCP をブラウザから使うホストの Origin。ネイティブのクライアントは Origin を送らない。 */
  MCP_ALLOWED_ORIGINS?: string;
  /** 認可コードとトークンの保管先。ライブラリがこの名前を要求する。 */
  OAUTH_KV: KVNamespace;
  /** ライブラリが同意画面のハンドラに差し込む。 */
  OAUTH_PROVIDER: OAuthHelpers;
};

/** アクセストークンに埋め込まれ、`/mcp` のハンドラに渡る値。 */
export type GrantProps = {
  vaultId: string;
  scope: "mcp-read" | "mcp-write";
};
