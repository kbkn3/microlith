/**
 * MCP エンドポイントを外部クライアントと同じ形で叩く。
 * 外部との契約なので、仕様に書かれている振る舞いを直接確かめる。
 * `npm run dev` の隣で `npm run test:mcp`。
 */
import assert from "node:assert/strict";

const base = process.env.MICROLITH_URL ?? "http://localhost:8787";
const admin = process.env.ADMIN_SECRET ?? "local-development-admin-secret";
const vault = `mcp-${Date.now()}`;

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
  tags: ["hub"],
  headings: [{ level: 1, text: "索引", line: 0, parentLine: 0 }]
});
await push("notes/a.md", "# A\n\n## 節1\n\n## 節2\n", {
  links: [{ dst: "notes/b.md", kind: "embed" }],
  tags: ["考古"],
  headings: [
    { level: 1, text: "A", line: 0, parentLine: 0 },
    { level: 2, text: "節1", line: 2, parentLine: 0 },
    { level: 2, text: "節2", line: 4, parentLine: 0 }
  ]
});
await push("notes/b.md", "# B\n", { links: [], tags: ["考古"], headings: [] });
await push("notes/c.md", "# C\n", { links: [], tags: [], headings: [] });
await push("orphan.md", "# 孤立\n", { links: [], tags: [], headings: [] });

const rpc = async (method, params, options = {}) => {
  const response = await fetch(`${base}/vault/${vault}/mcp`, {
    method: options.method ?? "POST",
    headers: {
      Authorization: `Bearer ${options.token ?? mcpToken}`,
      "content-type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(options.headers ?? {})
    },
    body: options.noBody ? undefined : JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const text = await response.text();
  // 405 などは JSON を返さない経路なので、読めないときは素通しする
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: text };
  }
};

const call = async (name, args = {}) => {
  const { body } = await rpc("tools/call", { name, arguments: args });
  assert.ok(!body.result?.isError, `${name} が失敗: ${JSON.stringify(body.result?.content)}`);
  return body.result.structuredContent;
};

// --- ライフサイクル ------------------------------------------------------------

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "0" }
});
assert.equal(init.body.result.protocolVersion, "2025-06-18");
assert.deepEqual(init.body.result.capabilities.tools, { listChanged: false });
assert.equal(init.body.result.serverInfo.name, "microlith");

// クライアントが古い版を要求したらその版で応じる(仕様の版交渉)
const old = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {} });
assert.equal(old.body.result.protocolVersion, "2024-11-05");

// 通知には本文を返さない
const notification = await fetch(`${base}/vault/${vault}/mcp`, {
  method: "POST",
  headers: { Authorization: `Bearer ${mcpToken}`, "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
});
assert.equal(notification.status, 202, "通知に 202 を返していない");

// SSE も session も持たないので GET は 405
const getStream = await rpc("", null, { method: "GET", noBody: true });
assert.equal(getStream.status, 405);

// 未対応の版は 400
const badVersion = await rpc("ping", {}, { headers: { "MCP-Protocol-Version": "1999-01-01" } });
assert.equal(badVersion.status, 400);

// DNS rebinding 対策。許可していない Origin は拒む
const badOrigin = await rpc("ping", {}, { headers: { Origin: "https://evil.example" } });
assert.equal(badOrigin.status, 403, "任意の Origin から叩けてしまう");

// 認証は同期 API と同じ
const anonymous = await rpc("ping", {}, { token: "nope" });
assert.equal(anonymous.status, 401);

// --- ツール一覧 ---------------------------------------------------------------

const { body: listed } = await rpc("tools/list", {});
const names = listed.result.tools.map((tool) => tool.name);
assert.ok(names.includes("vault_tree"));
assert.ok(!names.includes("read_note"), "v1 の Remote は構造系のみのはず");
assert.ok(!names.includes("search"), "本文検索が Remote に出ている");
for (const tool of listed.result.tools) {
  assert.ok(tool.description, `${tool.name} に description が無い`);
  assert.equal(tool.inputSchema.type, "object");
}

const unknown = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
assert.equal(unknown.body.error.code, -32602, "未知のツールは JSON-RPC エラーで返すべき");

// --- 引数の検証 ---------------------------------------------------------------

// 引数はモデルが組み立てるので、型が合っている保証がない(仕様の MUST)
const missing = await rpc("tools/call", { name: "note_outline", arguments: {} });
assert.equal(missing.body.result.isError, true, "必須引数が無くてもエラーにならない");

const wrongType = await rpc("tools/call", { name: "hub_notes", arguments: { limit: "abc" } });
assert.equal(wrongType.body.result.isError, true, "数値でない limit が通ってしまう");

const notAString = await rpc("tools/call", { name: "note_outline", arguments: { path: 42 } });
assert.equal(notAString.body.result.isError, true, "文字列でない path が通ってしまう");

// 巨大な limit は DO の行読み取りを無駄に使うので頭打ちにする
const huge = await rpc("tools/call", { name: "hub_notes", arguments: { limit: 10 ** 9 } });
assert.ok(!huge.body.result.isError, "上限は切り詰めであってエラーではない");

// --- 構造系ツール --------------------------------------------------------------

const tree = await call("vault_tree");
assert.equal(tree.totalFiles, 5);
assert.deepEqual(tree.folders, [{ path: "notes", files: 3 }]);
assert.deepEqual(tree.rootNotes.sort(), ["index.md", "orphan.md"]);

const outline = await call("note_outline", { path: "notes/a.md" });
assert.deepEqual(outline.map((h) => h.text), ["A", "節1", "節2"]);

const back = await call("backlinks", { path: "notes/a.md" });
assert.deepEqual(back.map((row) => row.path), ["index.md"]);

const out = await call("outlinks", { path: "notes/a.md" });
assert.deepEqual(out, [{ path: "notes/b.md", kind: "embed", title: "B" }]);

// 再帰 CTE。index からは a,c が1hop、b が2hop
const graph = await call("graph_neighborhood", { path: "index.md", hops: 2 });
assert.deepEqual(
  graph.nodes.map((node) => [node.path, node.hop]).sort(),
  [["index.md", 0], ["notes/a.md", 1], ["notes/b.md", 2], ["notes/c.md", 1]]
);
assert.equal(graph.edges.length, 3);

const oneHop = await call("graph_neighborhood", { path: "index.md", hops: 1 });
assert.equal(oneHop.nodes.length, 3, "hops が効いていない");

const orphans = await call("orphan_notes");
assert.deepEqual(orphans.map((row) => row.path), ["orphan.md"]);

const hubs = await call("hub_notes");
assert.equal(hubs[0].path, "index.md", "最も繋がっているノートが先頭に来ていない");

const tagged = await call("find_by_tag", { tag: "考古" });
assert.deepEqual(tagged.map((row) => row.path), ["notes/a.md", "notes/b.md"]);

const allTags = await call("find_by_tag");
assert.deepEqual(allTags, [{ tag: "考古", notes: 2 }, { tag: "hub", notes: 1 }]);

console.log(`mcp: ok (vault=${vault})`);
