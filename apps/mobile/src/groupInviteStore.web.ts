const key = 'merosplit.pendingGroupInvite';
export async function savedGroupInvite(): Promise<string | null> { try { return sessionStorage.getItem(key); } catch { return null; } }
export async function saveGroupInvite(token: string | null): Promise<void> { try { if (token) sessionStorage.setItem(key, token); else sessionStorage.removeItem(key); } catch { /* In-memory continuation remains available. */ } }
