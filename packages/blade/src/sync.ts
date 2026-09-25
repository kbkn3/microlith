import { contentHash } from "@microlith/haft";
import { MicrolithClient, type Change, type NoteIndex } from "./client";
import { mergeNote } from "./merge";

/**
 * 刃(blade)の同期エンジン。Obsidian の API を直接触らず VaultAdapter 越しに動くので、
 * Obsidian を起動せずにサーバと突き合わせて検証できる。
 */
export interface VaultAdapter {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, body: string): Promise<void>;
  create(path: string, body: string): Promise<void>;
  /** 比較と置換を原子的に行う。read/write を分けると待機中の編集を失う。 */
  replaceIfUnchanged(path: string, expectedBody: string, body: string): Promise<boolean>;
  writeAndWaitForIndex?(
    path: string,
    body: string,
    expectedBody: string,
  ): Promise<{ applied: false } | { applied: true; index: NoteIndex | null }>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mtime(path: string): Promise<number>;
  /** Obsidian の metadataCache から取り出したインデックス。サーバでパースしないための要(§2-5)。 */
  indexOf(path: string): NoteIndex | null;
}

export interface StateStore {
  lastSeq: number;
  revOf(path: string): string | null;
  setRev(path: string, rev: string | null): void;
  paths(): string[];
  clear(): void;
  save(): Promise<void>;
}

/** Obsidian Sync の既定に合わせて画像・音声・動画・PDF を外す(§5.6)。 */
const EXCLUDED_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "flac",
  "3gp",
  "mp4",
  "webm",
  "mov",
  "mkv",
  "pdf",
]);

const MAX_ASSET_BYTES = 100 * 1024 * 1024;

export type SyncOptions = {
  deviceName: string;
  /** 画像等も同期する場合に true。既定は Obsidian Sync に合わせて false。 */
  syncAllFileTypes?: boolean;
  automaticMerge?: boolean;
  onNotice?: (message: string) => void;
};

const extensionOf = (path: string): string => path.split(".").pop()?.toLowerCase() ?? "";

export const isNote = (path: string): boolean => extensionOf(path) === "md";

export function isExcluded(path: string, syncAllFileTypes = false): boolean {
  if (path.startsWith(".obsidian/")) return true; // v1 非対応(§5.6)
  if (isNote(path)) return false;
  return syncAllFileTypes ? false : EXCLUDED_EXTENSIONS.has(extensionOf(path));
}

/** Obsidian Sync と同じ命名にする(§5.4)。 */
export function conflictCopyPath(path: string, deviceName: string, at: Date): string {
  const stamp = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
    String(at.getHours()).padStart(2, "0"),
    String(at.getMinutes()).padStart(2, "0"),
  ].join("");
  const dot = path.lastIndexOf(".");
  const [stem, extension] = dot === -1 ? [path, ""] : [path.slice(0, dot), path.slice(dot)];
  return `${stem} (Conflicted copy ${deviceName} ${stamp})${extension}`;
}

export class SyncEngine {
  /** リモートを適用している最中の path。自分の書き込みを変更検知が拾って押し返すのを防ぐ。 */
  private applying = new Set<string>();
  // ponytail: Vault全体を直列化する。並列化が必要ならpath処理とseq順序の制御を分ける。
  private syncing = false;
  private pendingPushes = new Set<string>();
  private pendingPull = false;

  constructor(
    private readonly client: MicrolithClient,
    private readonly vault: VaultAdapter,
    private readonly state: StateStore,
    private readonly options: SyncOptions,
  ) {}

  isApplying(path: string): boolean {
    return this.applying.has(path);
  }

  private notice(message: string): void {
    this.options.onNotice?.(message);
  }

  async pushPath(path: string): Promise<void> {
    if (isExcluded(path, this.options.syncAllFileTypes)) return;
    if (this.applying.has(path)) return;
    this.pendingPushes.add(path);
    await this.syncPending();
  }

  async pull(): Promise<number> {
    this.pendingPull = true;
    return this.syncPending();
  }

  private async syncPending(): Promise<number> {
    // 通知は処理中にも届く。再入を待つと pull → push の競合待機で停止する。
    if (this.syncing) return 0;
    this.syncing = true;
    let applied = 0;
    try {
      while (this.pendingPull || this.pendingPushes.size > 0) {
        if (this.pendingPull) {
          this.pendingPull = false;
          applied += await this.pullChanges();
        } else {
          for (const path of this.pendingPushes) {
            await this.push(path);
            break;
          }
        }
      }
      return applied;
    } finally {
      this.syncing = false;
    }
  }

