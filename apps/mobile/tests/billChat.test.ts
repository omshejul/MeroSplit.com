import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountOwner, ApiError, request } from '../src/api.ts';
import { changeChatWork, chatPath, editRejectedChat, flushChatWrites, mergeChatMessages, queueChatMessage, readChatWork, sendChatMessage, startChatReads, visibleChatTokens } from '../src/billChat.ts';
import type { ChatMessage, ChatPage } from '../src/billChat.ts';
import { migrate, pendingCommands, wipeAccount } from '../src/storage.ts';
import { notificationTarget, dismissReadPushes } from '../src/notifications.ts';
import { parseNativeLink, APP_ORIGIN } from '../src/appLinks.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Session } from '../src/types.ts';

const session: Session = { baseUrl: 'https://example.test', userId: '1', email: 'qa@example.test', token: 'synthetic' };
const path = chatPath('group', 'bill');
const message = (id = '1', client_id = 'client'): ChatMessage => ({ id, client_id, sender_id: '1', sender: 'Asha', text: 'Synthetic text', hidden: false, created_at: '2026-10-19T10:00:00Z', seen_token: `seen-${id}` });
const page = (messages: ChatMessage[], after_cursor = 'after', older_cursor: string | null = null): ChatPage => ({ messages, after_cursor, older_cursor, has_more_newer: false, removed_ids: [], unread: 0, can_send: true, policy_accepted: true, policy_version: 1, blocked_users: [] });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('Immutable pending send survives restart and lost accepted response, with one message on the server', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-chat-')), filename = join(folder, 'app.db');
  let raw = new DatabaseSync(filename), db = sqliteAdapter(raw), calls = 0;
  const accepted = new Map<string, ChatMessage>();
  const send: typeof request = async <T>(active: Session, endpoint: string, method = 'GET', body?: any): Promise<T> => {
    assert.equal(accountOwner(active), accountOwner(session)); assert.equal(endpoint, path); assert.equal(method, 'POST');
    assert.equal((await readChatWork(db, session, path)).pending[0].id, body.client_id, 'Persist before HTTP');
    accepted.set(body.client_id, { ...message('1', body.client_id), text: body.text }); calls++;
    if (calls === 1) throw Error('Lost accepted response');
    return accepted.get(body.client_id) as T;
  };
  try {
    await migrate(db); await changeChatWork(db, session, path, value => ({ ...value, draft: 'Synthetic text' }));
    await queueChatMessage(db, session, path, 'client', 'Synthetic text');
    await assert.rejects(sendChatMessage(db, session, path, 'client', send), /Lost accepted/);
    raw.close(); raw = new DatabaseSync(filename); db = sqliteAdapter(raw);
    assert.equal((await readChatWork(db, session, path)).pending[0].text, 'Synthetic text');
    assert.equal((await sendChatMessage(db, session, path, 'client', send)).id, '1');
    assert.deepEqual(await readChatWork(db, session, path), { draft: '', pending: [] });
    assert.equal(accepted.size, 1); assert.equal(calls, 2);
    assert.deepEqual(await pendingCommands(db, accountOwner(session)), []);
  } finally { await flushChatWrites(); raw.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('Typing during send, account switch and bill switch never overwrite each other', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), other = { ...session, userId: '2' };
  let finish!: (value: ChatMessage) => void;
  try {
    await migrate(db); await queueChatMessage(db, session, path, 'client', 'Synthetic text');
    const waiting = sendChatMessage(db, session, path, 'client', async <T>() => new Promise<ChatMessage>(resolve => { finish = resolve; }) as Promise<T>);
    await tick();
    await Promise.all([
      changeChatWork(db, session, path, work => ({ ...work, draft: 'New typing' })),
      changeChatWork(db, other, path, work => ({ ...work, draft: 'Other account' })),
      changeChatWork(db, session, chatPath('group', 'second'), work => ({ ...work, draft: 'Other bill' })),
    ]);
    finish(message()); await waiting;
    assert.deepEqual(await readChatWork(db, session, path), { draft: 'New typing', pending: [] });
    assert.equal((await readChatWork(db, other, path)).draft, 'Other account');
    assert.equal((await readChatWork(db, session, chatPath('group', 'second'))).draft, 'Other bill');
    await wipeAccount(db, accountOwner(session)); assert.equal((await readChatWork(db, other, path)).draft, 'Other account');
  } finally { await flushChatWrites(); raw.close(); }
});

