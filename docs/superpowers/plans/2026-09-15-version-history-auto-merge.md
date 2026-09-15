# Version History and Automatic Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 30-day vault version history, administrator restore UI, and safe default-on three-way note merging for release `0.1.1`.

**Architecture:** `VaultDO` remains authoritative for current state and retained versions; attachment bytes continue to live under their content-addressed R2 keys. The plugin uses `node-diff3` locally and retries once only after Obsidian produces metadata for the exact merged body, otherwise it preserves the local body as a conflict copy.

**Tech Stack:** TypeScript, Hono, Cloudflare Durable Objects SQLite, R2, Obsidian API 1.13.1, `node-diff3` 3.2.1, Vite Plus tests, Node `assert` and `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-15-version-history-auto-merge-design.md`

## Global Constraints

- Target release is exactly `0.1.1`.
- Retention is fixed at 30 days for notes and attachment version metadata; do not add configuration.
- Automatic note merge is a per-device setting and defaults to enabled.
- Only conflict-free line merges may retry, and retry happens at most once.
- Never push an index produced for a body other than the merged body.
- History browsing and revision-specific restore require `ADMIN_SECRET`; existing deleted-file restore keeps its current write-token contract.
- Preserve old-client/new-server and new-client/old-server behavior by making `baseBody` optional.
- Do not add `.obsidian` sync, semantic Markdown merge, attachment merge, history diff UI, manual conflict editor, or R2 garbage collection.
- Follow existing names and file organization; do not introduce abbreviated identifiers.
- Do not modify or stage `docs/project-overview.ja.md`.

## File map

- `packages/core/src/schema.ts`: version table plus reusable backfill and purge SQL.
- `packages/core/src/vault.ts`: version capture/query/restore and conflict base lookup.
- `packages/core/src/index.ts`: administrator history HTTP contracts and asset restore preflight.
- `packages/core/test/history.test.mjs`: deterministic SQLite tests for migration, deduplication, and retention.
- `packages/core/test/smoke.test.mjs`: live Worker tests for authorization and note/asset restore.
- `packages/blade/src/merge.ts`: the only wrapper around `node-diff3`.
- `packages/blade/src/client.ts`: optional conflict `baseBody` type.
- `packages/blade/src/sync.ts`: one-retry merge and lossless fallback flow.
- `packages/blade/src/main.ts`: default-on setting and exact-body metadata wait.
- `packages/blade/test/merge.test.mjs`: line-ending and conflict behavior of the pure merge wrapper.
- `packages/blade/test/conflict.test.mjs`: fake-client checks for retry, fallback, deletion, and index consistency.
- `packages/blade/test/sync.test.mjs`: live two-device compatibility and merge behavior.
- `packages/core/public/index.html`: history list, preview, confirmation, and restore controls.
- `package.json`, `package-lock.json`, `packages/*/package.json`, `packages/blade/manifest.json`, `packages/core/src/mcp.ts`, `README.md`: test scripts, dependency lock, version, and released-feature documentation.

---

### Task 1: Durable Object version storage

**Files:**
- Modify: `packages/core/src/schema.ts`
- Modify: `packages/core/src/vault.ts`
- Create: `packages/core/test/history.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `HISTORY_RETENTION_MS`, `BACKFILL_VERSIONS_SQL`, and `PURGE_VERSIONS_SQL` from `schema.ts`.
- Produces: `VersionMetadata`, `VersionRecord`, `VaultDO.versions(path)`, and `VaultDO.version(path, rev)`.
- Preserves: `VaultDO.push(input): Promise<PushResult>` and all current-state tables as the authority.

- [ ] **Step 1: Write the failing SQLite history test**

Create `packages/core/test/history.test.mjs`. Use `DatabaseSync(":memory:")`, execute `SCHEMA`, seed one current note, one retained deleted note, and one asset, then execute the exported backfill statement. Assert that a second backfill does not change the three-row count, note bodies are present, asset body is `NULL`, and executing the purge statement with a cutoff removes only an older non-current history row.

```js
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { BACKFILL_VERSIONS_SQL, PURGE_VERSIONS_SQL, SCHEMA } from "../src/schema.ts";

