/**
 * rev は本文の content hash。同じ内容を書き戻しても rev が変わらないため、
 * 端末間の往復が no-op になって無限ループが自然に止まる(§5.2)。
 * R2 のキーにもこの hash をそのまま使うので、再送が冪等になり orphan を気にせずに済む。
 */
export async function contentHash(body: string | ArrayBuffer): Promise<string> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** デバイストークンは平文で持たない。salt は ADMIN_SECRET から取る(§5.7)。 */
export async function tokenHash(secret: string, token: string): Promise<string> {
  return contentHash(`${secret}:${token}`);
}
