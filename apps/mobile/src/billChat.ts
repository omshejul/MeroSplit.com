import { accountOwner, ApiError, request } from './api.ts';
import { readDraft, saveDraft } from './storage.ts';
import type { Database } from './storage.ts';
import type { Session } from './types.ts';

export type ChatMessage = { id: string; client_id: string; sender_id: string; sender: string; text: string; hidden: boolean; created_at: string; seen_token: string };
export type ChatPage = { messages: ChatMessage[]; older_cursor: string | null; after_cursor: string; has_more_newer: boolean; removed_ids: string[]; unread: number; can_send: boolean; policy_accepted: boolean; policy_version: number; blocked_users: { id: string; name: string }[] };
export type PendingMessage = { id: string; text: string; error?: string; rejected?: boolean };
export type ChatWork = { draft: string; pending: PendingMessage[] };
export const chatPath = (group: string, bill: string) => `/groups/${encodeURIComponent(group)}/expenses/${encodeURIComponent(bill)}/chat`;
const key = (path: string) => `chat:${path}`;
let writes = Promise.resolve();
const sends = new Set<Promise<void>>();
const failedWrites = new Map<string, Set<string>>();
export async function flushChatWrites(owner?: string): Promise<void> {
  await Promise.allSettled([...sends]); await writes;
  if (owner && failedWrites.get(owner)?.size) throw Error('Save your chat work before restarting.');
}
async function storedChatWork(db: Database, owner: string, path: string): Promise<ChatWork> {
  const value = await readDraft<ChatWork>(db, owner, key(path)) ?? { draft: '', pending: [] };
  if (typeof value.draft !== 'string' || value.draft.length > 2000 || !Array.isArray(value.pending) || value.pending.length > 20
    || value.pending.some(row => !row || typeof row.id !== 'string' || typeof row.text !== 'string' || row.text.length > 2000)) throw Error('Could not read saved chat work. Export Saved work before clearing app data.');
  return value;
}
export async function readChatWork(db: Database, session: Session, path: string): Promise<ChatWork> {
  await writes;
  return storedChatWork(db, accountOwner(session), path);
}
// One short transaction always reads the latest draft. A send result cannot erase
// new typing, another pending message, or another account's work.
export function changeChatWork(db: Database, session: Session, path: string, update: (work: ChatWork) => ChatWork): Promise<ChatWork> {
  const scope = accountOwner(session);
  const job = writes.then(async () => {
    let result: ChatWork = { draft: '', pending: [] };
    await db.withExclusiveTransactionAsync(async tx => {
      const previous = await storedChatWork(tx, scope, path);
      result = update(previous);
      if (result.draft || result.pending.length) await saveDraft(tx, scope, key(path), result);
      else await tx.runAsync('DELETE FROM drafts WHERE owner=? AND group_id=?', scope, key(path));
    });
    return result;
  });
  writes = job.then(() => { failedWrites.get(scope)?.delete(path); }, () => {
    const paths = failedWrites.get(scope) ?? new Set<string>();
    paths.add(path); failedWrites.set(scope, paths);
  });
  return job;
}
export function queueChatMessage(db: Database, session: Session, path: string, id: string, text: string): Promise<ChatWork> {
  return changeChatWork(db, session, path, work => {
    if (!text.trim() || text.length > 2000) throw Error('Enter a message of up to 2,000 characters.');
    if (work.pending.length >= 20) throw Error('Retry the saved messages before adding more.');
    const existing = work.pending.find(row => row.id === id);
    if (existing && existing.text !== text) throw Error('This message ID is already used.');
    return { draft: work.draft === text ? '' : work.draft, pending: existing ? work.pending : [...work.pending, { id, text }] };
  });
}
export async function sendChatMessage(db: Database, session: Session, path: string, id: string, send: typeof request = request): Promise<ChatMessage> {
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; }); sends.add(waiting);
  try {
    const pending = (await readChatWork(db, session, path)).pending.find(row => row.id === id);
    if (!pending) throw Error('This message is no longer pending.');
    try {
      const accepted = await send<ChatMessage>(session, path, 'POST', { client_id: id, text: pending.text });
      if (accepted.client_id !== id || accepted.sender_id !== session.userId || (!accepted.hidden && accepted.text !== pending.text)) throw Error('Could not confirm this message. Retry it.');
      await changeChatWork(db, session, path, work => ({ ...work, pending: work.pending.filter(row => row.id !== id) }));
      return accepted;
    } catch (cause) {
      const rejected = cause instanceof ApiError && [409, 422].includes(cause.status);
      const error = cause instanceof Error ? cause.message : 'Could not confirm this message. Retry when online.';
      await changeChatWork(db, session, path, work => ({ ...work, pending: work.pending.map(row => row.id === id ? { ...row, error, rejected } : row) }));
      throw cause;
    }
  } finally { sends.delete(waiting); finish(); }
}
export function editRejectedChat(db: Database, session: Session, path: string, id: string): Promise<ChatWork> {
  return changeChatWork(db, session, path, work => {
    const row = work.pending.find(value => value.id === id);
    if (!row?.rejected || work.draft) throw Error('Finish your current draft before editing this message.');
    return { draft: row.text, pending: work.pending.filter(value => value.id !== id) };
  });
}
export function mergeChatMessages(previous: ChatMessage[], incoming: ChatMessage[], removed: string[] = []): ChatMessage[] {
  const hidden = new Set(removed), all = new Map(previous.map(row => [row.id, row]));
  incoming.forEach(row => all.set(row.id, row));
  return [...all.values()].filter(row => !row.hidden && !hidden.has(row.id)).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}