test("version history backfill is idempotent and purge keeps current state", () => {
  const database = new DatabaseSync(":memory:");
  for (const statement of SCHEMA) database.exec(statement);
  database.exec(`
    INSERT INTO notes(id, path, body) VALUES
      (1, 'current.md', 'current'),
      (2, 'deleted.md', 'deleted');
    INSERT INTO files(path, seq, rev, kind, size, mtime, deleted, deleted_at, updated_at) VALUES
      ('current.md', 1, 'note-current', 'note', 7, 100, 0, NULL, 1000),
      ('deleted.md', 2, 'note-deleted', 'note', 7, 200, 1, 1900, 1900),
      ('image.png', 3, 'asset-current', 'asset', 4, 300, 0, NULL, 2000);
  `);
  database.prepare(BACKFILL_VERSIONS_SQL).run(1500);
  database.prepare(BACKFILL_VERSIONS_SQL).run(1500);
  assert.equal(database.prepare("SELECT count(*) AS count FROM versions").get().count, 3);
  assert.equal(database.prepare("SELECT body FROM versions WHERE rev = 'note-current'").get().body, "current");
  assert.equal(database.prepare("SELECT body FROM versions WHERE rev = 'asset-current'").get().body, null);
  database.prepare(PURGE_VERSIONS_SQL).run(1500);
  assert.equal(database.prepare("SELECT count(*) AS count FROM versions").get().count, 2);
  assert.equal(database.prepare("SELECT count(*) AS count FROM files").get().count, 3);
});
```

- [ ] **Step 2: Run the new test and confirm the missing exports fail**

Run: `npx vp test packages/core/test/history.test.mjs`

Expected: FAIL because the history SQL exports and `versions` table do not exist.

- [ ] **Step 3: Add the minimal schema and idempotent migration SQL**

Add the approved `versions` table and `versions_by_created_at` index to `SCHEMA`. Export parameterized SQL constants so constructor migration and the deterministic test execute the same statements.

```ts
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const BACKFILL_VERSIONS_SQL = `INSERT OR IGNORE INTO versions
  (path, rev, kind, body, size, mtime, seq, created_at)
  SELECT f.path, f.rev, f.kind, n.body, f.size, f.mtime, f.seq, f.updated_at
  FROM files f LEFT JOIN notes n ON n.path = f.path
  WHERE (f.deleted = 0 OR f.deleted_at >= ?)
    AND (f.kind = 'asset' OR n.body IS NOT NULL)`;
