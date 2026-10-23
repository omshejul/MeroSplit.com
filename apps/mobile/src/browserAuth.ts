import type { Session } from './types';

export { AuthTransitionError as BrowserAuthTransitionError, accountRequestsPaused as browserRequestsPaused, pauseAccountRequests as pauseBrowserRequests, resumeAccountRequests as resumeBrowserRequests, accountRequest as browserAccountRequest } from './accountRequests.ts';

export type BrowserUser = { id: string | number; email: string; display_name?: string };
export function makeBrowserSession(baseUrl: string, user: BrowserUser): Session {
  const userId = String(user.id);
  if (!/^[1-9]\d*$/.test(userId) || typeof user.email !== 'string' || !user.email.trim()) throw new Error('Could not confirm the signed-in account.');
  return { baseUrl, userId, email: user.email, displayName: user.display_name ?? '', token: `browser-session:${userId}:${globalThis.crypto.randomUUID()}` };
}

export function cachedBrowserSession(baseUrl: string, raw: string | null): Session | null {
  try {
    const value = raw ? JSON.parse(raw) as Session : null;
    return value?.baseUrl === baseUrl && /^[1-9]\d*$/.test(value.userId) && typeof value.email === 'string' && !!value.email.trim()
      && typeof value.token === 'string' && new RegExp(`^browser-session:${value.userId}(?::[0-9a-f-]{36})?$`, 'i').test(value.token) ? value : null;
  } catch { return null; }
}

// Only transport failure/temporary server failure may use account-scoped offline
// metadata. A definitive missing cookie never restores the cached account as signed in.
export async function readBrowserSession(baseUrl: string, cached: Session | null, fetcher: typeof fetch = fetch): Promise<Session | null> {
  if (cached?.baseUrl !== baseUrl) cached = null;
  let response: Response;
  try { response = await fetcher(`${baseUrl}/api/v1/me`, { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) }); }
  catch { return cached; }
  if (response.status === 401 || response.status === 403) return null;
  if (response.status >= 500) return cached;
  if (!response.ok) throw new Error('Could not confirm the signed-in account.');
  const user = await response.json() as BrowserUser;
  const canonical = makeBrowserSession(baseUrl, user);
  return cached?.userId === canonical.userId && cached.email === canonical.email && /^browser-session:\d+:[0-9a-f-]{36}$/i.test(cached.token)
    ? { ...canonical, token: cached.token } : canonical;
}

// Metadata edits are not sign-in: only update the generation that the caller
// read. Keep this compare/write synchronous so another tab's adopted metadata
// cannot be overwritten after an awaited profile response.
export function updateBrowserSessionMetadata(expected: Session, next: Session): boolean {
  if (next.baseUrl !== expected.baseUrl || next.userId !== expected.userId || next.token !== expected.token) return false;
  const key = 'merosplit.web.session';
  let raw: string | null;
  try { raw = localStorage.getItem(key); }
  catch { return true; } // Blocked metadata storage must not prevent an in-memory profile update.
  const current = cachedBrowserSession(expected.baseUrl, raw);
  if (!current || current.userId !== expected.userId || current.token !== expected.token) return false;
  try { localStorage.setItem(key, JSON.stringify(next)); }
  catch { /* The matching in-memory session remains usable when persistence is blocked. */ }
  return true;
}
