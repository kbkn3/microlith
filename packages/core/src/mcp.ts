import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { CONTENT_TOOLS, STRUCTURE_TOOLS } from "@microlith/haft";
import type { VaultDO } from "./vault";

/**
 * MCP のトランスポートは公式 SDK v2 に任せる。
 *
 * 仕様は約1年で3回改訂され、そのたびに破壊的だった(セッション廃止、`initialize`
 * ハンドシェイク廃止、`server/discover` 追加)。外部クライアントとの相互運用面を
 * 自前で追い続ける前提は取らない。SDK は既定で 2025 系のクライアントも
 * 同じ口で受ける(`legacy: 'stateless'`)。
 *
 * ツールの実体は `VaultDO` 側にあり、定義は `haft` にある。
 * ここが持つのは「どう配線するか」だけ。
 *
 * 本文系も Remote が持つ。§2-6 で平文モード単一に決めたためサーバが本文を読めて、
 * デスクトップ専用の Local MCP を別に作る理由が無くなった(§26)。
 */
export function createVaultMcpHandler(
  vault: DurableObjectStub<VaultDO>,
  options: { canWrite: boolean }
) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: "microlith", version: "0.1.0" });

    // 読み取り専用のトークンに書き込みツールを見せない。
    // 呼べないツールを一覧に出すと、モデルが試して失敗するだけ。
    const available = [...STRUCTURE_TOOLS, ...CONTENT_TOOLS]
      .filter((tool) => options.canWrite || tool.name !== "write_note");

    for (const tool of available) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          // 引数の検証も SDK 側が inputSchema から行う。
          inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema)
        },
        async (args) => {
          const value = await dispatch(vault, tool.name, args ?? {});
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

const STRUCTURE_NAMES = new Set(STRUCTURE_TOOLS.map((tool) => tool.name));

async function dispatch(
  vault: DurableObjectStub<VaultDO>,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (STRUCTURE_NAMES.has(name)) return vault.structure(name, args);
  if (name !== "write_note") return vault.content(name, args);

  // 書き込みは同期プロトコルを通す。DO が WebSocket で全端末へ通知するので、
  // Claude が書いた内容がそのまま各デバイスに現れる(§6 の目玉体験)。
  const path = String(args.path);
  const head = await vault.head(path);
  const baseRev = head && head.deleted === 0 ? head.rev : null;
  const result = await vault.push({
    path, baseRev, kind: "note", mtime: Date.now(), body: String(args.content)
  });
  if (result.status === "conflict") {
    throw new Error(`${path} changed on another device while writing. Read it again first.`);
  }
  return { path, rev: result.rev, seq: result.seq, status: result.status };
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
