# Microlith

Self-hosted Obsidian sync on Cloudflare, with an MCP server so Claude can read and write your vault.

Cloudflare 上で動作するセルフホスト型の Obsidian 同期基盤です。MCP サーバーを備えており、
Claude から Vault を読み書きできます。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kbkn3/microlith)

[English](#english) | [日本語](#日本語)

## English

A microlith is a small stone blade set into a handle to form a composite tool. The name reflects
how Microlith brings small notes together across devices to form one vault.

### Status

Microlith v0.1 is beta software. The sync API, Obsidian plugin, setup UI, and OAuth-protected
remote MCP server are implemented and tested together. Desktop sync and the Claude connector have
also been verified against a deployed Worker.

Mobile Obsidian support, initial sync of a large vault, and the first public BRAT release still need
real-world validation.

### Before you deploy

- **R2 requires a payment method on file**, even though normal single-user usage stays within the
  free tier. Cloudflare will ask you to add one when the bucket is provisioned.
- A single-user vault fits in the Workers **Free** plan. The Workers Paid plan is not required.
- You will be asked for an `ADMIN_SECRET`, which protects the setup page.
  Generate one with `openssl rand -hex 32`.

### Setup

Open your Worker's URL after deploying. Enter the `ADMIN_SECRET` you chose, pick a vault name, and
issue a `sync` token for each Obsidian device. The setup page also shows vault status, lets you
revoke devices and connected apps, and restores files deleted within the last 30 days.

Tokens come in three scopes: `sync` for the Obsidian plugin, and `mcp-read` / `mcp-write` for
MCP clients that accept bearer tokens. The server only stores a hash, so a token is shown once and
cannot be recovered — revoke it and issue a new one instead.

### The Obsidian plugin

The plugin is distributed as a beta through
[BRAT](https://github.com/TfTHacker/obsidian42-brat) until it is submitted to the community
plugin list. Install BRAT, then add `kbkn3/microlith` as a beta plugin.

To install it by hand instead, take `manifest.json` and `main.js` from a release and drop them
into `<your vault>/.obsidian/plugins/microlith/`.

Either way, open the plugin's settings and fill in your server URL, a vault name, and a device
token issued from the server's setup page.

### Connect Claude

Add `<your Worker URL>/mcp` as a custom connector. The OAuth consent page asks for your
`ADMIN_SECRET`, the vault to expose, and whether Claude should have read-only or read-write access.
Each authorization is tied to one vault and can be revoked from the setup page.

The MCP server can browse folders, headings, links, tags, and graph relationships; read notes and
sections; search note text; and, with read-write access, write a note through the sync protocol.

For clients that accept a bearer token instead of OAuth, issue an `mcp-read` or `mcp-write` token
and use `<your Worker URL>/vault/<vault ID>/mcp`.

### Design decisions

Microlith is **plaintext, self-hosted only**. There is no end-to-end encryption mode and no managed
service. The reasoning: plaintext is what lets the MCP server read your notes, and hosting it in
your own Cloudflare account is what makes plaintext defensible. That trade is the opposite of the
one Self-hosted LiveSync and Remotely Save make, and it is deliberate.

Compared to Obsidian Sync:

| | Obsidian Sync | Microlith |
|---|---|---|
| Conflicts | merge by default, or conflict file | conflict file only (merge planned) |
| Version history | notes 1 month, attachments 2 weeks | not yet, planned |
| Deleted file recovery | yes | yes, 30 days |
| Images / audio / video / PDF | excluded by default | same |
| Max file size | 5 MB / 200 MB by plan | 100 MB |
| Vault config (`.obsidian`) | synced | not yet |

### Layout

```
wrangler.jsonc         Worker config (kept at the repo root for Deploy button compatibility)
packages/core          stone core — Worker + Durable Object
packages/blade         blade — the Obsidian plugin
packages/haft          handle — shared MCP tool schemas and the revision hash
```

### Development

```
npm install
npm run dev
npm run typecheck
npm run smoke          # sync API, requires `npm run dev` in another terminal
npm run test:mcp       # MCP endpoint against a running dev server
npm run test:oauth     # OAuth flow against a running dev server
npm run test:blade     # sync engine against a running dev server
npm run test:registry  # vault registry migration, runs standalone
npm run build:blade    # builds packages/blade/main.js for Obsidian
```

Releasing the plugin is a tag push. The tag must equal the version in
`packages/blade/manifest.json`, with no `v` prefix, because that is how Obsidian and BRAT
find the release; CI refuses the tag otherwise.

```bash
git tag 0.1.0 && git push origin 0.1.0
```

The sync engine talks to an adapter rather than to Obsidian directly, so `test:blade` drives two
simulated devices against a real server without launching Obsidian.

### License

Not chosen yet.

---

## 日本語

細石刃（microlith）は、小さな石刃を柄に植え込んで一つの道具にする複合具です。
小さなノートを各デバイスという柄に植えて一つの Vault にする、というメタファーから
名前を取っています。

### 状態

Microlith v0.1 はベータ版です。同期 API、Obsidian プラグイン、セットアップ UI、
OAuth で保護された Remote MCP サーバーは実装済みで、一連の動作をテストしています。
デスクトップでの同期と、デプロイ済み Worker に対する Claude コネクタの接続も確認済みです。

Obsidian モバイル版での動作、大規模 Vault の初回同期、最初の BRAT 公開リリースは、
引き続き実環境での検証が必要です。

### デプロイ前の注意

- **R2 は無料枠内の利用でも支払い方法の登録が必要です。** バケットのプロビジョニング時に、
  Cloudflare から登録を求められます。
- 単一ユーザーの Vault は Workers の **Free** プランに収まります。Workers Paid プランは不要です。
- セットアップ画面を保護する `ADMIN_SECRET` の入力を求められます。
  `openssl rand -hex 32` で生成してください。

### セットアップ

デプロイ後に Worker の URL を開き、設定した `ADMIN_SECRET` を入力して Vault 名を選びます。
各 Obsidian 端末に対して `sync` トークンを発行してください。セットアップ画面では Vault の状態確認、
端末や接続済みアプリの失効、過去30日以内に削除されたファイルの復元もできます。

トークンのスコープは3種類です。Obsidian プラグイン用の `sync` と、Bearer トークンを受け付ける
MCP クライアント用の `mcp-read` / `mcp-write` があります。サーバーが保存するのはハッシュだけなので、
トークンが表示されるのは発行時の一度だけです。紛失した場合は失効させて再発行してください。

### Obsidian プラグイン

コミュニティプラグインへ申請するまでは、ベータ版として
[BRAT](https://github.com/TfTHacker/obsidian42-brat) で配布します。BRAT をインストールし、
ベータプラグインとして `kbkn3/microlith` を追加してください。

手動でインストールする場合は、リリースに添付された `manifest.json` と `main.js` を
`<Vault>/.obsidian/plugins/microlith/` に配置します。

いずれの場合も、プラグイン設定でサーバー URL、Vault 名、セットアップ画面から発行した
デバイストークンを入力してください。

### Claude との接続

カスタムコネクタとして `<Worker URL>/mcp` を追加します。OAuth の同意画面では、
`ADMIN_SECRET`、公開する Vault、読み取り専用または読み書き可能のアクセス権を指定します。
各認可は一つの Vault に紐づき、セットアップ画面から失効できます。

MCP サーバーは、フォルダ、見出し、リンク、タグ、グラフ上の関係を参照できます。
ノート全体または指定した節の読み取り、本文検索、読み書き権限がある場合は同期プロトコルを
経由したノートの書き込みもできます。

OAuth の代わりに Bearer トークンを受け付けるクライアントでは、`mcp-read` または
`mcp-write` トークンを発行し、`<Worker URL>/vault/<Vault ID>/mcp` を使用してください。

### 設計方針

Microlith は**平文・セルフホスト専用**です。E2E 暗号化モードやマネージドサービスはありません。
平文だからこそ MCP サーバーがノートを読み取ることができ、自分の Cloudflare アカウント内で
ホストするからこそ、その平文運用を正当化できます。Self-hosted LiveSync や Remotely Save とは
意図的に異なるトレードオフを選んでいます。

Obsidian Sync との比較：

| | Obsidian Sync | Microlith |
|---|---|---|
| 競合 | 既定ではマージ、または競合ファイル | 競合ファイルのみ（マージは予定） |
| バージョン履歴 | ノート1か月、添付2週間 | 未実装、対応予定 |
| 削除ファイルの復元 | 対応 | 対応、30日間 |
| 画像・音声・動画・PDF | 既定で除外 | 同じ |
| ファイルサイズ上限 | プランにより 5 MB / 200 MB | 100 MB |
| Vault 設定（`.obsidian`） | 同期対象 | 未対応 |

### 構成

```
wrangler.jsonc         Worker 設定（Deploy ボタンとの互換性のためリポジトリルートに配置）
packages/core          石核 — Worker + Durable Object
packages/blade         刃 — Obsidian プラグイン
packages/haft          柄 — MCP ツールスキーマと revision hash の共通定義
```

### 開発

```
npm install
npm run dev
npm run typecheck
npm run smoke          # 同期 API。別のターミナルで `npm run dev` が必要
npm run test:mcp       # 起動中の開発サーバーに対する MCP エンドポイントのテスト
npm run test:oauth     # 起動中の開発サーバーに対する OAuth フローのテスト
npm run test:blade     # 起動中の開発サーバーに対する同期エンジンのテスト
npm run test:registry  # Vault レジストリ移行の単体テスト
npm run build:blade    # Obsidian 用の packages/blade/main.js を生成
```

プラグインのリリースはタグの push で行います。タグは `packages/blade/manifest.json` の
バージョンと一致させ、`v` 接頭辞は付けません。Obsidian と BRAT はこの形式でリリースを検索し、
一致しない場合は CI がリリースを中止します。

```bash
git tag 0.1.0 && git push origin 0.1.0
```

同期エンジンは Obsidian 本体ではなくアダプターを介して動作します。そのため `test:blade` は
Obsidian を起動せず、実際のサーバーに対して2台の模擬端末を動かします。

### ライセンス

未選択です。
