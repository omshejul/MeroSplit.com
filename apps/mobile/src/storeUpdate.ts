// Only fixed store destinations can be opened. Release responses describe versions, never URLs.
export const appStores = {
  ios: { name: 'App Store', native: 'itms-apps://itunes.apple.com/app/id6823916128', web: 'https://apps.apple.com/app/merosplit/id6823916128' },
  android: { name: 'Google Play', native: 'market://details?id=com.omshejul.splitdumb', web: 'https://play.google.com/store/apps/details?id=com.omshejul.splitdumb' },
} as const;

function versionParts(value: unknown): bigint[] {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,10}){0,3}$/.test(value)) throw new Error('Release version unavailable.');
  return value.split('.').map(part => BigInt(part));
}

export async function checkStoreUpdate(baseUrl: string, platform: string, installed: unknown, installedVersion: unknown): Promise<string | null> {
  if ((platform !== 'ios' && platform !== 'android') || typeof installed !== 'string' || !/^[1-9]\d{0,9}$/.test(installed)) throw new Error('Installed build unavailable.');
  const current = versionParts(installedVersion);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/app-releases`, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error('Release check failed.');
    const releases = await response.json(), release = releases?.[platform], build: unknown = release?.build;
    if (typeof build !== 'string' || !/^[1-9]\d{0,9}$/.test(build)) throw new Error('Release build unavailable.');
    const latest = versionParts(release?.version);
    let order = 0;
    for (let i = 0; i < Math.max(current.length, latest.length); i++) {
      const a = latest[i] ?? 0n, b = current[i] ?? 0n;
      if (a !== b) { order = a > b ? 1 : -1; break; }
    }
    return order > 0 || order === 0 && BigInt(build) > BigInt(installed) ? `${release.version}:${build}` : null;
  } finally { clearTimeout(timer); }
}
