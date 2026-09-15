# Version History and Automatic Merge Design

- Target release: `0.1.1`
- Date: 2026-09-15
- Status: awaiting written-spec approval

## Problem and value

Microlith currently treats a revision mismatch as a conflict and preserves both sides by creating a conflict copy. This prevents silent loss, but forces manual cleanup even when local and remote edits do not overlap. It also retains deleted content for recovery without exposing ordinary version history.

The `0.1.1` change adds a 30-day history owned by each vault and automatically resolves only conflict-free three-way merges. Data preservation remains more important than reducing conflict copies.

## Scope

Included:

- 30-day note and attachment version metadata retention
- note bodies in Durable Object SQLite and attachment revisions in existing R2 objects
- history browsing and restoration from `/setup`
- automatic line-based note merging with `node-diff3`, enabled by default per device
- compatibility with older clients and servers

Excluded:

- `.obsidian` synchronization
- configurable retention
- history diff display
- a manual conflict editor
- semantic Markdown merging
- attachment merging
- claims of real-device mobile verification

## Requirements

| ID | Requirement |
| --- | --- |
| R1 | `VaultDO` remains the sole authority for current vault state and retained history. |
| R2 | Accepted note and attachment revisions are retained for 30 days. |
| R3 | Repeated acceptance of the same path and revision creates no duplicate history entry. |
| R4 | Existing current and retained-deleted content is backfilled without destructive conversion. |
| R5 | A note conflict includes the retained base body when available. |
| R6 | The plugin retries once only when `node-diff3` reports a conflict-free merge. |
| R7 | Any unsafe or incomplete merge path uses the existing conflict-copy behavior. |
| R8 | A merged push uses an index derived from that exact merged body. |
| R9 | Historical content browsing and revision-specific restoration require administrator scope. |
| R10 | The feature remains interoperable when either client or server has not yet been upgraded. |

## Quality scenarios

| ID | Scenario | Required response |
| --- | --- | --- |
| Q1 | Two devices edit different lines from the same retained base. | Merge locally and accept one retry without a conflict copy. |
| Q2 | Two devices edit the same line, the base is unavailable, or deletion races with editing. | Preserve local content in a conflict copy and make the original reflect remote state. |
| Q3 | A non-administrator requests history browsing or revision-specific restoration. | Reject the request without returning a historical body. |
| Q4 | An existing vault starts on the new server. | Create the history schema and backfill current recoverable content idempotently. |
| Q5 | A selected history row is corrupt or its R2 object is unavailable. | Fail the restore without changing current state. |
| Q6 | A current revision is older than the retention window. | Keep current state authoritative while allowing its history row to expire. |

Release stops on any observed data loss, current/history inconsistency, unauthorized historical-body access, or migration failure.

## Considered approaches

1. Keep conflict copies only. This has the smallest implementation but does not meet the automatic-merge goal.
2. Merge on the server. This centralizes behavior but makes the server decide over client-local text and complicates retry and index ownership.
3. Retain bases on the server and merge in the plugin. This keeps `VaultDO` authoritative for shared history while the plugin owns local content and conflict-file creation.

Approach 3 is selected. `node-diff3` supplies the three-way merge; Microlith adds only the surrounding safety and retry rules.

## Target architecture and authority

`VaultDO` remains the unique source of truth for current file metadata, note bodies, deletion state, and retained version records. Existing R2 objects remain the authority for attachment bytes. The plugin owns the unsynchronized local body and computes a three-way merge from:

- base: the server-retained body named by the client's `baseRev`
- local: the body currently being pushed
- remote: the current server body returned with the conflict

The server stores and retrieves versions but never merges content. The plugin never treats its local history as shared history.

## Storage

The existing idempotent schema initialization adds:

```sql
CREATE TABLE IF NOT EXISTS versions (
  path TEXT NOT NULL,
  rev TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (path, rev)
);

CREATE INDEX IF NOT EXISTS versions_by_created_at
  ON versions (created_at);
```

For notes, `body` contains the accepted text. For attachments, `body` is `NULL` and `rev` identifies the already-stored `assets/<rev>` R2 object. History metadata expiration does not add R2 garbage collection in `0.1.1`.

On startup, `INSERT OR IGNORE ... SELECT` backfills current files and retained deleted files whose content is still available. No migration framework or schema-version table is introduced. Re-running initialization is safe.

On every successful non-delete push, the accepted revision is inserted into `versions`. The `(path, rev)` key deliberately represents content revisions, not repeated transitions. A deletion does not create a tombstone version because the previous accepted content is already retained.

