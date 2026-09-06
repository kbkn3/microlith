/**
 * OAuth の口を、MCP クライアントがやるのと同じ順序で通す。
 * 認可はここが破れると Vault 全体が読まれるので、経路を実際に歩いて確かめる。
 * `npm run dev` の隣で `npm run test:oauth`。
 *
 * 順序に意味がある。ライブラリは PKCE の失敗と認可コードの再利用でコードや grant を
 * 失効させ、同じクライアントで再認可すると以前の grant も失効させる(いずれも OAuth 2.1
 * が求める挙動)。そのため**正常系のトークンは最後に取る**。
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const base = process.env.MICROLITH_URL ?? "http://localhost:8787";
const admin = process.env.ADMIN_SECRET ?? "local-development-admin-secret";
const vaultId = `oauth-${Date.now()}`;
const redirectUri = "http://localhost:9999/callback";

const base64url = (buffer) => buffer.toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// --- 発見(RFC 9728 / RFC 8414) ---------------------------------------------

const unauthenticated = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", "Mcp-Method": "tools/list" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
});
assert.equal(unauthenticated.status, 401, "トークン無しで /mcp が通ってしまう");
const challenge = unauthenticated.headers.get("WWW-Authenticate");
assert.ok(challenge?.includes("resource_metadata"),
  `401 の WWW-Authenticate が resource_metadata を指していない: ${challenge}`);

const resourceMetadata = await fetch(`${base}/.well-known/oauth-protected-resource`).then((r) => r.json());
assert.ok(resourceMetadata.authorization_servers?.length > 0, "authorization_servers が無い");

const asMetadata = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
  assert.ok(asMetadata[field], `AS メタデータに ${field} が無い`);
}
assert.ok(asMetadata.code_challenge_methods_supported?.includes("S256"), "PKCE S256 が告知されていない");

// --- 動的クライアント登録(RFC 7591) -------------------------------------------

const register = (clientName) => fetch(asMetadata.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: clientName,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none"
  })
}).then((r) => r.json());

const client = await register("Test MCP Client");
assert.ok(client.client_id, "クライアント登録が失敗している");

// --- 認可 ---------------------------------------------------------------------

/** 認可要求から同意までを1往復。クライアントを分ければ既存 grant を巻き込まない。 */
const obtainCode = async ({ clientId = client.client_id, secret = admin, scope = "mcp-read" } = {}) => {
  const verifier = base64url(randomBytes(32));
  const url = new URL(asMetadata.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope,
    state: "test-state", code_challenge_method: "S256", resource: `${base}/mcp`,
    code_challenge: base64url(createHash("sha256").update(verifier).digest())
  })) url.searchParams.set(key, value);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret, vaultId, scope }),
    redirect: "manual"
  });
  if (response.status !== 302) return { status: response.status, verifier };
  const callback = new URL(response.headers.get("location"));
  return {
    status: 302, verifier,
    state: callback.searchParams.get("state"),
    code: callback.searchParams.get("code")
  };
};

const exchange = (body) => fetch(asMetadata.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body)
});

const redeem = (code, verifier, clientId = client.client_id) => exchange({
  grant_type: "authorization_code", code, redirect_uri: redirectUri,
  client_id: clientId, code_verifier: verifier
});

// 同意画面がクライアント名を出しているか
const consentUrl = new URL(asMetadata.authorization_endpoint);
for (const [key, value] of Object.entries({
  response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
  scope: "mcp-read", state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256"
})) consentUrl.searchParams.set(key, value);
const consent = await fetch(consentUrl);
assert.equal(consent.status, 200, "同意画面が出ない");
assert.ok((await consent.text()).includes("Test MCP Client"), "同意画面がクライアント名を出していない");

// 誤った秘密では発行されない
assert.equal((await obtainCode({ secret: "wrong" })).status, 401,
  "誤った ADMIN_SECRET で認可が通ってしまう");

// --- 失効に関わる挙動(いずれもトークンを巻き込むので専用クライアントで試す) ---------------

// PKCE の verifier が違えば拒む
const pkceClient = await register("PKCE probe");
const doomed = await obtainCode({ clientId: pkceClient.client_id });
const wrongVerifier = await redeem(doomed.code, base64url(randomBytes(32)), pkceClient.client_id);
assert.notEqual(wrongVerifier.status, 200, "PKCE の検証が効いていない");

// 認可コードは一度きり。再利用を検出したら、そのコードから出たトークンごと失効させる。
const replayClient = await register("Replay probe");
const reused = await obtainCode({ clientId: replayClient.client_id });
const firstUse = await redeem(reused.code, reused.verifier, replayClient.client_id).then((r) => r.json());
assert.ok(firstUse.access_token);