  private async push(path: string): Promise<boolean> {
    this.pendingPushes.delete(path);
    if (!(await this.vault.exists(path))) return this.pushDeletion(path);

    const baseRev = this.state.revOf(path);
    const mtime = await this.vault.mtime(path);

    if (!isNote(path)) {
      const data = await this.vault.readBinary(path);
      if (data.byteLength > MAX_ASSET_BYTES) {
        // 分割アップロードは作っていない(§2-4)。黙って落とすと同期漏れに気づけない。
        this.notice(`${path} is larger than 100 MB and was not synced.`);
        return false;
      }
      const outcome = await this.client.pushAsset({ path, baseRev, mtime, data });
      if (outcome.status === "conflict") {
        await this.resolveAssetConflict(path, outcome.rev);
        return true;
      }
      this.state.setRev(path, outcome.rev);
      await this.state.save();
      return true;
    }

    const body = await this.vault.read(path);
    const outcome = await this.client.pushNote({
      path,
      baseRev,
      mtime,
      body,
      index: this.vault.indexOf(path) ?? undefined,
    });
    if (outcome.status === "conflict") return this.resolveNoteConflict(path, outcome);
    this.state.setRev(path, outcome.rev);
    await this.state.save();
    return true;
  }

  private async pushDeletion(path: string): Promise<boolean> {
    const baseRev = this.state.revOf(path);
    if (!baseRev) return false;
    const outcome = await this.client.pushNote({ path, baseRev, mtime: Date.now(), deleted: true });
    if (outcome.status !== "conflict") this.state.setRev(path, null);
    await this.state.save();
    return outcome.status !== "conflict";
  }

  private async resolveNoteConflict(
    path: string,
    outcome: { rev: string; body: string | null; baseBody?: string },
  ): Promise<boolean> {
    let acceptedBody: string | null | undefined;
    await this.applyRemote(path, async () => {
      let localBody = await this.vault.read(path);
      if (
        this.options.automaticMerge !== false &&
        outcome.body !== null &&
        outcome.baseBody !== undefined &&
        this.vault.writeAndWaitForIndex
      ) {
        const mergedBody = mergeNote(localBody, outcome.baseBody, outcome.body);
        if (mergedBody !== null) {
          let mergedRev: string | undefined;
          let mergeApplied = false;
          try {
            const result = await this.vault.writeAndWaitForIndex(path, mergedBody, localBody);
            mergeApplied = result.applied;
            if (result.applied && result.index !== null) {
              const retried = await this.client.pushNote({
                path,
                baseRev: outcome.rev,
                mtime: Date.now(),
                body: mergedBody,
                index: result.index,
              });
              if (retried.status === "conflict") outcome = retried;
              else mergedRev = retried.rev;
            }
          } catch {
            // 送信結果が不明でも、待機中の編集を含めて退避する。
          }
          if (mergedRev !== undefined) {
            this.state.setRev(path, mergedRev);
            await this.state.save();
            acceptedBody = mergedBody;
            return;
          }
          if (mergeApplied) {
            const latestBody = await this.vault.read(path);
            if (latestBody !== mergedBody) localBody = latestBody;
            // この後のコピー作成や送信が失敗しても、原文を原本に残す。
            if (latestBody !== localBody)
              await this.vault.replaceIfUnchanged(path, latestBody, localBody);
          }
        }
      }

      let copy: string;
      for (;;) {
        localBody = await this.vault.read(path);
        const copyPath = conflictCopyPath(path, this.options.deviceName, new Date());
        copy = copyPath;
        for (let suffix = 2; await this.vault.exists(copy); suffix++) {
          copy = copyPath.replace(/(\.md)$/i, ` ${suffix}$1`);
        }
        await this.applyRemote(copy, async () => this.vault.create(copy, localBody));
        const pushed = await this.client.pushNote({
          path: copy,
          baseRev: null,
          mtime: Date.now(),
          body: localBody,
          index: this.vault.indexOf(copy) ?? undefined,
        });
        if (pushed.status === "conflict")
          throw new Error(`Conflict copy ${copy} could not be synced.`);
        this.state.setRev(copy, pushed.rev);
        // コピーの送信待ち中にも編集できるので、未退避の本文を上書きしない。
        if ((await this.vault.read(path)) !== localBody) continue;
        // 削除には原子的な本文比較がないため、原本を残して null base から再送する。
        if (outcome.body === null) break;
        if (await this.vault.replaceIfUnchanged(path, localBody, outcome.body)) break;
      }
      this.state.setRev(path, outcome.body === null ? null : outcome.rev);
      await this.state.save();
      this.notice(
        outcome.body === null
          ? `Deletion conflict on ${path}. Your note was kept for resync, with a copy at ${copy}.`
          : `Conflict on ${path}. Your version was kept as ${copy}.`,
      );
      acceptedBody = outcome.body;
    });
    if (acceptedBody !== undefined) {
      const latestBody = (await this.vault.exists(path)) ? await this.vault.read(path) : null;
      if (latestBody !== acceptedBody) return this.push(path);
    }
    return true;
  }