export const PURGE_VERSIONS_SQL = "DELETE FROM versions WHERE created_at < ?";
```

After the existing schema loop in both the constructor and `destroy()`, execute backfill with `Date.now() - HISTORY_RETENTION_MS`. Import this constant in `vault.ts` and replace the existing duplicate `TOMBSTONE_RETENTION_MS`; both retention policies are intentionally the same fixed 30 days.

- [ ] **Step 4: Capture accepted revisions atomically and expose reads**

In `VaultDO.push`, finish hashing and conflict checks before entering `this.ctx.storage.transactionSync`. Put sequence update, `files` mutation, note/index mutation, and the following insert inside that transaction. Do not insert deletion tombstones.

```ts
this.sql.exec(
  `INSERT OR IGNORE INTO versions(path, rev, kind, body, size, mtime, seq, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  input.path,
  rev,
  input.kind,
  input.kind === "note" ? input.body ?? "" : null,
  input.size ?? input.body?.length ?? 0,
  input.mtime,
  seq,
  now,
);
```

Add newest-first metadata and single-record reads with exact signatures:

```ts
export type VersionMetadata = {
  path: string;
  rev: string;
  kind: "note" | "asset";
  size: number;
  mtime: number;
  seq: number;
  created_at: number;
};
export type VersionRecord = VersionMetadata & { body: string | null };

async versions(path: string): Promise<VersionMetadata[]>;
async version(path: string, rev: string): Promise<VersionRecord | null>;
```

Change `purgeIfDue` so `PURGE_VERSIONS_SQL` always runs when the daily purge is due, even when no tombstones expired. Current `files` and `notes` must never be deleted by the version purge.

- [ ] **Step 5: Run deterministic storage tests**

Run: `npx vp test packages/core/test/history.test.mjs`

Expected: PASS for backfill, same `(path, rev)` deduplication, note/asset representation, and 30-day cutoff while current-state rows remain.

- [ ] **Step 6: Add the standalone test to the normal check**

Change the root script to:

```json
"test": "vp test packages/core/test/registry.test.mjs packages/core/test/history.test.mjs"
```

Run: `npm test`

Expected: both standalone test files PASS.

- [ ] **Step 7: Commit the storage unit**

```bash
git add package.json packages/core/src/schema.ts packages/core/src/vault.ts packages/core/test/history.test.mjs
git commit -m "Add retained vault version storage"
```

### Task 2: Conflict base and administrator history API

**Files:**
- Modify: `packages/core/src/vault.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/smoke.test.mjs`

**Interfaces:**
- Consumes: `VaultDO.version(path, rev)` and `VaultDO.versions(path)` from Task 1.
- Produces: conflict `{ status: "conflict"; rev: string; body: string | null; baseBody?: string }`.
- Produces: `VaultDO.restoreVersion(path, rev): Promise<PushResult | null>`.
- Produces: `GET versions`, `GET version`, and revision-aware `POST restore` routes.

- [ ] **Step 1: Extend the live test with failing conflict and history assertions**

In `packages/core/test/smoke.test.mjs`, preserve `first.body.rev`, create a later note revision, then push with the first revision as `baseRev`. Assert the `409` response contains the first body as `baseBody`. Add assertions that:

```js
assert.equal((await call("versions", { token: device, query: "?path=note.md" })).status, 401);
const history = await call("versions", { token: admin, query: "?path=note.md" });
assert.equal(history.status, 200);
assert.ok(history.body.versions.length >= 2);
const selected = await call("version", {
  token: admin,
  query: `?path=note.md&rev=${first.body.rev}`,
});
assert.equal(selected.body.body, note);
```

Also upload two different attachment bodies, restore the first revision with the administrator token, and assert `GET file` returns the first bytes. Assert revision-specific restore is `403` for an authenticated device token, unknown revisions are `404`, and the existing no-`rev` deleted restore still accepts the write token.

- [ ] **Step 2: Run the live test and confirm the routes fail**

Terminal A: `npm run dev`

Terminal B: `npm run smoke`

Expected: FAIL on absent `baseBody` or the first missing history route.

- [ ] **Step 3: Return a retained base only on note conflicts**

Extend `PushResult` with optional `baseBody`. On a note conflict, look up exactly `(input.path, input.baseRev)` and spread `baseBody` only when its stored body is non-null. Preserve omission for an unknown base, an asset, or `baseRev: null`; preserve `""` for an empty note.

```ts
const base =
  input.kind === "note" && input.baseRev ? await this.version(input.path, input.baseRev) : null;
return {
  status: "conflict",
  rev: current?.rev ?? "",
  body: note?.body ?? null,
  ...(base?.body === null || base?.body === undefined ? {} : { baseBody: base.body }),
};
```

- [ ] **Step 4: Add version restoration without weakening deleted restore**

Implement `restoreVersion(path, rev)` by reading the retained row, reading the current head, and calling `push` with the current active revision as `baseRev`, the retained body or asset revision, retained size, and `mtime: Date.now()`. Return `null` when the history row is absent or a note body is null.

In `index.ts` add administrator-only list/read routes with required `path` and `rev` validation. For revision-specific asset restore, call `ASSETS.head("assets/<rev>")` before `restoreVersion`; return `404 { error: "object missing" }` without touching the Durable Object when absent. Keep `requireDevice, requireWrite` on the existing restore route and, when `rev` is supplied, require `c.get("device").scope === "admin"`; only `ADMIN_SECRET` produces that authenticated device scope.

- [ ] **Step 5: Run the server contract test**

Run: `npm run smoke`

Expected: PASS, including base-body compatibility, history authorization, note restore, asset restore, missing version/object safety, and legacy deleted restore.

- [ ] **Step 6: Commit the server contract**

```bash
git add packages/core/src/vault.ts packages/core/src/index.ts packages/core/test/smoke.test.mjs
git commit -m "Expose protected vault history"
```

### Task 3: Pure three-way note merge

**Files:**
- Modify: `packages/blade/package.json`
- Modify: `package-lock.json`
- Create: `packages/blade/src/merge.ts`
- Create: `packages/blade/test/merge.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `mergeNote(localBody: string, baseBody: string, remoteBody: string): string | null`.
- Meaning: a string is conflict-free merged text; `null` means the caller must use conflict-copy fallback.

- [ ] **Step 1: Install the selected dependency**

Run: `npm install node-diff3@3.2.1 --workspace @microlith/blade`

Expected: only `packages/blade/package.json` and `package-lock.json` gain the direct dependency and lock entries.

- [ ] **Step 2: Write failing merge cases**

Create `packages/blade/test/merge.test.mjs` with `node:assert/strict`. Cover non-overlapping lines, identical edits, Japanese text, no trailing newline, CRLF preservation, and same-line conflict.

```js
assert.equal(mergeNote("一\nB\n", "A\nB\n", "A\n二\n"), "一\n二\n");
assert.equal(mergeNote("同じ", "元", "同じ"), "同じ");
assert.equal(mergeNote("左\r\nB\r\n", "A\r\nB\r\n", "A\r\n右\r\n"), "左\r\n右\r\n");
assert.equal(mergeNote("左\n", "元\n", "右\n"), null);
```

- [ ] **Step 3: Run the merge test and confirm the missing module fails**

Run: `npx vp test packages/blade/test/merge.test.mjs`

Expected: FAIL because `src/merge.ts` does not exist.

- [ ] **Step 4: Implement the smallest wrapper around `node-diff3`**

Split each string into line chunks that retain `\n` or `\r\n`, call `diff3Merge(local, base, remote, { excludeFalseConflicts: true })`, return `null` if any region contains `conflict`, otherwise concatenate every `ok` chunk. Keep all library-specific shapes in this file.

```ts
import { diff3Merge } from "node-diff3";

const lines = (body: string): string[] => body.match(/[^\r\n]*(?:\r\n|\n)|[^\r\n]+$/g) ?? [];

export function mergeNote(localBody: string, baseBody: string, remoteBody: string): string | null {
  const regions = diff3Merge(lines(localBody), lines(baseBody), lines(remoteBody), {
    excludeFalseConflicts: true,
  });
  if (regions.some((region) => "conflict" in region)) return null;
  return regions.flatMap((region) => ("ok" in region ? region.ok : [])).join("");
}
```

- [ ] **Step 5: Run and register the pure merge test**

Run: `npx vp test packages/blade/test/merge.test.mjs`

Expected: PASS for all line-ending and conflict cases.

Add the file to the root `test` script beside the two core standalone tests, then run `npm test` and expect all three files to PASS.

- [ ] **Step 6: Commit the merge primitive**

```bash
git add package.json package-lock.json packages/blade/package.json packages/blade/src/merge.ts packages/blade/test/merge.test.mjs
git commit -m "Add conservative note merge"
```

### Task 4: Sync retry and lossless fallback

**Files:**
- Modify: `packages/blade/src/client.ts`
- Modify: `packages/blade/src/sync.ts`
- Create: `packages/blade/test/conflict.test.mjs`
- Modify: `packages/blade/test/sync.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `mergeNote` from Task 3 and optional `PushOutcome.baseBody` from Task 2.
- Produces: `VaultAdapter.writeAndWaitForIndex(path, body): Promise<NoteIndex | null>`.
- Produces: `SyncOptions.automaticMerge?: boolean`, interpreted as enabled unless exactly `false`.

- [ ] **Step 1: Write failing fake-client safety tests**

Create `packages/blade/test/conflict.test.mjs` with a fake `MicrolithClient`, `VaultAdapter`, and `StateStore`. Assert these exact outcomes:

- non-overlapping conflict performs one retry with `baseRev === remote.rev`, merged body, and the index returned by `writeAndWaitForIndex`
- same-line conflict, absent `baseBody`, `automaticMerge: false`, and `writeAndWaitForIndex` returning `null` create a conflict copy and do not retry merged content
- a retry returning conflict falls back once and does not recursively merge
- delete-versus-edit writes the conflict copy before removing the original
- fallback retains the original local body, not a partially merged body

Record fake-vault operations in an array and assert ordering:

```js
assert.deepEqual(operations.slice(-2), ["write conflict copy", "remove original"]);
assert.equal(retries[0].index.marker, "merged-body-index");
assert.equal(retries.length, 1);
```

- [ ] **Step 2: Run the safety test and confirm missing contracts fail**

Run: `npx vp test packages/blade/test/conflict.test.mjs`

Expected: FAIL because `baseBody`, `automaticMerge`, and `writeAndWaitForIndex` are not implemented.

- [ ] **Step 3: Extend the client and adapter types compatibly**

Change only the conflict arm of `PushOutcome`:

```ts
| { status: "conflict"; rev: string; body: string | null; baseBody?: string };
```

Add `writeAndWaitForIndex` to `VaultAdapter` and `automaticMerge?: boolean` to `SyncOptions`. Test adapters may write immediately and return their fixed index.

- [ ] **Step 4: Implement the one-retry merge path**

In `resolveNoteConflict`, attempt merge only when `automaticMerge !== false`, remote `body !== null`, and `baseBody !== undefined`. If `mergeNote` succeeds, call `writeAndWaitForIndex`, then retry exactly once with remote `rev`, a fresh `mtime`, merged body, and the returned index. On success, update state and return.

Wrap the retry in `try/catch`; conflict, thrown request, or missing exact-body index all continue into the existing fallback. The fallback must first create and push the conflict copy, then write the remote body or remove the original, then update state. This ordering preserves local content if later operations fail.

For pull divergence, call `pushPath(change.path)` so the server supplies the retained base through the same conflict contract. Do this for both note edits and delete-versus-edit; do not implement a second merge algorithm in `pull`.

- [ ] **Step 5: Run safety and live compatibility tests**

Run: `npx vp test packages/blade/test/conflict.test.mjs`

Expected: PASS for merge, stale/missing index, re-conflict, and deletion ordering.

With `npm run dev` still running, extend `packages/blade/test/sync.test.mjs` so different-line edits merge without a copy and same-line edits still create one. Run: `npm run test:blade`

Expected: PASS against the real server.

- [ ] **Step 6: Register and commit the sync unit**

Add `packages/blade/test/conflict.test.mjs` to the root `test` script. Run `npm test`, expecting all standalone tests to PASS.

```bash
git add package.json packages/blade/src/client.ts packages/blade/src/sync.ts packages/blade/test/conflict.test.mjs packages/blade/test/sync.test.mjs
git commit -m "Merge non-overlapping sync conflicts"
```

### Task 5: Obsidian exact-body index and default-on setting

**Files:**
- Modify: `packages/blade/src/main.ts`

**Interfaces:**
- Implements: `VaultAdapter.writeAndWaitForIndex(path, body)` using `metadataCache.on("changed")`.
- Supplies: `automaticMerge: configuration.automaticMerge` to `SyncEngine`.

- [ ] **Step 1: Add the persisted setting with a safe old-install default**

Add `automaticMerge: boolean` to `Configuration` and `automaticMerge: true` to `DEFAULT_CONFIGURATION`. Existing stored data receives `true` through the current default spread. Pass it to `SyncEngine` and add an “Automatically merge notes” toggle that explains only non-overlapping edits are merged.

```ts
new Setting(containerEl)
  .setName("Automatically merge notes")
  .setDesc("Merge non-overlapping edits. Other conflicts are kept as conflict copies.")
  .addToggle((toggle) =>
    toggle
      .setValue(configuration.automaticMerge)
      .onChange((value) => void this.plugin.updateConfiguration({ automaticMerge: value })),
  );
```

- [ ] **Step 2: Implement exact-body metadata waiting**

Factor the existing `CachedMetadata` to `NoteIndex` conversion into one local helper used by both `indexOf` and the new method. In `writeAndWaitForIndex`, subscribe before writing, accept only a `changed` event whose `file.path` and `data` exactly match the requested values, and unregister on success, write failure, or a 5-second timeout. Return `null` on timeout so `SyncEngine` takes the safe fallback.

```ts
const reference = metadataCache.on("changed", (changedFile, data, cache) => {
  if (changedFile.path === path && data === body) finish(toNoteIndex(path, cache));
});
const timeout = window.setTimeout(() => finish(null), 5_000);
```

Use `metadataCache.offref(reference)` and `window.clearTimeout(timeout)` in the single cleanup function. Do not use a cached index immediately after `vault.modify`.

- [ ] **Step 3: Type-check and build the plugin**

Run: `npm run typecheck`

Expected: PASS, including Obsidian event and `node-diff3` types.

Run: `npm run build:blade`

Expected: PASS and the generated plugin bundle contains no unresolved `node-diff3` import.

- [ ] **Step 4: Re-run sync safety tests**

Run: `npm test`

Expected: PASS; the fake adapter proves the index passed to retry belongs to the merged body.

- [ ] **Step 5: Commit the Obsidian integration**

```bash
git add packages/blade/src/main.ts
git commit -m "Wait for merged note metadata"
```

### Task 6: Setup version-history panel

**Files:**
- Modify: `packages/core/public/index.html`
- Modify: `packages/core/test/smoke.test.mjs`

**Interfaces:**
- Consumes: administrator `versions`, `version`, and revision-aware `restore` routes from Task 2.
- Produces: path search, newest-first list, note preview, attachment metadata, and confirmed restore in `/setup`.

- [ ] **Step 1: Add a failing setup-markup assertion**

In the live smoke test, fetch `/setup` and assert the HTML contains `id="history-panel"`, `id="history-path"`, and `id="history-preview"`. Keep API behavior assertions from Task 2 as the functional coverage.

- [ ] **Step 2: Run smoke and confirm the panel assertion fails**

Run: `npm run smoke`

Expected: FAIL because the history panel markup is absent.

- [ ] **Step 3: Add the panel with native controls**

Add one section following the deleted-files panel pattern:

```html
<section id="history-panel" hidden>
  <h2>Version history</h2>
  <div class="fields">
    <div><label for="history-path">Path</label><input id="history-path" /></div>
    <button id="load-history">Load history</button>
  </div>
  <table><tbody id="history"></tbody></table>
  <pre id="history-preview" hidden></pre>
</section>
```

On load, call `versions` with the entered path and render date/time, byte size, Preview, and Restore controls using `textContent`. Preview calls `version` only for notes. Restore first calls `window.confirm`, then posts `restore?path=...&rev=...`, refreshes status/history, and reports success through the existing `note()` function. Attachments show metadata and Restore only.

Show the panel only after successful administrator connection and hide it on connection failure. Never insert note bodies with `innerHTML`.

- [ ] **Step 4: Run the live UI/API smoke test**

Run: `npm run smoke`

Expected: PASS for setup markup plus all protected history API behavior.

- [ ] **Step 5: Commit the setup panel**

```bash
git add packages/core/public/index.html packages/core/test/smoke.test.mjs
git commit -m "Add setup version history controls"
```

### Task 7: Release `0.1.1` consistency and full verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/blade/package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/haft/package.json`
- Modify: `packages/blade/manifest.json`
- Modify: `packages/core/src/mcp.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: one consistent `0.1.1` application/plugin version.
- Preserves: `minAppVersion: "1.5.0"` and the no-`v` tag convention.

- [ ] **Step 1: Update release metadata and user-facing capability status**

Run the npm-native workspace update so package manifests and lockfile stay consistent:

```bash
npm version 0.1.1 --workspaces --include-workspace-root --no-git-tag-version
```

Then set the plugin manifest and MCP server version to `0.1.1`. Update both English and Japanese README comparison rows so Microlith says automatic non-overlapping merge and 30-day note/attachment history are implemented. Change both release command examples to:

```bash
git tag 0.1.1 && git push origin 0.1.1
```

- [ ] **Step 2: Run the complete standalone gate**

Run: `npm run check`

Expected: formatting, lint, secret scan, TypeScript, registry/history/merge/conflict tests all PASS.

- [ ] **Step 3: Run every live Worker contract**

Terminal A: `npm run dev`

Terminal B, sequentially:

```bash
npm run smoke
npm run test:blade
npm run test:mcp
npm run test:oauth
```

Expected: every command PASS. Any data loss, current/history mismatch, unauthorized history response, or migration failure stops the release.

- [ ] **Step 4: Build the distributable plugin**

Run: `npm run build:blade`

Expected: PASS and `packages/blade/main.js` is produced. This establishes build compatibility only; do not claim real-device mobile verification.

- [ ] **Step 5: Inspect the final diff for scope and generated artifacts**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors, no `.obsidian` support or unrelated files, and `docs/project-overview.ja.md` remains untracked and unstaged. Do not commit generated `packages/blade/main.js` unless the repository already tracks it.

- [ ] **Step 6: Commit the release metadata**

```bash
git add package.json package-lock.json packages/blade/package.json packages/core/package.json packages/haft/package.json packages/blade/manifest.json packages/core/src/mcp.ts README.md
git commit -m "Prepare release 0.1.1"
```

- [ ] **Step 7: Request final code review before tagging**

Invoke `superpowers:requesting-code-review` over the complete change from `51924a5` through `HEAD`. Fix accepted findings, rerun the affected test plus `npm run check`, and leave tag creation and push for an explicit release instruction.
