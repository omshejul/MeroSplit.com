const capability = /^(?:[A-Za-z0-9_-]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[A-Za-z0-9_-]{43})$/i;
const pendingKey = 'merosplit.pendingGroupInvite';
const continuationKey = pendingKey + '.continuation';
const continuationLifetime = 30 * 60_000;
export function groupInviteToken(hash: string): string | null {
  try { const value = decodeURIComponent(hash.match(/^#token=([^&]+)$/)?.[1] ?? ''); return capability.test(value) ? value : null; } catch { return null; }
}
export function captureGroupInvite(): string | null {
  if (typeof window === 'undefined') return null;
  const joinPath = /^\/app\/invite\/join\/?$/.test(window.location.pathname);
  const signInPath = /^\/app\/sign-in(?:\/|$)/.test(window.location.pathname);
  if (!joinPath && !signInPath && !/^\/app\/?$/.test(window.location.pathname)) return null;
  const browser = window as Window & { __meroGroupInviteToken?: string | null };
  const incoming = joinPath && (!!window.location.hash || Object.hasOwn(browser, '__meroGroupInviteToken'));
  let token = incoming ? browser.__meroGroupInviteToken ?? groupInviteToken(window.location.hash) : null;
  delete browser.__meroGroupInviteToken;
  if (incoming && !token) forgetGroupInvite();
  try {
    if (!incoming) token = sessionStorage.getItem(pendingKey);
    if (token && capability.test(token)) sessionStorage.setItem(pendingKey, token); else { token = null; sessionStorage.removeItem(pendingKey); }
  } catch { /* Memory-only continuation still works when tab storage is blocked. */ }
  try {
    if (incoming && token) localStorage.setItem(continuationKey, JSON.stringify({ token, expiresAt: Date.now() + continuationLifetime }));
    // Email links often open in another tab. Home only resumes its own tab's invite.
    if (!incoming && signInPath && !token) {
      const saved = JSON.parse(localStorage.getItem(continuationKey) ?? 'null');
      if (saved && typeof saved.token === 'string' && capability.test(saved.token) && typeof saved.expiresAt === 'number'
        && saved.expiresAt > Date.now() && saved.expiresAt <= Date.now() + continuationLifetime) token = saved.token;
      else localStorage.removeItem(continuationKey);
    }
  } catch { try { localStorage.removeItem(continuationKey); } catch { /* Tab storage and memory still work when shared storage is blocked. */ } }
  if (token) { try { sessionStorage.setItem(pendingKey, token); } catch {} }
  if (joinPath && (window.location.hash || window.location.search)) window.history.replaceState(null, '', '/app/invite/join');
  return token && capability.test(token) ? token : null;
}
export function forgetGroupInvite(): void {
  if (typeof window === 'undefined') return;
  delete (window as Window & { __meroGroupInviteToken?: string | null }).__meroGroupInviteToken;
  try { sessionStorage.removeItem(pendingKey); } catch { /* Nothing durable to clear. */ }
  try { localStorage.removeItem(continuationKey); } catch { /* Nothing shared to clear. */ }
}
