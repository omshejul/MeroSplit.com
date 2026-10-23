import type { Command, Expense, Group, LegacyRecovery, Session } from './types';
import { acceptCommand, bindLegacyGroup, markCommand, pendingCommands, readGroup, readLegacyRecovery, readLegacySource } from './storage.ts';
import type { Database } from './storage.ts';
import { legacyMatchesServer, previewPending } from './ledger.ts';

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

// Called only after the person explicitly chooses this account and their name.
// Queue immutable existing API commands before sending anything to the server.
export async function claimLegacyGroup(db: Database, session: Session, groupId: string, selfId: string, uuid: () => string, send: typeof request = request): Promise<{ status: LegacyRecovery['status']; groupId: string; reason: string | null }> {
  const owner = accountOwner(session), source = await readLegacySource(db, groupId);
  if (!source) {
    const previous = await readLegacyRecovery(db, owner, groupId);
    if (!previous) throw new Error('These phone records are no longer available to this account.');
    return { status: previous.status, groupId, reason: previous.reason };
  }
  if (!source.group.participants.some(person => person.id === selfId)) throw new Error('Choose which person you are.');
  let server: Group | null;
  try { server = await send<Group>(session, `/groups/${groupId}`); }
  catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; server = null; }
  if (server && server.id !== groupId) throw new Error('The service returned another group. Try again.');
  if (server && server.participants.find(person => String(person.user_id) === session.userId)?.id !== selfId) throw new Error('Choose the person already linked to this account in the server group.');
  const cached = await readGroup(db, owner, groupId), pending = (await pendingCommands(db, owner)).filter(row => row.group_id === groupId);
  let canonical = server, status: LegacyRecovery['status'] = 'conflict', reason: string | null = 'These phone records could not be safely matched to this account. Their original data is saved for review; server records were not changed.';
  const commands: Command[] = [];
  const append = (method: Command['method'], path: string, body: Record<string, unknown>) => {
    const command_id = uuid(); commands.push({ command_id, group_id: groupId, method, path, body: { ...body, command_id }, state: 'pending', error: null });
  };
  if (!source.commands.length && server && legacyMatchesServer(source.group, server)) { status = 'existing'; reason = null; }
  else if (!source.commands.length && !server && cached?.group.version === 0 && pending.some(row => row.path === '/groups' && row.body.self_participant_id === selfId)) {
    try { if (legacyMatchesServer(source.group, previewPending(cached.group, pending))) { status = 'queued'; reason = null; canonical = cached.group; } } catch { /* Preserve both records for review. */ }
  } else if (!source.commands.length && !server && !cached && !pending.length && !source.group.opening_balance && !source.group.participants.some(person => person.removed)) {
    const group = source.group;
    append('POST', '/groups', { id: group.id, name: group.name, participants: group.participants.map(({ id, name }) => ({ id, name })), self_participant_id: selfId, is_direct: !!group.is_direct });
    for (const expense of group.expenses) {
      append('POST', `/groups/${groupId}/expenses`, expensePayload(expense));
      if (expense.deleted) append('DELETE', `/groups/${groupId}/expenses/${expense.id}`, { version: 1 });
    }
    for (const payment of group.settlements) {
      append('POST', `/groups/${groupId}/settlements`, { id: payment.id, sender: payment.sender, recipient: payment.recipient, amount: payment.amount, date: payment.date ?? null });
      if (payment.reversed) append('POST', `/groups/${groupId}/settlements/${payment.id}/reverse`, {});
    }
    if (group.archived) append('POST', `/groups/${groupId}/archive`, { archived: true });
    canonical = { ...group, version: 0, owner_id: Number(session.userId), participants: group.participants.map(({ id, name }) => ({ id, name, user_id: id === selfId ? Number(session.userId) : null })), expenses: [], settlements: [], balances: Object.fromEntries(group.participants.map(person => [person.id, '0'])), transfers: [], activity: [], archived: false };
    status = 'queued'; reason = null;
  }
  await bindLegacyGroup(db, owner, { ...source, selfId, status, reason }, canonical, commands);
  return { status, groupId, reason };
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
