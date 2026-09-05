/**
 * MCP エンドポイントを外部クライアントと同じ形で叩く。
 * トランスポートは公式 SDK v2 が担うが、**配線が正しいか**はここで確かめる。
 * `npm run dev` の隣で `npm run test:mcp`。
 */
import assert from "node:assert/strict";

const base = process.env.MICROLITH_URL ?? "http://localhost:8787";
const admin = process.env.ADMIN_SECRET ?? "local-development-admin-secret";
const vault = `mcp-${Date.now()}`;
const MODERN = "2026-07-28";

const issue = async (name, scope) => {
  const response = await fetch(`${base}/vault/${vault}/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ name, scope })
  });
  return (await response.json()).token;
};

const syncToken = await issue("seed", "sync");
const mcpToken = await issue("claude", "mcp-read");

const push = (path, body, index) => fetch(`${base}/vault/${vault}/push`, {
  method: "POST",
  headers: { Authorization: `Bearer ${syncToken}`, "content-type": "application/json" },
  body: JSON.stringify({ path, baseRev: null, mtime: 1, body, index })
}).then((r) => r.json());

// 小さなグラフを作る: index -> a -> b, index -> c, orphan は孤立
await push("index.md", "# 索引\n", {
  links: [{ dst: "notes/a.md", kind: "wikilink" }, { dst: "notes/c.md", kind: "wikilink" }],
  tags: ["hub"], headings: [{ level: 1, text: "索引", line: 0, parentLine: 0 }]
});
await push("notes/a.md", "# A\n", {
  links: [{ dst: "notes/b.md", kind: "embed" }], tags: ["考古"],
  headings: [
    { level: 1, text: "A", line: 0, parentLine: 0 },
    { level: 2, text: "節1", line: 2, parentLine: 0 },
    { level: 2, text: "節2", line: 4, parentLine: 0 }
  ]
});
await push("notes/b.md", "# B\n", { links: [], tags: ["考古"], headings: [] });
await push("notes/c.md", "# C\n", { links: [], tags: [], headings: [] });
await push("orphan.md", "# 孤立\n", { links: [], tags: [], headings: [] });

/** POST は SSE でも素の JSON でも返りうる。仕様がどちらも認めている。 */
const readBody = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const line = trimmed.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : trimmed);
};

/** 2026-07-28 は版とクライアント能力を毎リクエストの `_meta` で運ぶ。 */
const call = async (method, params = {}, options = {}) => {
  const response = await fetch(`${base}/vault/${vault}/mcp`, {
    method: options.method ?? "POST",
    headers: {
      Authorization: `Bearer ${options.token ?? mcpToken}`,
      "content-type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": options.version ?? MODERN,
      "Mcp-Method": method,
      // 2026-07-28 はロードバランサが本文を開かずに振り分けられるよう、
      // 呼ぶツール名もヘッダに要求する。食い違うと -32020 で拒まれる。
      ...(params.name ? { "Mcp-Name": params.name } : {}),
      ...(options.headers ?? {})
    },
    body: options.noBody ? undefined : JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": options.version ?? MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" }
        }
      }
    })
  });
  return { status: response.status, body: readBody(await response.text()) };
};

const tool = async (name, args = {}) => {
  const { body } = await call("tools/call", { name, arguments: args });
  assert.ok(!body.result?.isError, `${name} が失敗: ${JSON.stringify(body.result?.content)}`);
  assert.ok(!body.error, `${name} が失敗: ${JSON.stringify(body.error)}`);
  return body.result.structuredContent;
};

// --- 現行仕様(2026-07-28)の要求 --------------------------------------------------

const discover = await call("server/discover");
assert.deepEqual(discover.body.result.supportedVersions, [MODERN],
  "server/discover が現行版を告知していない");
assert.ok(discover.body.result.capabilities.tools, "tools ケーパビリティが無い");
assert.equal(discover.body.result._meta["io.modelcontextprotocol/serverInfo"].name, "microlith");

const listed = await call("tools/list");
assert.equal(listed.body.result.resultType, "complete", "resultType が無い(現行仕様の必須)");
assert.ok(typeof listed.body.result.ttlMs === "number", "ttlMs が無い(CacheableResult)");
assert.ok(["public", "private"].includes(listed.body.result.cacheScope), "cacheScope が無い");

const names = listed.body.result.tools.map((t) => t.name);
assert.ok(names.includes("vault_tree"));
assert.ok(!names.includes("read_note"), "v1 の Remote は構造系のみのはず");
assert.ok(!names.includes("search"), "本文検索が Remote に出ている");
for (const t of listed.body.result.tools) {
  assert.ok(t.description, `${t.name} に description が無い`);
  assert.equal(t.inputSchema.type, "object");
}

// --- 2025 系のクライアントも同じ口で受ける ------------------------------------------

for (const legacy of ["2025-06-18", "2025-11-25"]) {
  const response = await fetch(`${base}/vault/${vault}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mcpToken}`, "content-type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": legacy
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  assert.equal(response.status, 200, `${legacy} のクライアントが弾かれる`);
  const body = readBody(await response.text());
  assert.ok(body.result.tools.length > 0, `${legacy} でツール一覧が空`);
}

// --- 認証と Origin ---------------------------------------------------------------

assert.equal((await call("tools/list", {}, { token: "nope" })).status, 401,
  "未知のトークンが通ってしまう");

// DNS rebinding 対策。許可していない Origin は拒む
assert.equal((await call("tools/list", {}, { headers: { Origin: "https://evil.example" } })).status,
  403, "任意の Origin から叩けてしまう");

// SSE ストリームは持たないので GET は 405
assert.equal((await call("tools/list", {}, { method: "GET", noBody: true })).status, 405);

// --- 引数の検証 -----------------------------------------------------------------

const missing = await call("tools/call", { name: "note_outline", arguments: {} });
assert.ok(missing.body.error || missing.body.result?.isError, "必須引数が無くてもエラーにならない");

const wrongType = await call("tools/call", { name: "hub_notes", arguments: { limit: "abc" } });
assert.ok(wrongType.body.error || wrongType.body.result?.isError, "型が違う引数が通ってしまう");

const unknown = await call("tools/call", { name: "no_such_tool", arguments: {} });
assert.ok(unknown.body.error || unknown.body.result?.isError, "未知のツールが通ってしまう");

// --- 構造系ツール ---------------------------------------------------------------

const tree = await tool("vault_tree");
assert.equal(tree.totalFiles, 5);
assert.deepEqual(tree.folders, [{ path: "notes", files: 3 }]);
assert.deepEqual(tree.rootNotes.sort(), ["index.md", "orphan.md"]);

assert.deepEqual((await tool("note_outline", { path: "notes/a.md" })).map((h) => h.text),
  ["A", "節1", "節2"]);

assert.deepEqual((await tool("backlinks", { path: "notes/a.md" })).map((r) => r.path), ["index.md"]);
assert.deepEqual(await tool("outlinks", { path: "notes/a.md" }),
  [{ path: "notes/b.md", kind: "embed", title: "B" }]);

// 再帰 CTE。index からは a,c が1hop、b が2hop
const graph = await tool("graph_neighborhood", { path: "index.md", hops: 2 });
assert.deepEqual(graph.nodes.map((n) => [n.path, n.hop]).sort(),
  [["index.md", 0], ["notes/a.md", 1], ["notes/b.md", 2], ["notes/c.md", 1]]);
assert.equal(graph.edges.length, 3);
assert.equal((await tool("graph_neighborhood", { path: "index.md", hops: 1 })).nodes.length, 3,
  "hops が効いていない");

assert.deepEqual((await tool("orphan_notes")).map((r) => r.path), ["orphan.md"]);
assert.equal((await tool("hub_notes"))[0].path, "index.md",
  "最も繋がっているノートが先頭に来ていない");
assert.deepEqual((await tool("find_by_tag", { tag: "考古" })).map((r) => r.path),
  ["notes/a.md", "notes/b.md"]);
assert.deepEqual(await tool("find_by_tag"), [{ tag: "考古", notes: 2 }, { tag: "hub", notes: 1 }]);

console.log(`mcp: ok (vault=${vault})`);