export function visibleChatTokens(messages: ChatMessage[], visibleIds: string[], active: boolean): string[] {
  if (!active) return [];
  const ids = new Set(visibleIds);
  return messages.filter(row => ids.has(row.id) && !row.hidden).slice(0, 50).map(row => row.seen_token);
}

// One active read and one timer. Stopping aborts HTTP and prevents late results.
// The older cursor is independent of the incremental cursor, including while
// live messages arrive. A failed read does not advance either cursor.
export function startChatReads(session: Session, path: string, known: () => string[], onPage: (page: ChatPage, older: boolean) => void,
  onError: (error: unknown) => void, send: typeof request = request,
  timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) }) {
  let stopped = false, running = false, again = false, resetRequested = false, failures = 0, after: string | null = null, before: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
  function plan(delay: number) { if (!stopped) { if (timer) timers.clear(timer); timer = timers.set(() => void read(false), delay); } }
  async function read(older: boolean, signal?: AbortSignal): Promise<ChatPage | null> {
    if (stopped || signal?.aborted) return null;
    if (running) { if (!older) again = true; return null; }
    if (older && !before) return null;
    if (timer) timers.clear(timer);
    if (resetRequested) { after = null; before = null; resetRequested = false; }
    running = true; controller = new AbortController();
    const activeController = controller, abort = () => activeController.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (older && before) params.set('before', before); else if (after) params.set('after', after);
      const visible = known().slice(0, 50); if (visible.length) params.set('known', visible.join(','));
      const page = await send<ChatPage>(session, `${path}?${params}`, 'GET', undefined, 'json', controller.signal);
      if (stopped || signal?.aborted) return null;
      failures = 0;
      if (older || !after) before = page.older_cursor;
      if (!older) after = page.after_cursor;
      onPage({ ...page, older_cursor: before }, older);
      return page;
    } catch (error) {
      if (stopped || signal?.aborted) return null;
      failures = Math.min(failures + 1, 4); onError(error);
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) { stopped = true; if (older) throw error; return null; }
      if (older) throw error;
      return null;
    } finally {
      signal?.removeEventListener('abort', abort);
      running = false;
      if (!stopped) { const delay = again ? 100 : Math.min(60_000, 5_000 * 2 ** failures); again = false; plan(delay); }
    }
  }
  void read(false);
  return { refresh: (reset = false) => { if (reset) resetRequested = true; void read(false); }, older: (signal?: AbortSignal) => read(true, signal), stop: () => { stopped = true; if (timer) timers.clear(timer); controller?.abort(); }, hasOlder: () => !!before };
}
