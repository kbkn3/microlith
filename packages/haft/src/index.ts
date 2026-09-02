/**
 * 柄(haft) — MCP ツールスキーマの共通定義。
 * Remote MCP (Worker) と Local MCP (プラグイン) が同じ定義を共有し、
 * ハンドラだけを差し替えられるようにするための層。
 */

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
};

/** 構造系: インデックスのみを見るため、本文を読まずに答えられる。 */
export const STRUCTURE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "vault_tree",
    description: "Vault のフォルダ階層を返す",
    inputSchema: { type: "object", properties: { depth: { type: "number" } } }
  },
  {
    name: "note_outline",
    description: "ノートの見出しツリーを返す",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  },
  {
    name: "backlinks",
    description: "指定ノートへの被リンクを返す",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  },
  {
    name: "outlinks",
    description: "指定ノートからの発リンクを返す",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }
];

/** 本文系: v1 では Local MCP のみが実装する(§7)。 */
export const CONTENT_TOOLS: readonly ToolDefinition[] = [
  {
    name: "read_note",
    description: "ノート本文を返す",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  },
  {
    name: "search",
    description: "全文検索。3文字以上は FTS5、2文字以下は部分一致にフォールバックする",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  }
];

export const ALL_TOOLS: readonly ToolDefinition[] = [...STRUCTURE_TOOLS, ...CONTENT_TOOLS];
