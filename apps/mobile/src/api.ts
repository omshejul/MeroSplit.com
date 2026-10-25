import type { Command, Expense, Group, LegacyRecovery, Session } from './types';
import { sessionRequest } from './transport.ts';
export { requestEmailCode, confirmEmailCode, signOut as endSession } from './transport.ts';
export type { EmailCodeChallenge } from './transport.ts';
import { acceptCommand, bindLegacyGroup, markCommand, pendingCommands, readGroup, readLegacyRecovery, readLegacySource, reconcileGroupCache, readVisibleGroup } from './storage.ts';
import type { AcceptedMembership, Database, MembershipReceipt } from './storage.ts';
import { legacyMatchesServer, previewPending } from './ledger.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function accountOwner(session: Session): string { return `${session.baseUrl}|${session.userId}`; }

export function expensePayload(expense: Expense, updating = false): Record<string, unknown> {
  const { id, description, total, paid, split, date, category, category_auto, notes } = expense;
  return { id, description, total, paid, split, date, category, notes, ...(typeof category_auto === 'boolean' ? { category_auto } : {}), ...(updating ? { version: expense.version } : {}) };
}

export async function request<T>(session: Session, path: string, method = 'GET', body?: unknown, responseType: 'json' | 'text' = 'json', signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await sessionRequest(session, `/api/v1${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    }).catch(() => { throw new Error('Could not connect. Keep this app open and retry when online.'); });
    if (responseType === 'text' && response.ok) return await response.text() as T;
    if (!response.headers.get('content-type')?.includes('json')) throw new ApiError(response.ok ? 502 : response.status, 'The service is temporarily unavailable. Try again later.');
    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, String(data.detail ?? data.error ?? `Request failed (${response.status})`));
    return data as T;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

// Never replay a command under another account or backend. GET follows the
// idempotent write so a lost response can be recovered by retrying the same ID.
export async function syncOutbox(db: Database, session: Session, mode: 'full' | 'summary' = 'full', stopAfterCommandId?: string): Promise<Record<string, unknown>[]> {
  const owner = accountOwner(session);
  const receipts: Record<string, unknown>[] = [];
  for (const command of await pendingCommands(db, owner)) {
    if (command.state !== 'pending') throw new Error('Resolve the earlier rejected/conflicting change before syncing later commands.');
    let writeAccepted = false;
    try {
      const receipt = await request<Record<string, unknown>>(session, command.path, command.method, command.body);
      writeAccepted = true;
      const membership = command.method === 'POST' && [
        `/groups/${command.group_id}/leave`, `/groups/${command.group_id}/restore`,
      ].includes(command.path);
      if (membership) {
        if (receipt.id !== command.group_id || !Number.isSafeInteger(receipt.version)
          || !(command.path.endsWith('/restore') ? receipt.disposition === 'restored' : ['left', 'hidden'].includes(String(receipt.disposition)))) {
          throw new Error('The membership update could not be confirmed. Try again.');
        }
        await refreshGroups(db, session, mode, { commandId: command.command_id, receipt: receipt as MembershipReceipt });
      } else {
        const group = await fetchGroup(session, command.group_id, mode);
        await acceptCommand(db, owner, command.command_id, group);
      }
      receipts.push(receipt);
      if (command.command_id === stopAfterCommandId) break;
    } catch (error) {
      if (!writeAccepted && error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429) {
        await markCommand(db, owner, command.command_id, error.status === 409 ? 'conflict' : 'rejected', error.message);
      }
      throw error;
    }
  }
  return receipts;
}

export async function fetchGroup(session: Session, id: string, mode: 'full' | 'summary' = 'summary'): Promise<Group> {
  const group = await request<Group>(session, `/groups/${encodeURIComponent(id)}${mode === 'summary' ? '/summary' : ''}`);
  if (mode === 'summary' && (group.read_mode !== 'summary' || !group.history || !group.totals)) throw new Error('Could not load the complete group balance. Try again.');
  return group;
}

// The complete authorized index is the pruning boundary. Changed groups still
// use complete snapshots; unchanged first-page windows need no extra GET or write.
export async function refreshGroups(db: Database, session: Session, mode: 'full' | 'summary' = 'full', acceptedMembership?: AcceptedMembership): Promise<string[]> {
  const owner = accountOwner(session), index = await request<{ groups: { id: string; version: number; hidden?: boolean }[] }>(session, '/groups');
  if (!Array.isArray(index.groups) || new Set(index.groups.map(row => row.id)).size !== index.groups.length || index.groups.some(row => !row.id || !Number.isSafeInteger(row.version) || (row.hidden !== undefined && typeof row.hidden !== 'boolean'))) throw new Error('The group refresh was incomplete. Try again.');
  const snapshots: Group[] = [];
  const complete = (group: Group | undefined): group is Group => !!group && Array.isArray(group.participants) && Array.isArray(group.expenses) && Array.isArray(group.settlements) && Array.isArray(group.transfers) && Array.isArray(group.activity) && !!group.balances;
  const withVisibility = (group: Group, hidden: boolean): Group => !!group.hidden === hidden ? group : { ...group, hidden };
  for (const row of index.groups) {
    const cached = await (mode === 'summary' ? readVisibleGroup : readGroup)(db, owner, row.id);
    // An older or filtered browsing page is not the unfiltered first page.
    if (cached?.kind === 'shared' && complete(cached.group) && cached.group.id === row.id && cached.group.version === row.version && (mode === 'summary' ? cached.group.read_mode === 'summary' && Array.isArray(cached.group.transactions) && !!cached.group.history?.transactions && !cached.group.history.transactions.cursor && !cached.group.history.transactions.query && cached.group.participants.every(person => typeof person.recorded_name === 'string') : !cached.group.read_mode)) snapshots.push(withVisibility(cached.group, row.hidden === true));
    else {
      const group = await fetchGroup(session, row.id, mode);
      if (!complete(group) || group.id !== row.id || group.version < row.version) throw new Error('The group refresh was incomplete. Try again.');
      snapshots.push(withVisibility(group, row.hidden === true));
    }
  }
  return reconcileGroupCache(db, owner, snapshots, acceptedMembership);
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
      if (expense.deleted) append('POST', `/groups/${groupId}/expenses/${expense.id}/reverse`, { version: 1 });
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
