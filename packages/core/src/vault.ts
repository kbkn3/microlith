import { DurableObject } from "cloudflare:workers";
import { ALL_TOOLS } from "@microlith/haft";
import { SCHEMA } from "./schema";
import { contentHash, tokenHash } from "./rev";
import type { Env } from "./env";

const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHANGES_LIMIT = 500;

export type NoteIndex = {
  links?: { dst: string; kind: string }[];
  tags?: string[];
  headings?: { level: number; text: string; line: number; parentLine: number }[];
  frontmatter?: unknown;
};

export type PushInput = {
  path: string;
  baseRev: string | null;
  kind: "note" | "asset";
  mtime: number;
  /** note の本文。asset は R2 に置いたあとなので rev だけを渡す。 */
  body?: string;
  rev?: string;
  size?: number;
  deleted?: boolean;
  index?: NoteIndex;
};

export type PushResult =
  | { status: "ok"; seq: number; rev: string }
  | { status: "unchanged"; seq: number; rev: string }
  | { status: "conflict"; rev: string; body: string | null };

type FileRow = {
  path: string; seq: number; rev: string; kind: string;
  size: number; mtime: number; deleted: number; updated_at: number;
};

/** 石核(core) — Vault ごとに1つ。メタデータ・本文・インデックス・通知の中心。 */
export class VaultDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // hibernation から復帰するたび constructor が走るため、ここは冪等でなければならない。
    for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
    // keepalive を自前で処理すると毎回 DO が起きて hibernation が無意味になる。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  private readMeta(key: string): number {
    const [row] = [...this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)];
    return row ? Number(row.value) : 0;
  }

  private writeMeta(key: string, value: number): void {
    this.sql.exec(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, String(value)
    );
  }

  /**
   * デバイストークンのハッシュに使う salt。
   *
   * 当初は `ADMIN_SECRET` をそのまま使っていたが、それだと
   * **秘密をローテーションすると全デバイストークンが無効になる**(§25.6)。
   * Vault ごとに独立した salt を持ち、`ADMIN_SECRET` から切り離す。
   */
  private saltValue(): string {
    const [row] = [...this.sql.exec<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'token_salt'"
    )];
    if (row) return row.value;
    const salt = crypto.randomUUID().replaceAll("-", "");
    this.sql.exec("INSERT INTO meta(key, value) VALUES ('token_salt', ?)", salt);
    return salt;
  }

  // --- 認証 -----------------------------------------------------------------

  async createDevice(name: string, scope: string, token: string): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO devices(id, name, token_hash, scope, created_at) VALUES (?, ?, ?, ?, ?)`,
      id, name, await tokenHash(this.saltValue(), token), scope, Date.now()
    );
    return { id };
  }

  async authenticate(token: string): Promise<{ id: string; scope: string } | null> {
    const find = (hash: string) => [...this.sql.exec<{ id: string; scope: string }>(
      "SELECT id, scope FROM devices WHERE token_hash = ? AND revoked_at IS NULL", hash
    )][0] ?? null;

    const current = await tokenHash(this.saltValue(), token);
    const row = find(current);
    if (row) return row;

    // 旧方式(salt = ADMIN_SECRET)で作られたトークンは、初めて使われたときに
    // 新しい salt で入れ直す。利用者に再発行を強いずに移行する。
    const legacy = find(await tokenHash(this.env.ADMIN_SECRET, token));
    if (!legacy) return null;
    this.sql.exec("UPDATE devices SET token_hash = ? WHERE id = ?", current, legacy.id);
    return legacy;
  }

  async listDevices() {
    return [...this.sql.exec("SELECT id, name, scope, last_seen_seq, created_at FROM devices WHERE revoked_at IS NULL")];
  }

  async revokeDevice(id: string): Promise<void> {
    this.sql.exec("UPDATE devices SET revoked_at = ? WHERE id = ?", Date.now(), id);
  }

  // --- 同期 -----------------------------------------------------------------

  async changes(since: number, deviceId: string | null, limit = DEFAULT_CHANGES_LIMIT) {
    // purge 済みの削除を知らない端末は、消えたファイルを復活させてしまう。
    // full resync させる以外に正しく直す方法がない(§5.5)。
    if (since > 0 && since < this.readMeta("purged_before_seq")) {
      return { status: "resync-required" as const, seq: this.readMeta("seq") };
    }
    const rows = [...this.sql.exec<FileRow>(
      `SELECT path, seq, rev, kind, size, mtime, deleted FROM files
       WHERE seq > ? ORDER BY seq LIMIT ?`, since, limit + 1
    )];
    const hasMore = rows.length > limit;
    const changes = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      path: row.path, seq: row.seq, rev: row.rev, kind: row.kind,
      size: row.size, mtime: row.mtime, deleted: row.deleted === 1
    }));
    const cursor = changes.length > 0 ? changes[changes.length - 1].seq : since;
    if (deviceId && !hasMore) {
      this.sql.exec("UPDATE devices SET last_seen_seq = ? WHERE id = ?", cursor, deviceId);
    }
    return { status: "ok" as const, seq: cursor, hasMore, changes };
  }

  async readNote(path: string): Promise<{ rev: string; body: string } | null> {
    const [row] = [...this.sql.exec<{ rev: string; body: string }>(
      `SELECT f.rev AS rev, n.body AS body FROM files f
       JOIN notes n ON n.path = f.path WHERE f.path = ? AND f.deleted = 0`, path
    )];
    return row ?? null;
  }

  async head(path: string): Promise<FileRow | null> {
    const [row] = [...this.sql.exec<FileRow>("SELECT * FROM files WHERE path = ?", path)];
    return row ?? null;
  }

  async push(input: PushInput): Promise<PushResult> {
    const current = await this.head(input.path);
    const currentRev = current && current.deleted === 0 ? current.rev : null;
    // tombstone は本文を残したまま FTS からだけ外す。復元時に「存在しない項目を delete」
    // してしまうと FTS が壊れるので、載っていたかどうかをここで確定させておく(§10)。
    const wasIndexed = current !== null && current.deleted === 0;
    if (currentRev !== input.baseRev) {
      const note = current?.kind === "note" ? await this.readNote(input.path) : null;
      return { status: "conflict", rev: current?.rev ?? "", body: note?.body ?? null };
    }

    const rev = input.deleted
      ? await contentHash(`deleted:${input.path}:${Date.now()}`)
      : input.kind === "note"
        ? await contentHash(input.body ?? "")
        : input.rev!;

    // 同じ内容の書き戻しは no-op にする。これが端末間の往復を止める。
    if (current && current.rev === rev && current.deleted === (input.deleted ? 1 : 0)) {
      return { status: "unchanged", seq: current.seq, rev };
    }

    const seq = this.readMeta("seq") + 1;
    const now = Date.now();
    this.writeMeta("seq", seq);

    this.sql.exec(
      `INSERT INTO files(path, seq, rev, kind, size, mtime, deleted, deleted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         seq = excluded.seq, rev = excluded.rev, size = excluded.size, mtime = excluded.mtime,
         deleted = excluded.deleted, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`,
      input.path, seq, rev, input.kind,
      input.size ?? input.body?.length ?? 0, input.mtime,
      input.deleted ? 1 : 0, input.deleted ? now : null, now
    );

    if (input.kind === "note") {
      if (input.deleted) {
        // 本文は残す。30日以内なら復元できる(§5.5)。FTS からだけ外す。
        this.removeFromIndex(input.path, { keepBody: true });
      } else {
        this.writeNote(input.path, input.body ?? "", wasIndexed, input.index);
      }
    }

    this.broadcast(seq);
    this.purgeIfDue(now);
    return { status: "ok", seq, rev };
  }

  private writeNote(path: string, body: string, wasIndexed: boolean, index?: NoteIndex): void {
    const title = body.match(/^#\s+(.+)$/m)?.[1] ?? path.split("/").pop() ?? path;
    const [existing] = [...this.sql.exec<{ id: number; title: string | null; body: string }>(
      "SELECT id, title, body FROM notes WHERE path = ?", path
    )];

    let id: number;
    if (existing) {
      // external content の 'delete' に渡す値が実データとズレると、以降のクエリが
      // SQLITE_CORRUPT_VTAB になる。必ず「更新前の値」で消してから入れ直す(§10)。
      if (wasIndexed) {
        this.sql.exec(
          `INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', ?, ?, ?)`,
          existing.id, existing.title, existing.body
        );
      }
      this.sql.exec("UPDATE notes SET title = ?, body = ?, frontmatter_json = ? WHERE id = ?",
        title, body, JSON.stringify(index?.frontmatter ?? null), existing.id);
      id = existing.id;
    } else {
      const [row] = [...this.sql.exec<{ id: number }>(
        `INSERT INTO notes(path, title, body, frontmatter_json) VALUES (?, ?, ?, ?) RETURNING id`,
        path, title, body, JSON.stringify(index?.frontmatter ?? null)
      )];
      id = row.id;
    }
    this.sql.exec("INSERT INTO notes_fts(rowid, title, body) VALUES (?, ?, ?)", id, title, body);

    this.replaceIndex(path, index);
  }

  private replaceIndex(path: string, index?: NoteIndex): void {
    this.sql.exec("DELETE FROM links WHERE src_path = ?", path);
    this.sql.exec("DELETE FROM tags WHERE path = ?", path);
    this.sql.exec("DELETE FROM headings WHERE path = ?", path);
    for (const link of index?.links ?? []) {
      this.sql.exec("INSERT INTO links(src_path, dst_path, kind) VALUES (?, ?, ?)", path, link.dst, link.kind);
    }
    for (const tag of index?.tags ?? []) {
      this.sql.exec("INSERT INTO tags(path, tag) VALUES (?, ?)", path, tag);
    }
    for (const heading of index?.headings ?? []) {
      this.sql.exec("INSERT INTO headings(path, level, text, line, parent_line) VALUES (?, ?, ?, ?, ?)",
        path, heading.level, heading.text, heading.line, heading.parentLine);
    }
  }

  private removeFromIndex(path: string, options: { keepBody: boolean }): void {
    const [existing] = [...this.sql.exec<{ id: number; title: string | null; body: string }>(
      "SELECT id, title, body FROM notes WHERE path = ?", path
    )];
    if (existing) {
      this.sql.exec(`INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', ?, ?, ?)`,
        existing.id, existing.title, existing.body);
      if (!options.keepBody) this.sql.exec("DELETE FROM notes WHERE id = ?", existing.id);
    }
    this.replaceIndex(path, undefined);
  }

  /**
   * tombstone の物理削除。Cron Triggers から呼ぶには Vault の一覧が要り、
   * DO alarm を使うと寝ている DO を起こしてしまう。push のついでに1日1回走らせるのが一番安い。
   */
  private purgeIfDue(now: number): void {
    if (now - this.readMeta("last_purge_at") < PURGE_INTERVAL_MS) return;
    this.writeMeta("last_purge_at", now);
    const cutoff = now - TOMBSTONE_RETENTION_MS;
    const expired = [...this.sql.exec<{ path: string; seq: number }>(
      "SELECT path, seq FROM files WHERE deleted = 1 AND deleted_at < ?", cutoff
    )];
    if (expired.length === 0) return;
    for (const file of expired) {
      this.removeFromIndex(file.path, { keepBody: false });
      this.sql.exec("DELETE FROM files WHERE path = ?", file.path);
    }
    this.writeMeta("purged_before_seq", Math.max(...expired.map((f) => f.seq)) + 1);
  }

  async restore(path: string): Promise<PushResult> {
    const [row] = [...this.sql.exec<{ body: string }>("SELECT body FROM notes WHERE path = ?", path)];
    if (!row) return { status: "conflict", rev: "", body: null };
    // 削除済みの path は push から見ると「現在の rev なし」なので、復元は新規作成と同じ扱いになる。
    return this.push({ path, baseRev: null, kind: "note", mtime: Date.now(), body: row.body });
  }

  async deletedFiles() {
    return [...this.sql.exec(
      "SELECT path, deleted_at, kind FROM files WHERE deleted = 1 ORDER BY deleted_at DESC"
    )];
  }

  /**
   * Vault の中身を全部消す。DO 自体はストレージが空になれば処理系が回収する。
   * 検証で作った Vault が本番に溜まっても消す手段が無かった(§23.3)。
   */
  async destroy(): Promise<{ files: number }> {
    const [row] = [...this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM files")];
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, "vault deleted");
    await this.ctx.storage.deleteAll();
    // deleteAll はスキーマごと消す。この DO はまだメモリに残っているので、
    // 張り直さないと次のクエリが「テーブルが無い」で落ちる。
    for (const statement of SCHEMA) this.sql.exec(statement);
    return { files: row.n };
  }

  // --- 構造クエリ(MCP 構造系ツールの実体) --------------------------------------

  /** プラグインが push したインデックスだけを見るので、本文を読まずに答えられる。 */
  async structure(tool: string, args: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case "vault_tree":
        return this.tree(Number(args.depth ?? 3), String(args.prefix ?? ""));
      case "note_outline":
        return [...this.sql.exec(
          "SELECT level, text, line FROM headings WHERE path = ? ORDER BY line", args.path
        )];
      case "backlinks":
        return [...this.sql.exec(
          `SELECT DISTINCT l.src_path AS path, n.title AS title FROM links l
           LEFT JOIN notes n ON n.path = l.src_path
           WHERE l.dst_path = ? ORDER BY l.src_path`, args.path
        )];
      case "outlinks":
        return [...this.sql.exec(
          `SELECT DISTINCT l.dst_path AS path, l.kind AS kind, n.title AS title FROM links l
           LEFT JOIN notes n ON n.path = l.dst_path
           WHERE l.src_path = ? ORDER BY l.dst_path`, args.path
        )];
      case "graph_neighborhood":
        return this.neighborhood(String(args.path), Number(args.hops ?? 2));
      case "orphan_notes":
        return [...this.sql.exec(
          `SELECT f.path FROM files f
           WHERE f.deleted = 0 AND f.kind = 'note'
             AND f.path NOT IN (SELECT src_path FROM links)
             AND f.path NOT IN (SELECT dst_path FROM links)
           ORDER BY f.path LIMIT ?`, Number(args.limit ?? 50)
        )];
      case "hub_notes":
        return [...this.sql.exec(
          `SELECT path, count(*) AS degree FROM (
             SELECT src_path AS path FROM links
             UNION ALL
             SELECT dst_path AS path FROM links
           ) GROUP BY path ORDER BY degree DESC, path LIMIT ?`, Number(args.limit ?? 20)
        )];
      case "find_by_tag":
        return args.tag
          ? [...this.sql.exec("SELECT DISTINCT path FROM tags WHERE tag = ? ORDER BY path", args.tag)]
          : [...this.sql.exec(
              "SELECT tag, count(*) AS notes FROM tags GROUP BY tag ORDER BY notes DESC, tag"
            )];
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  private tree(depth: number, prefix: string) {
    const rows = [...this.sql.exec<{ path: string }>(
      "SELECT path FROM files WHERE deleted = 0 AND path LIKE ? ORDER BY path", `${prefix}%`
    )];
    const folders = new Map<string, number>();
    const notes: string[] = [];
    for (const { path } of rows) {
      const segments = path.split("/");
      if (segments.length === 1) {
        notes.push(path);
        continue;
      }
      // depth を超える階層はまとめて数だけ返す。全パスを列挙するとトークンを食う。
      const folder = segments.slice(0, Math.min(depth, segments.length - 1)).join("/");
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
    return {
      folders: [...folders].map(([path, files]) => ({ path, files })).sort((a, b) => a.path.localeCompare(b.path)),
      rootNotes: notes,
      totalFiles: rows.length
    };
  }

  private neighborhood(path: string, hops: number) {
    // 再帰 CTE で n-hop の部分グラフを取る。リンクは無向として辿る。
    const nodes = [...this.sql.exec<{ path: string; hop: number }>(
      `WITH RECURSIVE reachable(path, hop) AS (
         SELECT ?, 0
         UNION
         SELECT CASE WHEN l.src_path = r.path THEN l.dst_path ELSE l.src_path END, r.hop + 1
         FROM links l JOIN reachable r ON l.src_path = r.path OR l.dst_path = r.path
         WHERE r.hop < ?
       )
       SELECT path, min(hop) AS hop FROM reachable GROUP BY path ORDER BY hop, path`,
      path, Math.max(0, Math.min(hops, 5))
    )];
    const within = new Set(nodes.map((node) => node.path));
    const edges = [...this.sql.exec<{ src_path: string; dst_path: string; kind: string }>(
      "SELECT DISTINCT src_path, dst_path, kind FROM links"
    )].filter((edge) => within.has(edge.src_path) && within.has(edge.dst_path));
    return { nodes, edges: edges.map((e) => ({ from: e.src_path, to: e.dst_path, kind: e.kind })) };
  }

  // --- 本文系(MCP 本文ツールの実体) ------------------------------------------------

  async content(tool: string, args: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case "read_note": {
        const note = await this.readNote(String(args.path));
        if (!note) throw new Error(`not found: ${args.path}`);
        return note;
      }
      case "read_section":
        return this.readSection(String(args.path), String(args.heading));
      case "search":
        return this.search(String(args.query), Number(args.limit ?? 20));
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  /** 見出しから次の同位以上の見出しまでを切り出す。長いノートを丸ごと読ませないため。 */
  private readSection(path: string, heading: string) {
    const [note] = [...this.sql.exec<{ body: string }>(
      "SELECT body FROM notes WHERE path = ?", path
    )];
    if (!note) throw new Error(`not found: ${path}`);
    const headings = [...this.sql.exec<{ level: number; text: string; line: number }>(
      "SELECT level, text, line FROM headings WHERE path = ? ORDER BY line", path
    )];
    const index = headings.findIndex((h) => h.text === heading);
    if (index === -1) {
      throw new Error(`no heading "${heading}" in ${path}. available: ${headings.map((h) => h.text).join(", ")}`);
    }
    const start = headings[index];
    const next = headings.slice(index + 1).find((h) => h.level <= start.level);
    const lines = note.body.split("\n");
    return {
      path,
      heading: start.text,
      level: start.level,
      text: lines.slice(start.line, next ? next.line : undefined).join("\n")
    };
  }

  /**
   * trigram は3文字未満を引けない(§10)。短い語は部分一致で拾う。
   * FTS5 のクエリ構文を利用者の入力として解釈させないよう、フレーズとして囲う。
   */
  private search(query: string, limit: number) {
    const capped = Math.max(1, Math.min(limit, 100));
    if (query.trim().length < 3) {
      return {
        mode: "substring" as const,
        matches: [...this.sql.exec(
          `SELECT n.path AS path, n.title AS title FROM notes n
           JOIN files f ON f.path = n.path AND f.deleted = 0
           WHERE n.body LIKE ? ORDER BY n.path LIMIT ?`,
          `%${query}%`, capped
        )]
      };
    }
    const phrase = `"${query.replaceAll('"', '""')}"`;
    return {
      mode: "index" as const,
      matches: [...this.sql.exec(
        `SELECT n.path AS path, n.title AS title,
                snippet(notes_fts, 1, '<<', '>>', '…', 12) AS snippet
         FROM notes_fts
         JOIN notes n ON n.id = notes_fts.rowid
         JOIN files f ON f.path = n.path AND f.deleted = 0
         WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?`,
        phrase, capped
      )]
    };
  }

  // --- 通知 -----------------------------------------------------------------

  private broadcast(seq: number, origin?: string): void {
    const message = JSON.stringify({ type: "changed", seq });
    for (const peer of this.ctx.getWebSockets()) {
      if (origin && this.ctx.getTags(peer)[0] === origin) continue;
      peer.send(message);
    }
  }

  async status() {
    const [row] = [...this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM files WHERE deleted = 0")];
    return {
      files: row.n,
      seq: this.readMeta("seq"),
      purgedBeforeSeq: this.readMeta("purged_before_seq"),
      databaseSize: this.sql.databaseSize,
      connectedDevices: this.ctx.getWebSockets().length,
      // external content の delete に渡す値がズレると FTS が静かに壊れ、以降のクエリが
      // SQLITE_CORRUPT_VTAB になる。壊れたことに気づく手段をここに置いておく(§10)。
      ftsIntegrity: this.ftsIntegrity(),
      tools: ALL_TOOLS.map((tool) => tool.name)
    };
  }

  private ftsIntegrity(): string {
    try {
      this.sql.exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')");
      return "ok";
    } catch (error) {
      return String(error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    const deviceId = request.headers.get("X-Device-Id") ?? "unknown";
    // accept() ではなく acceptWebSocket() を使う。前者は接続中ずっと duration 課金され、
    // 3端末を掴みっぱなしにすると無料枠の 13,000 GB-s/日 すら超える。
    // tag に deviceId を入れておくと、発信元を除いたブロードキャストが書ける。
    this.ctx.acceptWebSocket(server, [deviceId]);
    // サブプロトコルで認証した場合、選んだものを返さないとクライアントが接続を切る。
    const offered = request.headers.get("Sec-WebSocket-Protocol")?.split(",")[0].trim();
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: offered ? { "Sec-WebSocket-Protocol": offered } : {}
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const origin = this.ctx.getTags(ws)[0];
    for (const peer of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(peer)[0] !== origin) peer.send(message);
    }
  }
}
