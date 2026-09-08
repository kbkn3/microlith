/** §5.1 のスキーマ。DO の初回起動時に一度だけ流す。 */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS files(
     path TEXT PRIMARY KEY, seq INTEGER NOT NULL, rev TEXT NOT NULL, kind TEXT NOT NULL,
     size INTEGER NOT NULL, mtime INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
     deleted_at INTEGER, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS files_by_seq ON files(seq)`,
  `CREATE TABLE IF NOT EXISTS notes(
     id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT, body TEXT NOT NULL,
     frontmatter_json TEXT)`,
  // 日本語は unicode61 では分かち書きされないため trigram を使う。
  // 代償として2文字以下のクエリが引けず、search() 側で部分一致にフォールバックする。
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
     title, body, content='notes', content_rowid='id', tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS links(src_path TEXT, dst_path TEXT, kind TEXT)`,
  `CREATE TABLE IF NOT EXISTS tags(path TEXT, tag TEXT)`,
  `CREATE TABLE IF NOT EXISTS headings(
     path TEXT, level INTEGER, text TEXT, line INTEGER, parent_line INTEGER)`,
  `CREATE TABLE IF NOT EXISTS devices(
     id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, scope TEXT NOT NULL,
     last_seen_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, revoked_at INTEGER)`,
] as const;
