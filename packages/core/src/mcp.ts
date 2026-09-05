import { STRUCTURE_TOOLS } from "@microlith/haft";
import type { VaultDO } from "./vault";

/**
 * Streamable HTTP の MCP エンドポイント。
 *
 * サーバから能動的に送るメッセージが無いため、仕様が認めている
 * 「POST に application/json を1つ返す」ステートレス実装で足りる。
 * SSE も session ID も要らないので、SDK を足さずに JSON-RPC の分岐だけを書いている。
 */

/** 対応するプロトコル版。クライアントが別の版を要求したらこちらを返して交渉する。 */
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: any };

const result = (id: string | number, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: string | number, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) }
});

/**
 * 仕様は "Servers MUST validate all tool inputs" と書いている。
 * 引数はモデルが組み立てるので、型が合っている保証がない。
 * SQL へはバインドで渡すため注入にはならないが、NaN や巨大な limit がそのまま届く。
 */
function validate(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const definition = STRUCTURE_TOOLS.find((candidate) => candidate.name === tool)!;
  const schema = definition.inputSchema;
  const checked: Record<string, unknown> = {};

  for (const name of schema.required ?? []) {
    if (args[name] === undefined || args[name] === null) {
      throw new Error(`missing required argument: ${name}`);
    }
  }

  for (const [name, rule] of Object.entries(schema.properties)) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    const expected = (rule as { type?: string }).type;
    if (expected === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
      // 上限を切らないと、大きな limit が DO の行読み取りを無駄に使う。
      checked[name] = Math.max(0, Math.min(parsed, 1000));
    } else if (expected === "string") {
      if (typeof value !== "string") throw new Error(`${name} must be a string`);
      if (value.length > 1024) throw new Error(`${name} is too long`);
      checked[name] = value;
    } else {
      checked[name] = value;
    }
  }
  return checked;
}

/** 構造化した結果は text にも入れる。仕様が後方互換のためにそう求めている。 */
const toolResult = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export async function handleMcp(
  request: Request,
  vault: DurableObjectStub<VaultDO>,
  options: { canWrite: boolean; allowedOrigins: string[] }
): Promise<Response> {
  // 仕様上 MUST。ブラウザから来た場合だけ確認すればよく、
  // ネイティブのクライアントは Origin を送らない。
  const origin = request.headers.get("Origin");
  if (origin && !options.allowedOrigins.includes(origin)) {
    return Response.json({ error: "origin not allowed" }, { status: 403 });
  }

  // GET と DELETE は SSE ストリームとセッション終了のためのもの。どちらも持たない。
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const declared = request.headers.get("MCP-Protocol-Version");
  if (declared && !SUPPORTED_VERSIONS.has(declared)) {
    return Response.json({ error: `unsupported protocol version: ${declared}` }, { status: 400 });
  }

  let message: JsonRpcRequest;
  try {
    message = await request.json();
  } catch {
    return Response.json(failure(0, -32700, "parse error"), { status: 400 });
  }

  // 通知とレスポンスには本文を返さない。
  if (message.id === undefined) return new Response(null, { status: 202 });

  const id = message.id;
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return Response.json(result(id, {
        protocolVersion: SUPPORTED_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "microlith", title: "Microlith", version: "0.1.0" },
        instructions:
          "This is an Obsidian vault. The tools read a pre-built index of links, tags and " +
          "headings, so they answer without loading note text. Start with vault_tree to see " +
          "the structure, then follow links with backlinks and outlinks."
      }));
    }

    case "ping":
      return Response.json(result(id, {}));

    case "tools/list":
      // v1 の Remote は構造系のみ。本文系はデスクトップの local MCP が担う(§7)。
      return Response.json(result(id, { tools: STRUCTURE_TOOLS }));

    case "tools/call": {
      const name = message.params?.name;
      const known = STRUCTURE_TOOLS.some((tool) => tool.name === name);
      if (!known) return Response.json(failure(id, -32602, `unknown tool: ${name}`));
      try {
        const args = validate(name, message.params?.arguments ?? {});
        const value = await vault.structure(name, args);
        return Response.json(result(id, toolResult(value)));
      } catch (error) {
        // ツールの実行時エラーは JSON-RPC のエラーではなく isError で返す。
        return Response.json(result(id, {
          content: [{ type: "text", text: String(error) }],
          isError: true
        }));
      }
    }

    default:
      return Response.json(failure(id, -32601, `method not found: ${message.method}`));
  }
}
