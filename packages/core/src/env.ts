import type { VaultDO } from "./vault";

export type Env = {
  VAULT: DurableObjectNamespace<VaultDO>;
  ASSETS: R2Bucket;
  SETUP_UI: Fetcher;
  ADMIN_SECRET: string;
  /** MCP をブラウザから使うホストの Origin。ネイティブのクライアントは Origin を送らない。 */
  MCP_ALLOWED_ORIGINS?: string;
};
