# Microlith

Self-hosted Obsidian sync on Cloudflare, with an MCP server so Claude can read and write your vault.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kbkn3/microlith)

細石刃(microlith)は、小さな刃を柄に植え込んで一つの道具にする複合具です。
小さなノートを各デバイスという柄に植えて一つの Vault にする、というメタファーから名前を取っています。

## Status

Work in progress. The sync protocol and schema are settled; the sync API, plugin, setup UI, and MCP
server are not implemented yet. See `microlith-handoff.md` for the design record.

## Before you deploy

- **R2 requires a payment method on file**, even though normal single-user usage stays within the
  free tier. Cloudflare will ask you to add one when the bucket is provisioned.
- A single-user vault fits in the Workers **Free** plan. The Workers Paid plan is not required.
- You will be asked for an `ADMIN_SECRET`, which protects the setup page.
  Generate one with `openssl rand -hex 32`.

## Design decisions

Microlith is **plaintext, self-hosted only**. There is no end-to-end encryption mode and no managed
service. The reasoning: plaintext is what lets the MCP server read your notes, and hosting it in
your own Cloudflare account is what makes plaintext defensible. That trade is the opposite of the
one Self-hosted LiveSync and Remotely Save make, and it is deliberate.

Compared to Obsidian Sync:

| | Obsidian Sync | Microlith |
|---|---|---|
| Conflicts | merge by default, or conflict file | conflict file only (merge planned) |
| Version history | notes 1 month, attachments 2 weeks | none |
| Deleted file recovery | yes | yes, 30 days |
| Images / audio / video / PDF | excluded by default | same |
| Max file size | 5 MB / 200 MB by plan | 100 MB |
| Vault config (`.obsidian`) | synced | not yet |

## Layout

```
wrangler.jsonc         Worker config (kept at the repo root for Deploy button compatibility)
packages/core          石核 — Worker + Durable Object
packages/blade         刃 — the Obsidian plugin
packages/haft          柄 — MCP tool schemas shared by the remote and local servers
```

## Development

```
npm install
npm run dev
npm run typecheck
npm run smoke        # sync API, requires `npm run dev` in another terminal
npm run test:blade   # sync engine against a running dev server
npm run build:blade  # builds packages/blade/main.js for Obsidian
```

The sync engine talks to an adapter rather than to Obsidian directly, so `test:blade` drives two
simulated devices against a real server without launching Obsidian.

## License

Not chosen yet.
