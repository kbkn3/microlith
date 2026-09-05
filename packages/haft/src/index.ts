/**
 * 柄(haft) — サーバとクライアントが共有する定義。
 * MCP ツールスキーマ(Remote / Local 両実装が共有)と、
 * 両者で必ず一致していなければならないプロトコル上の計算を置く。
 */

/**
 * rev は本文の content hash。サーバが採番した rev とクライアントが計算した値が
 * 一致しないと競合検知が壊れるため、定義をここに1つだけ置く。
 */
export async function contentHash(body: string | ArrayBuffer): Promise<string> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}


export type ToolDefinition = {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, { readonly type?: string; readonly description?: string }>;
    readonly required?: readonly string[];
  };
};

/** 構造系: インデックスのみを見るため、本文を読まずに答えられる。 */
export const STRUCTURE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "vault_tree",
    title: "Vault tree",
    description:
      "List the folder structure of the vault. Use this first to see what is in the vault " +
      "before reaching for other tools.",
    inputSchema: {
      type: "object",
      properties: {
        depth: { type: "number", description: "How many folder levels to descend. Defaults to 3." },
        prefix: { type: "string", description: "Only show this folder and below." }
      }
    }
  },
  {
    name: "note_outline",
    title: "Note outline",
    description:
      "Return the heading structure of one note. Pair this with read_section to read part of a " +
      "long note instead of the whole thing.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Vault-relative path, e.g. notes/idea.md" } },
      required: ["path"]
    }
  },
  {
    name: "backlinks",
    title: "Backlinks",
    description: "List the notes that link to this note.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    name: "outlinks",
    title: "Outgoing links",
    description: "List the notes this note links to, including embeds.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    name: "graph_neighborhood",
    title: "Graph neighborhood",
    description:
      "Return the notes within a few link hops of this one, with the edges between them. " +
      "Use this to understand how an idea connects to the rest of the vault.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        hops: { type: "number", description: "How many link hops to follow. Defaults to 2." }
      },
      required: ["path"]
    }
  },
  {
    name: "orphan_notes",
    title: "Orphan notes",
    description: "List notes that nothing links to and that link to nothing.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Defaults to 50." } }
    }
  },
  {
    name: "hub_notes",
    title: "Hub notes",
    description: "List the most heavily linked notes, most connected first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Defaults to 20." } }
    }
  },
  {
    name: "find_by_tag",
    title: "Find notes by tag",
    description: "List the notes carrying a tag. Omit the tag to list every tag with its count.",
    inputSchema: {
      type: "object",
      properties: { tag: { type: "string", description: "Without the leading #." } }
    }
  }
];

/** 本文系: v1 では Local MCP のみが実装する(§7)。 */
export const CONTENT_TOOLS: readonly ToolDefinition[] = [
  {
    name: "read_note",
    title: "Read note",
    description: "Return the full text of a note.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    name: "read_section",
    title: "Read section",
    description: "Return one section of a note, identified by its heading.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, heading: { type: "string" } },
      required: ["path", "heading"]
    }
  },
  {
    name: "search",
    title: "Search",
    description:
      "Full text search across the vault. Queries of three characters or more use the index; " +
      "shorter ones fall back to a substring scan.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"]
    }
  },
  {
    name: "write_note",
    title: "Write note",
    description:
      "Create or replace a note. The change syncs to every connected device immediately.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  }
];

export const ALL_TOOLS: readonly ToolDefinition[] = [...STRUCTURE_TOOLS, ...CONTENT_TOOLS];
