/** Worker の同期 API に話すクライアント。Obsidian に依存しないので単体で動かせる。 */

export type Change = {
  path: string; seq: number; rev: string; kind: "note" | "asset";
  size: number; mtime: number; deleted: boolean;
};

export type NoteIndex = {
  links?: { dst: string; kind: string }[];
  tags?: string[];
  headings?: { level: number; text: string; line: number; parentLine: number }[];
  frontmatter?: unknown;
};

export type PushOutcome =
  | { status: "ok" | "unchanged"; seq: number; rev: string }
  | { status: "conflict"; rev: string; body: string | null };

export class ServerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Obsidian のレンダラは `app://obsidian.md` オリジンで動くため、`Authorization` を付けた
 * `fetch` は CORS プリフライトを起こして失敗する。サーバを任意の web オリジンに開くのではなく、
 * 呼び出し側が Obsidian の `requestUrl`(メインプロセス経由)を挿せるようにする。
 * 既定はそのまま `fetch` なので、Obsidian の外からも同じクライアントが使える。
 */
export type HttpResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: { get(name: string): string | null };
};

export type HttpClient = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer }
) => Promise<HttpResponse>;

const defaultHttp: HttpClient = (url, init) => fetch(url, init as RequestInit);

export class MicrolithClient {
  constructor(
    private readonly endpoint: string,
    private readonly vaultId: string,
    private readonly token: string,
    private readonly http: HttpClient = defaultHttp
  ) {}

  private url(action: string, query: Record<string, string> = {}): string {
    const url = new URL(`${this.endpoint.replace(/\/$/, "")}/vault/${this.vaultId}/${action}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }

  private async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer } = {}
  ): Promise<HttpResponse> {
    const response = await this.http(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...init.headers }
    });
    // 409 と 412 は正常な制御フロー。呼び出し側が分岐するのでここでは投げない。
    if (!response.ok && response.status !== 409 && response.status !== 412) {
      throw new ServerError(response.status, `${init.method ?? "GET"} ${url}: ${await response.text()}`);
    }
    return response;
  }

  async changes(since: number): Promise<
    { status: "ok"; seq: number; hasMore: boolean; changes: Change[] } | { status: "resync-required" }
  > {
    const response = await this.request(this.url("changes", { since: String(since) }));
    if (response.status === 412) return { status: "resync-required" };
    return response.json();
  }

  async readNote(path: string): Promise<{ rev: string; body: string }> {
    return (await this.request(this.url("file", { path }))).json();
  }

  async readAsset(path: string): Promise<ArrayBuffer> {
    return (await this.request(this.url("file", { path }))).arrayBuffer();
  }

  async pushNote(input: {
    path: string; baseRev: string | null; mtime: number; body?: string;
    deleted?: boolean; index?: NoteIndex;
  }): Promise<PushOutcome> {
    const response = await this.request(this.url("push"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    return response.json();
  }

  async pushAsset(input: {
    path: string; baseRev: string | null; mtime: number; data: ArrayBuffer;
  }): Promise<PushOutcome> {
    const query: Record<string, string> = { path: input.path, mtime: String(input.mtime) };
    if (input.baseRev) query.baseRev = input.baseRev;
    const response = await this.request(this.url("asset", query), { method: "POST", body: input.data });
    return response.json();
  }

  /** WebSocket API はヘッダを送れないため、サブプロトコルでトークンを渡す。 */
  connect(onChanged: (seq: number) => void): WebSocket {
    const url = this.url("ws").replace(/^http/, "ws");
    const socket = new WebSocket(url, ["bearer", this.token]);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "changed") onChanged(message.seq);
    });
    return socket;
  }
}