const replay = await redeem(reused.code, reused.verifier, replayClient.client_id);
assert.notEqual(replay.status, 200, "認可コードが再利用できてしまう");

const afterReplay = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${firstUse.access_token}`, "content-type": "application/json",
    Accept: "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list"
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
});
assert.equal(afterReplay.status, 401, "再利用を検出しても既存のトークンが生き残っている");

// --- 正常系。ここから先は新しい認可を挟まない -----------------------------------------

const granted = await obtainCode();
assert.equal(granted.state, "test-state", "state が返っていない");
const tokens = await redeem(granted.code, granted.verifier).then((r) => r.json());
assert.ok(tokens.access_token, `トークンが取れない: ${JSON.stringify(tokens)}`);

/** POST は SSE でも素の JSON でも返りうる。仕様がどちらも認めている。 */
const readBody = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const line = trimmed.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : trimmed);
};

/** 2026-07-28 は版とクライアント能力を毎リクエストの `_meta` で運ぶ。 */
const rpc = (method, params = {}, token = tokens.access_token) => fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    ...(params.name ? { "Mcp-Name": params.name } : {})
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" }
      }
    }
  })
}).then(async (r) => ({ status: r.status, body: readBody(await r.text()) }));

const listed = await rpc("tools/list", {});
assert.ok(listed.body.result?.tools?.some((tool) => tool.name === "vault_tree"),
  `OAuth トークンでツール一覧が引けない: ${JSON.stringify(listed)}`);

// 同意画面で選んだ Vault にトークンが束縛されているか
const seedToken = await fetch(`${base}/vault/${vaultId}/devices`, {
  method: "POST",
  headers: { Authorization: `Bearer ${admin}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "seed" })
}).then((r) => r.json()).then((d) => d.token);
await fetch(`${base}/vault/${vaultId}/push`, {
  method: "POST",
  headers: { Authorization: `Bearer ${seedToken}`, "content-type": "application/json" },
  body: JSON.stringify({ path: "bound.md", baseRev: null, mtime: 1, body: "# 束縛の確認\n" })
});

const tree = await rpc("tools/call", { name: "vault_tree", arguments: {} });
assert.deepEqual(tree.body.result.structuredContent.rootNotes, ["bound.md"],
  "トークンが同意時の Vault に束縛されていない");

assert.equal((await rpc("tools/list", {}, "not-a-real-token")).status, 401,
  "でたらめなトークンが通ってしまう");

// --- 認可の観測(§24.2) -----------------------------------------------------------

// どのクライアントがどの Vault に紐づいているかが見えないと、
// 空の結果が「未同期」なのか「別 Vault を見ている」のか区別できない。
// 一覧は KV の list() 越しなので結果整合。作りたての認可はすぐには出ない。
// アクセストークンは `userId:grantId:secret` の形。
const grantId = tokens.access_token.split(":")[1];
const startedAt = Date.now();
let mine = null;
for (let attempt = 0; attempt < 20 && !mine; attempt++) {
  const listing = await fetch(`${base}/grants`, { headers: { Authorization: `Bearer ${admin}` } })
    .then((r) => r.json());
  mine = listing.grants.find((g) => g.id === grantId);
  if (!mine) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (mine) console.log(`  認可が一覧に出るまで ${Date.now() - startedAt}ms`);
assert.ok(mine, "トークンが指す認可が一覧に出ていない");
assert.equal(mine.vaultId, vaultId, "認可が別の Vault に紐づいている");
assert.ok(mine.clientName, "クライアント名が出ていない");
assert.deepEqual(mine.scope, ["mcp-read"]);

assert.equal((await fetch(`${base}/grants`)).status, 401, "grants が誰でも読めてしまう");

// 使った Vault は控えに載り、同意画面が選択肢として出せる
// 控えは単一キーの get なのですぐ出る(§28)。list() に戻したら10秒以上かかるので、
// 待つ余地をわざと 2 秒に切って、退行をここで落とす。
let listedVault = false;
for (let attempt = 0; attempt < 4 && !listedVault; attempt++) {
  const vaultList = await fetch(`${base}/vaults`, { headers: { Authorization: `Bearer ${admin}` } })
    .then((r) => r.json());
  listedVault = vaultList.vaults.includes(vaultId);
  if (!listedVault) await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.ok(listedVault, "Vault の控えに載っていない");

// 失効させたらトークンが死ぬ
await fetch(`${base}/grants?id=${mine.id}`, {
  method: "DELETE", headers: { Authorization: `Bearer ${admin}` }
});
assert.equal((await rpc("tools/list", {})).status, 401, "失効させてもトークンが生きている");

console.log(`oauth: ok (vault=${vaultId})`);
