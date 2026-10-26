import type { StateStore } from "./sync";

export type PersistedState = { lastSeq: number; revs: Record<string, string> };

const SAVE_INTERVAL_MS = 1_000;

/**
 * どの path がどの rev まで同期済みかを覚える。これが無いと baseRev を送れず、
 * 競合検知が成立しない(§5.4)。
 */
export class PluginState implements StateStore {
  lastSeq: number;
  private revs: Map<string, string>;
  private persistedAt = 0;
  private scheduled = false;

  constructor(
    persisted: PersistedState | null,
    private readonly persist: (state: PersistedState) => Promise<void>,
  ) {
    this.lastSeq = persisted?.lastSeq ?? 0;
    this.revs = new Map(Object.entries(persisted?.revs ?? {}));
  }

  revOf(path: string): string | null {
    return this.revs.get(path) ?? null;
  }

  setRev(path: string, rev: string | null): void {
    if (rev === null) this.revs.delete(path);
    else this.revs.set(path, rev);
  }

  paths(): string[] {
    return [...this.revs.keys()];
  }

  clear(): void {
    this.lastSeq = 0;
    this.revs.clear();
  }

  /**
   * 初回同期では1件ごとに呼ばれ、data.json 全体の書き直しが件数の二乗で効く。
   * 間隔内の呼び出しは後ろの1回にまとめる。書き損ねた rev は、起動時に先に走る pull が
   * 手元と同一内容のものを拾い直すので、失うのは往復だけで競合コピーは生まれない。
   */
  async save(): Promise<void> {
    if (this.scheduled) return;
    const wait = this.persistedAt + SAVE_INTERVAL_MS - Date.now();
    if (wait <= 0) return this.persistNow();
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.persistNow().catch((error) => console.error("Microlith: failed to save state", error));
    }, wait);
  }

  private async persistNow(): Promise<void> {
    this.persistedAt = Date.now();
    await this.persist({ lastSeq: this.lastSeq, revs: Object.fromEntries(this.revs) });
  }
}
