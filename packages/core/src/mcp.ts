import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { STRUCTURE_TOOLS } from "@microlith/haft";
import type { VaultDO } from "./vault";

/**
 * MCP のトランスポートは公式 SDK v2 に任せる。
 *
 * 仕様は約1年で3回改訂され、そのたびに破壊的だった(セッション廃止、`initialize`
 * ハンドシェイク廃止、`server/discover` 追加)。外部クライアントとの相互運用面を
 * 自前で追い続ける前提は取らない。SDK は既定で 2025 系のクライアントも
 * 同じ口で受ける(`legacy: 'stateless'`)。
 *
 * ツールの実体は `VaultDO.structure()` にあり、定義は `haft` にある。
 * ここが持つのは「どう配線するか」だけ。
 */
export function createVaultMcpHandler(vault: DurableObjectStub<VaultDO>) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: "microlith", version: "0.1.0" });
    for (const tool of STRUCTURE_TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          // 引数の検証も SDK 側が inputSchema から行う。
          inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema)
        },
        async (args) => {
          const value = await vault.structure(tool.name, args ?? {});
          // 構造化した結果は text にも入れる。仕様が後方互換のためにそう求めている。
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
            structuredContent: value as Record<string, unknown>
          };
        }
      );
    }
    return server;
  });
}

/**
 * DNS rebinding 対策。仕様上 MUST だが、SDK のミドルウェアは localhost 前提の
 * 既定を持つため、公開 Worker 向けにこちらで判断する。
 * ネイティブのクライアントは Origin を送らないので、無い場合は通す。
 */
export function originAllowed(request: Request, allowed: string[]): boolean {
  const origin = request.headers.get("Origin");
  return !origin || allowed.includes(origin);
}

export const allowedOriginsFrom = (configured: string | undefined): string[] =>
  (configured ?? "https://claude.ai,https://claude.com")
    .split(",").map((value) => value.trim()).filter(Boolean);
