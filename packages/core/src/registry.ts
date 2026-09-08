import type { Env } from "./env";

/**
 * 使っている Vault 名の控え。
 *
 * DO は名前で作られるので、**間違った名前を書いても静かに空の Vault ができる**(§24.2)。
 * 同意画面と `/setup` が「実在する Vault」を出せるように、意図した使用開始を記録する。
 *
 * 当初は `vault:` 接頭辞のキーを `list()` で数えていたが、**KV の list は本番で
 * 10秒以上遅れる**。控えを見たいのは「今作った Vault を選びたい」ときなので、
 * それでは役に立たない。単一キーの配列にして `get` で読む。
 *
 * ponytail: 読んで書き戻すので同時更新は取りこぼしうる。自己ホストの単独利用者を
 * 前提にしている。取りこぼしても選択肢に出ないだけで、名前を打てば使える。
 * 複数人で同時に Vault を増やすなら DO に移す。
 */
const VAULTS_KEY = "vaults";
const LEGACY_VAULT_PREFIX = "vault:";

export async function knownVaults(environment: Env): Promise<string[]> {
  const stored = await environment.OAUTH_KV.get<string[]>(VAULTS_KEY, { type: "json" });
  if (stored !== null) return Array.isArray(stored) ? stored : [];

  // 既存環境の Vault を選択肢から消さないため、単一キーの初回作成時だけ旧形式を読む。
  const listing = await environment.OAUTH_KV.list({ prefix: LEGACY_VAULT_PREFIX, limit: 1000 });
  const migrated = listing.keys.map((key) => key.name.slice(LEGACY_VAULT_PREFIX.length)).sort();
  await environment.OAUTH_KV.put(VAULTS_KEY, JSON.stringify(migrated));
  return migrated;
}

export async function rememberVault(environment: Env, vaultId: string): Promise<void> {
  const known = await knownVaults(environment);
  if (known.includes(vaultId)) return;
  await environment.OAUTH_KV.put(VAULTS_KEY, JSON.stringify([...known, vaultId].sort()));
}

export async function forgetVault(environment: Env, vaultId: string): Promise<void> {
  const known = await knownVaults(environment);
  if (!known.includes(vaultId)) return;
  await environment.OAUTH_KV.put(
    VAULTS_KEY,
    JSON.stringify(known.filter((name) => name !== vaultId)),
  );
}
