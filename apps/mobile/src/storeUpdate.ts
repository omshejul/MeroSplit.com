// Only fixed store destinations can be opened. Release responses supply build numbers, never URLs.
export const appStores = {
  ios: { name: 'App Store', native: 'itms-apps://itunes.apple.com/app/id6823916128', web: 'https://apps.apple.com/app/merosplit/id6823916128' },
  android: { name: 'Google Play', native: 'market://details?id=com.omshejul.splitdumb', web: 'https://play.google.com/store/apps/details?id=com.omshejul.splitdumb' },
} as const;

export async function checkStoreUpdate(baseUrl: string, platform: string, installed: unknown): Promise<string | null> {
  if ((platform !== 'ios' && platform !== 'android') || typeof installed !== 'string' || !/^[1-9]\d{0,9}$/.test(installed)) throw new Error('Installed build unavailable.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/app-releases`, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error('Release check failed.');
    const releases = await response.json(), build: unknown = releases?.[platform]?.build;
    if (typeof build !== 'string' || !/^[1-9]\d{0,9}$/.test(build)) throw new Error('Release build unavailable.');
    return BigInt(build) > BigInt(installed) ? build : null;
  } finally { clearTimeout(timer); }
}
