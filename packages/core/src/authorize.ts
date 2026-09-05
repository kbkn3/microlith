import { Hono } from "hono";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, GrantProps } from "./env";

/**
 * OAuth の同意画面。
 *
 * セルフホストなので身元は `ADMIN_SECRET` を知っているかどうかで決まる。
 * 外部の IdP を挟まないぶん、ここが唯一の認証点になる。
 */
export const authorize = new Hono<{ Bindings: Env }>();

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (request: AuthRequest, clientName: string, error?: string) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escape(clientName)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfaf8; --panel:#fff; --ink:#1c1a17; --muted:#6b6560;
          --line:#e2ded8; --accent:#7a5c3e; --danger:#9b3b2f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#171614; --panel:#1f1e1b; --ink:#eceae6; --muted:#9a938c; --line:#33302c;
            --accent:#c9a06d; --danger:#d97a6c; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--ink);
         font:15px/1.6 ui-sans-serif, system-ui, -apple-system, "Hiragino Sans", sans-serif; }
  main { max-width:28rem; margin:0 auto; background:var(--panel); border:1px solid var(--line);
         border-radius:10px; padding:1.75rem; }
  h1 { font-size:1.2rem; margin:0 0 0.25rem; }
  p.lead { color:var(--muted); margin:0 0 1.5rem; }
  label { display:block; font-size:0.85rem; color:var(--muted); margin:1rem 0 0.3rem; }
  input, select, button { font:inherit; width:100%; padding:0.55rem 0.7rem; border-radius:7px;
                          border:1px solid var(--line); background:var(--bg); color:var(--ink); }
  button { margin-top:1.5rem; cursor:pointer; background:var(--accent); color:var(--bg);
           border-color:transparent; font-weight:600; }
  .error { color:var(--danger); font-size:0.9rem; margin-top:1rem; }
  .grants { margin:0; padding-left:1.1rem; color:var(--muted); font-size:0.9rem; }
</style>
<main>
  <h1>Authorize ${escape(clientName)}</h1>
  <p class="lead">This will let it reach one vault on your Microlith server.</p>
  <ul class="grants">
    <li>Read the structure of your notes: folders, headings, links and tags</li>
    <li>It cannot read note text; that stays on your own devices</li>
  </ul>
  <form method="post">
    <label for="vaultId">Vault</label>
    <input id="vaultId" name="vaultId" value="default" required>
    <label for="scope">Access</label>
    <select id="scope" name="scope">
      <option value="mcp-read">Read only</option>
      <option value="mcp-write">Read and write</option>
    </select>
    <label for="secret">Admin secret</label>
    <input id="secret" name="secret" type="password" autocomplete="off" required>
    ${error ? `<p class="error">${escape(error)}</p>` : ""}
    <button type="submit">Authorize</button>
  </form>
</main>`;

/** 同意画面は一度きりで完結するので、認可要求そのものを hidden ではなく再解析する。 */
const parse = (c: { env: Env; req: { raw: Request } }) =>
  c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);

authorize.get("/authorize", async (c) => {
  const request = await parse(c);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(request.clientId);
  return c.html(page(request, client?.clientName ?? request.clientId));
});

authorize.post("/authorize", async (c) => {
  const request = await parse(c);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(request.clientId);
  const form = await c.req.formData();
  const secret = String(form.get("secret") ?? "");
  const vaultId = String(form.get("vaultId") ?? "").trim();
  const scope = String(form.get("scope") ?? "mcp-read") === "mcp-write" ? "mcp-write" : "mcp-read";

  // 総当たりを避けるため、失敗の理由は分けずに一つの文言で返す。
  if (secret !== c.env.ADMIN_SECRET || !vaultId) {
    return c.html(page(request, client?.clientName ?? request.clientId,
      "Could not authorize with those details."), 401);
  }

  const props: GrantProps = { vaultId, scope };
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request,
    // ライブラリは認可コードを `userId:grantId:secret` として分解するため、
    // userId にコロンを入れてはいけない。Vault 名は利用者が決めるので使えない。
    // セルフホストの所有者は ADMIN_SECRET を知っている1人だけなので定数でよい。
    userId: "owner",
    metadata: { vaultId },
    scope: [scope],
    props
  });
  return c.redirect(redirectTo, 302);
});
