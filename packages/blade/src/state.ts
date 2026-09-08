import type { StateStore } from "./sync";

export type PersistedState = { lastSeq: number; revs: Record<string, string> };

/**
 * どの path がどの rev まで同期済みかを覚える。これが無いと baseRev を送れず、
 * 競合検知が成立しない(§5.4)。
 */
export class PluginState implements StateStore {
  lastSeq: number;
  private revs: Map<string, string>;

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

  async save(): Promise<void> {
    await this.persist({ lastSeq: this.lastSeq, revs: Object.fromEntries(this.revs) });
  }
}