test('Policy/filter rejection retains text and permits explicit editing; unknown outcomes keep immutable IDs', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await queueChatMessage(db, session, path, 'client', 'Synthetic text');
    await assert.rejects(sendChatMessage(db, session, path, 'client', async () => { throw new ApiError(503, 'Unknown outcome'); }));
    assert.equal((await readChatWork(db, session, path)).pending[0].rejected, false);
    await assert.rejects(editRejectedChat(db, session, path, 'client'));
    await assert.rejects(sendChatMessage(db, session, path, 'client', async () => { throw new ApiError(422, 'Policy filter rejection'); }));
    const edited = await editRejectedChat(db, session, path, 'client');
    assert.deepEqual(edited, { draft: 'Synthetic text', pending: [] });
    await assert.rejects(queueChatMessage(db, session, path, 'empty', '  '));
    assert.equal((await readChatWork(db, session, path)).draft, 'Synthetic text');
  } finally { await flushChatWrites(); raw.close(); }
});

test('Replay dedup uses stable server order including large IDs and removes hidden/blocked known rows', () => {
  const first = message('9007199254740992'), next = message('9007199254740993', 'other');
  const merged = mergeChatMessages([next], [first, next]); assert.deepEqual(merged.map(row => row.id), [first.id, next.id]);
  assert.deepEqual(mergeChatMessages(merged, [], [first.id]), [next]);
  assert.deepEqual(visibleChatTokens(merged, [first.id], true), [first.seen_token]);
  assert.deepEqual(visibleChatTokens(merged, [first.id], false), []);
  assert.deepEqual(visibleChatTokens(merged, [], true), []);
});

function timerFixture() {
  let next = 0; const pending = new Map<number, { fn: () => void; ms: number }>();
  return { pending, timers: { set: (fn: () => void, ms: number) => { pending.set(++next, { fn, ms }); return next as any; }, clear: (id: any) => { pending.delete(Number(id)); } },
    fire: () => { const [id, timer] = pending.entries().next().value!; pending.delete(id); timer.fn(); } };
}

test('Foreground reader is single-flight, incremental, separately paginated, and aborts without late UI changes', async () => {
  const timer = timerFixture(), calls: { url: string; signal: AbortSignal; resolve: (page: ChatPage) => void }[] = [], received: ChatPage[] = [];
  const send: typeof request = async <T>(_active: Session, url: string, _method = 'GET', _body?: unknown, _response?: 'json' | 'text', signal?: AbortSignal): Promise<T> => new Promise(resolve => calls.push({ url, signal: signal!, resolve: value => resolve(value as T) }));
  const reader = startChatReads(session, path, () => ['1'], value => received.push(value), () => {}, send, timer.timers);
  reader.refresh(); reader.refresh(); await tick(); assert.equal(calls.length, 1);
  calls[0].resolve(page([message()], 'after1', 'before1')); await tick();
  assert.equal(timer.pending.size, 1); timer.fire(); await tick(); assert.equal(calls.length, 2);
  assert.equal(new URL('https://example.test' + calls[1].url).searchParams.get('after'), 'after1');
  calls[1].resolve(page([message('2')], 'after2')); await tick();
  const older = reader.older(); await tick(); assert.equal(calls.length, 3);
  assert.equal(new URL('https://example.test' + calls[2].url).searchParams.get('before'), 'before1');
  calls[2].resolve(page([message('0')], 'old-after', null)); await older;
  timer.fire(); await tick();
  assert.equal(new URL('https://example.test' + calls[3].url).searchParams.get('after'), 'after2');
  reader.stop(); assert.equal(calls[3].signal.aborted, true); calls[3].resolve(page([message('3')])); await tick();
  assert.equal(received.length, 3); assert.equal(timer.pending.size, 0);
});