  /** 添付はテキストではないので競合コピーを作らずリモートを採用する。 */
  private async resolveAssetConflict(path: string, remoteRev: string): Promise<void> {
    const data = await this.client.readAsset(path);
    await this.applyRemote(path, async () => this.vault.writeBinary(path, data));
    this.state.setRev(path, remoteRev);
    await this.state.save();
    this.notice(`${path} was replaced by the version from another device.`);
  }

  private async applyRemote(path: string, write: () => Promise<void>): Promise<void> {
    this.applying.add(path);
    try {
      await write();
    } finally {
      this.applying.delete(path);
    }
  }

  private async pullChanges(): Promise<number> {
    let applied = 0;
    for (;;) {
      const result = await this.client.changes(this.state.lastSeq);
      if (result.status === "resync-required") {
        // purge 済みの削除を知らないので、差分では正しい状態に到達できない(§5.5)。
        this.state.clear();
        this.notice("Server history was pruned; performing a full resync.");
        continue;
      }
      for (const change of result.changes) applied += (await this.applyChange(change)) ? 1 : 0;
      this.state.lastSeq = result.seq;
      if (!result.hasMore) break;
    }
    await this.state.save();
    return applied;
  }

  /** ローカルの実体から rev を計算する。無ければ null。 */
  private async localRev(path: string, kind: "note" | "asset"): Promise<string | null> {
    if (!(await this.vault.exists(path))) return null;
    const body = kind === "note" ? await this.vault.read(path) : await this.vault.readBinary(path);
    return contentHash(body);
  }

  private async applyChange(change: Change): Promise<boolean> {
    if (isExcluded(change.path, this.options.syncAllFileTypes)) return false;
    if (this.state.revOf(change.path) === change.rev) return false;

    const local = await this.localRev(change.path, change.kind);

    // 手元が既にリモートと同一なら、rev を覚えるだけでよい。
    // 同じ Vault をコピーした端末に入れたときに、全ファイルが競合になるのを防ぐ。
    if (local !== null && local === change.rev) {
      this.state.setRev(change.path, change.rev);
      return false;
    }

    // 端末を止めている間に自分でも編集していた場合、リモートをそのまま書くとその編集が消える。
    // 競合検知は push 側だけでは足りない。
    const diverged = local !== null && local !== this.state.revOf(change.path);

    if (change.deleted) {
      if (!(await this.vault.exists(change.path))) {
        this.state.setRev(change.path, null);
        return false;
      }
      // ローカルの編集を削除で消さない。push 側に回せば競合コピーとして残る。
      if (diverged || this.pendingPushes.has(change.path)) {
        if (change.kind !== "note") return false;
        return (await this.push(change.path)) ? true : this.applyChange(change);
      }
      await this.applyRemote(change.path, () => this.vault.remove(change.path));
      this.state.setRev(change.path, null);
      return true;
    }

    if (change.kind === "note") {
      if (diverged && (await this.push(change.path))) return true;
      const note = await this.client.readNote(change.path);
      while (this.pendingPushes.has(change.path)) {
        if (await this.push(change.path)) return true;
      }
      await this.applyRemote(change.path, () => this.vault.write(change.path, note.body));
      this.state.setRev(change.path, note.rev);
    } else {
      const data = await this.client.readAsset(change.path);
      if (diverged) {
        // 添付は競合コピーを作らずリモートを採用する(push 側と同じ扱い)
        this.notice(`${change.path} was replaced by the version from another device.`);
      }
      await this.applyRemote(change.path, () => this.vault.writeBinary(change.path, data));
      this.state.setRev(change.path, change.rev);
    }
    return true;
  }

  /** 起動時など、ローカル全体をサーバに合わせる。 */
  async pushAll(): Promise<void> {
    for (const path of await this.vault.list()) await this.pushPath(path);
    // ローカルから消えたまま削除を送れていない path を拾う
    const present = new Set(await this.vault.list());
    for (const tracked of this.state.paths()) {
      if (!present.has(tracked)) await this.pushPath(tracked);
    }
  }
}
