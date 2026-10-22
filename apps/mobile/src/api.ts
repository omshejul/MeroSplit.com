import type { Expense, Group, Session } from './types';
import { acceptCommand, markCommand, pendingCommands } from './storage.ts';
import type { Database } from './storage.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function accountOwner(session: Session): string { return `${session.baseUrl}|${session.userId}`; }

export function expensePayload(expense: Expense, updating = false): Record<string, unknown> {
  const { id, description, total, paid, split, date, category, notes } = expense;
  return { id, description, total, paid, split, date, category, notes, ...(updating ? { version: expense.version } : {}) };
}

export async function request<T>(session: Session, path: string, method = 'GET', body?: unknown, responseType: 'json' | 'text' = 'json'): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${session.baseUrl}/api/v1${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.token },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    }).catch(() => { throw new Error('Could not connect. Your saved changes remain on this phone. Retry when online.'); });
    if (responseType === 'text' && response.ok) return await response.text() as T;
    if (!response.headers.get('content-type')?.includes('json')) throw new ApiError(response.ok ? 502 : response.status, 'The service is temporarily unavailable. Your saved changes remain on this phone. Try again later.');
    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, String(data.detail ?? data.error ?? `Request failed (${response.status})`));
    return data as T;
  } finally { clearTimeout(timer); }
}

// Never replay a command under another account or backend. GET follows the
// idempotent write so a lost response can be recovered by retrying the same ID.
export async function syncOutbox(db: Database, session: Session): Promise<Record<string, unknown>[]> {
  const owner = accountOwner(session);
  const receipts: Record<string, unknown>[] = [];
  for (const command of await pendingCommands(db, owner)) {
    if (command.state !== 'pending') throw new Error('Resolve the earlier rejected/conflicting change before syncing later commands.');
    let writeAccepted = false;
    try {
      const receipt = await request<Record<string, unknown>>(session, command.path, command.method, command.body);
      writeAccepted = true;
      const group = await request<Group>(session, `/groups/${command.group_id}`);
      await acceptCommand(db, owner, command.command_id, group);
      receipts.push(receipt);
    } catch (error) {
      if (!writeAccepted && error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429) {
        await markCommand(db, owner, command.command_id, error.status === 409 ? 'conflict' : 'rejected', error.message);
      }
      throw error;
    }
  }
  return receipts;
}

type AuthResult = { meta?: { session_token?: string; is_authenticated?: boolean }; data?: { user?: { id: string | number; email?: string } }; errors?: { message?: string }[] };
export async function authenticate(baseUrl: string, email: string, password: string, signup: boolean): Promise<Session> {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+(?:\/[^?#]*)?$/.test(normalized)) throw new Error('Enter an HTTP(S) server URL without a query.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${normalized}/_allauth/app/v1/auth/${signup ? 'signup' : 'login'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim(), password }), signal: controller.signal,
    }).catch(() => { throw new Error('Could not connect. Check your connection and try signing in again.'); });
    if (!response.headers.get('content-type')?.includes('json')) throw new Error('Sign-in is temporarily unavailable. Try again later.');
    const data = await response.json() as AuthResult;
    if (!response.ok || !data.meta?.session_token || !data.data?.user || data.meta.is_authenticated === false) {
      throw new Error(data.errors?.map(error => error.message).filter(Boolean).join(' ') || 'Sign-in is incomplete. Check your details or required email verification.');
    }
    return { token: data.meta.session_token, userId: String(data.data.user.id), email: data.data.user.email ?? email.trim(), baseUrl: normalized };
  } finally { clearTimeout(timer); }
}
