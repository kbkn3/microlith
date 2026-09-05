import { contentHash } from "@microlith/haft";

export { contentHash };

/** デバイストークンは平文で持たない。salt は ADMIN_SECRET から取る(§5.7)。 */
export async function tokenHash(secret: string, token: string): Promise<string> {
  return contentHash(`${secret}:${token}`);
}