The current-state write and corresponding history insert execute in the same Durable Object storage transaction boundary, with no intervening external `await`. History purge reuses the existing daily purge trigger and removes rows older than 30 days. Expiring a history row never removes current state.

## HTTP contracts

The normal push conflict response is extended compatibly:

```json
{
  "status": "conflict",
  "rev": "current-revision",
  "body": "current remote body",
  "baseBody": "retained base body"
}
```

`baseBody` is omitted when the requested base is not a retained note revision. An empty base is represented as `""`, not omission. Older clients ignore the additional field.

Administrator-only history routes are added:

- `GET /vault/:vaultId/versions?path=...` returns metadata without bodies.
- `GET /vault/:vaultId/version?path=...&rev=...` returns one retained version. Note bodies are returned only here; attachment content continues to use the existing asset path.
- `POST /vault/:vaultId/restore?path=...&rev=...` restores a retained revision as a new current revision.

The existing restore request without `rev` preserves its deleted-file recovery behavior and write-scope compatibility. Supplying `rev` requires administrator scope. A missing or expired version returns `404`. Corrupt note history or a missing R2 object returns an error before current state changes.

## Automatic merge flow

Automatic merge is a per-device setting and defaults to enabled.

For a note push conflict:

1. If `baseBody` is present, pass local, base, and remote line sequences to `node-diff3` with false-conflict elimination enabled.
2. If every merge region is conflict-free, reconstruct the exact merged string while preserving line endings and trailing-newline behavior.
3. Write the merged body locally and wait for Obsidian to provide metadata corresponding to that exact body.
4. Retry once using the remote revision as `baseRev` and the merged body's index.
5. Accept success. A second conflict is not merged recursively.

The implementation plan must verify the appropriate Obsidian API mechanism for step 3. A stale index must never be sent for merged content.

The fallback path runs when merging is disabled, `baseBody` is absent, `node-diff3` reports a conflict, index refresh cannot be confirmed, either side represents deletion, or the retry conflicts or fails. It preserves the original local body in a conflict copy and makes the original path reflect the remote state. For delete-versus-edit, that means deleting the original after the conflict copy is safely written.

Attachments retain the existing remote-wins/conflict-copy behavior and are never passed to `node-diff3`.

## Setup interface

`/setup` gains a Version history panel using the existing setup authentication and visual patterns:

- path input
- newest-first metadata list showing date/time and size
- selected note preview; attachments show metadata only
- explicit confirmation before restoration

Restoration makes the selected content current through the normal vault write rules and advances the current sequence. Because revisions are content-addressed, its `rev` can equal the selected historical revision; the existing history row is not duplicated or reordered. It does not rewind counters or mutate old history rows.

## Transition, compatibility, and recovery

Client and server deployment order is independent:

- new server + old client: the old client ignores `baseBody` and keeps conflict-copy behavior
- new client + old server: absent `baseBody` triggers conflict-copy behavior
- feature disabled: conflict-copy behavior remains available

Server startup performs idempotent schema creation and backfill. No eager R2 copy or full-vault rewrite is required. Rolling back the application leaves an unused `versions` table that older code ignores. If validation finds inconsistent history, deployment is aborted; current `files`, `notes`, and R2 data remain authoritative and must not be repaired from history automatically.

Temporary compatibility fields and fallback branches are owned by the sync/history implementation. They remain until the minimum supported server and plugin versions both include the `0.1.1` contract; removal is a separate compatibility decision, not part of this release.

## Validation trace

| Check | Covers |
| --- | --- |
| Schema initialization, backfill, deduplication, and 30-day purge tests | R1-R4, Q4, Q6 |
| Note and attachment version retrieval/restoration tests | R2, R9, Q3, Q5 |
| Non-overlapping, identical, Japanese-text, and trailing-newline merge tests | R5-R8, Q1 |
| Same-line, missing-base, delete-versus-edit, re-conflict, and index-refresh fallback tests | R7-R8, Q2 |
| Old-client/new-server and new-client/old-server contract tests | R10 |
| Worker HTTP tests with authorization checks | R5, R9-R10, Q3 |
| Plugin build plus repository `npm run check` | integration readiness |

Mobile validation is limited to build compatibility in this release; no real-device behavior claim is made.

## Architecture decision

- Decision: retain 30-day versions in `VaultDO` and perform conservative three-way note merging in the plugin with `node-diff3`.
- Decision owner: project owner.
- Approval evidence: design sections approved in the task conversation on 2026-09-15.
- Subject verdict: coherent; authority, failure behavior, compatibility, transition, and recovery are defined.
- Engineering status: not started.
- Release status: not ready; implementation and validation remain.
- Next gate: approval of this written specification before producing the implementation plan.