test('Reader backs off to a bounded interval, pauses fully, and resumes with a new read', async () => {
  const timer = timerFixture(), errors: unknown[] = []; let calls = 0;
  const send: typeof request = async () => { calls++; throw Error('Offline'); };
  const reader = startChatReads(session, path, () => [], () => {}, error => errors.push(error), send, timer.timers);
  await tick(); assert.equal([...timer.pending.values()][0].ms, 10_000);
  for (let i = 0; i < 5; i++) { timer.fire(); await tick(); }
  assert.equal([...timer.pending.values()][0].ms, 60_000); assert.equal(calls, 6);
  reader.stop(); assert.equal(timer.pending.size, 0);
  const resumed = startChatReads(session, path, () => [], () => {}, () => {}, send, timer.timers); await tick(); assert.equal(calls, 7); resumed.stop();
});

test('A revoked conversation stops retries and does not fetch another page', async () => {
  const timer = timerFixture(); let calls = 0;
  const reader = startChatReads(session, path, () => [], () => {}, () => {}, async () => { calls++; throw new ApiError(404, 'No access'); }, timer.timers);
  await tick(); reader.refresh(); await tick(); assert.equal(calls, 1); assert.equal(timer.pending.size, 0); reader.stop();
});

test('Chat deeplink lands in exact conversation without accepting untrusted URL variants', () => {
  const group = 'd2c160d0-847c-4ea1-b4f7-60d06d5994c6', bill = '13dc400e-268e-4ab3-a905-08b357ca7850';
  assert.deepEqual(parseNativeLink(`${APP_ORIGIN}/app/groups/${group}/bills/${bill}/chat`), { kind: 'app', target: { groupId: group, expenseId: bill, chat: true } });
  assert.equal(parseNativeLink(`${APP_ORIGIN}/app/groups/${group}/chat`), null);
  assert.equal(parseNativeLink(`${APP_ORIGIN}.evil.test/app/groups/${group}/bills/${bill}/chat`), null);
});

test('Chat notification reconciliation never uses financial seen status or acknowledges merely displayed pushes', async () => {
  const group = 'd2c160d0-847c-4ea1-b4f7-60d06d5994c6', bill = '13dc400e-268e-4ab3-a905-08b357ca7850', event = '4b8f5680-c7c4-45ec-8a2f-842fb5854090';
  const data = { type: 'bill_chat', group_id: group, expense_id: bill, event_id: event, recipient_user_id: session.userId };
  const paths: string[] = [], dismissed: string[] = [];
  const send: typeof request = async <T>(_session: Session, path: string): Promise<T> => { paths.push(path); return { notices: [{ id: event }] } as T; };
  await dismissReadPushes(session, [{ identifier: 'chat', data }], async id => { dismissed.push(id); }, send);
  assert.ok(paths[0].startsWith('/me/chat-notifications?notice_ids=')); assert.deepEqual(dismissed, []);
  const target = await notificationTarget(session, data, async <T>() => ({ id: group, expenses: [{ id: bill, deleted: true }] }) as T);
  assert.equal(target?.expenseId, bill); assert.equal(target?.chat, true);
});


test('Account cleanup waits for an already-started send before wiping its saved text', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); let finish!: (row: ChatMessage) => void, wiped = false;
  try {
    await migrate(db); await queueChatMessage(db, session, path, 'client', 'Synthetic text');
    const sending = sendChatMessage(db, session, path, 'client', async <T>() => new Promise<ChatMessage>(resolve => { finish = resolve; }) as Promise<T>);
    await tick();
    const deleting = flushChatWrites().then(async () => { await wipeAccount(db, accountOwner(session)); wiped = true; });
    await tick(); assert.equal(wiped, false);
    finish(message()); await sending; await deleting;
    assert.equal(wiped, true); assert.equal(await db.getFirstAsync('SELECT body FROM drafts WHERE owner=?', accountOwner(session)), null);
  } finally { raw.close(); }
});
