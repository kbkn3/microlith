import { diff3Merge } from "node-diff3";

// 改行を独立トークンにして、隣接する別行編集を同じ競合領域にまとめない。
const lines = (body: string): string[] => body.match(/[^\r\n]+|\r\n|[\r\n]/g) ?? [];

export function mergeNote(localBody: string, baseBody: string, remoteBody: string): string | null {
  const regions = diff3Merge(lines(localBody), lines(baseBody), lines(remoteBody), {
    excludeFalseConflicts: true,
  });
  if (regions.some((region) => "conflict" in region)) return null;
  return regions.flatMap((region) => ("ok" in region ? region.ok : [])).join("");
}
