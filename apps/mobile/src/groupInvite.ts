const capability = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[A-Za-z0-9_-]{43}$/i;
const pendingKey = 'merosplit.pendingGroupInvite';
export function groupInviteToken(hash: string): string | null {
  try { const value = decodeURIComponent(hash.match(/^#token=([^&]+)$/)?.[1] ?? ''); return capability.test(value) ? value : null; } catch { return null; }
}
export function captureGroupInvite(): string | null {
  if (typeof window === 'undefined') return null;
  const joinPath = /^\/app\/invite\/join\/?$/.test(window.location.pathname);
  if (!joinPath && !window.location.pathname.startsWith('/app/sign-in/')) return null;
  const browser = window as Window & { __meroGroupInviteToken?: string | null };
  let token = browser.__meroGroupInviteToken ?? (joinPath ? groupInviteToken(window.location.hash) : null);
  delete browser.__meroGroupInviteToken;
  try {
    if (!token && (!joinPath || !window.location.hash)) token = sessionStorage.getItem(pendingKey);
    if (token && capability.test(token)) sessionStorage.setItem(pendingKey, token); else { token = null; sessionStorage.removeItem(pendingKey); }
  } catch { /* Memory-only continuation still works when tab storage is blocked. */ }
  if (joinPath && (window.location.hash || window.location.search)) window.history.replaceState(null, '', '/app/invite/join');
  return token && capability.test(token) ? token : null;
}
export function forgetGroupInvite(): void {
  if (typeof window === 'undefined') return;
  delete (window as Window & { __meroGroupInviteToken?: string | null }).__meroGroupInviteToken;
  try { sessionStorage.removeItem(pendingKey); } catch { /* Nothing durable to clear. */ }
}
