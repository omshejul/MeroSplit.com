import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accountRequestsPaused, pauseAccountRequests, resumeAccountRequests } from '../src/accountRequests.ts';
import { sessionRequest } from '../src/transport.ts';
import { accountOwner, syncOutbox } from '../src/api.ts';
import { migrate, enqueue, pendingCommands, readDraft, saveDraft, saveGroup, readVisibleGroup } from '../src/storage.ts';
import { createPaymentReturn } from '../src/paymentReturn.ts';
import { listPaymentReturns, savePaymentReturn } from '../src/paymentReturnStorage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Group, Session } from '../src/types.ts';

const old: Session = { baseUrl: 'https://merosplit.test', userId: '1', email: 'one@example.invalid', token: 'synthetic-one' };
const next: Session = { ...old, userId: '2', email: 'two@example.invalid', token: 'synthetic-two' };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('native account transition blocks both identities and drains old headers without buffering response bodies', async () => {
  const reply = deferred<Response>();
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => { calls.push(new Headers(init?.headers).get('X-Session-Token')!); return reply.promise; };
  try {
    const sending = sessionRequest(old, '/api/v1/groups', { method: 'POST' }, fetcher);
    let drained = false;
    const pausing = pauseAccountRequests().then(() => { drained = true; });
    assert.equal(accountRequestsPaused(), true);
    for (const identity of [old, next]) await assert.rejects(sessionRequest(identity, '/api/v1/groups', {}, fetcher), /Signing in/);
    assert.deepEqual(calls, [old.token]); assert.equal(drained, false);
    const body = new ReadableStream({ start() {} });
    reply.resolve(new Response(body));
    const response = await sending; await pausing;
    assert.equal(drained, true); assert.equal(response.bodyUsed, false);
    await response.body?.cancel();
    resumeAccountRequests();
    await sessionRequest(next, '/api/v1/me', {}, async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('X-Session-Token'), next.token);
      return Response.json({ id: 2 });
    });
  } finally { resumeAccountRequests(); }
});

test('failed native fetch also drains so an offline previous account cannot deadlock incoming sign-in', async () => {
  const reply = deferred<Response>();
  try {
    const request = sessionRequest(old, '/api/v1/me', {}, () => reply.promise);
    const failed = assert.rejects(request, /offline/), drain = pauseAccountRequests();
    reply.reject(new Error('offline')); await failed; await drain;
    assert.equal(accountRequestsPaused(), true);
  } finally { resumeAccountRequests(); }
});

test('account switching preserves exact SQLite draft, pending command and frozen payment decision under their old owner', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), originalFetch = globalThis.fetch;
  const owner = accountOwner(old), other = accountOwner(next);
  const group: Group = { id: 'retained-group', name: 'Retained', version: 7, participants: [], expenses: [], settlements: [], activity: [], balances: {}, transfers: [] };
  const draft = { description: 'Unsent only', total: '1200', paid: { one: '600', two: '600' }, split: { mode: 'exact', values: { one: '500', two: '700' } } };
  const reminder = { ...createPaymentReturn({ groupId: group.id, groupVersion: 7, attemptId: 'frozen-attempt', sender: 'one', recipient: 'two', amount: '100', payeeName: 'Frozen', vpa: 'frozen@invalid', yesCommandId: 'same-yes', noCommandId: 'same-no', settlementId: 'same-payment', date: '2026-10-18' }), decision: 'paid' as const };
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(new Headers(init?.headers).get('X-Session-Token')!); return Response.json({}); };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await saveDraft(db, owner, group.id, draft);
    await savePaymentReturn(db, owner, reminder);
    await enqueue(db, owner, { command_id: 'same-command', group_id: group.id, method: 'POST', path: `/groups/${group.id}/expenses`, body: { command_id: 'same-command', total: '1200' }, state: 'pending', error: null });
    const snapshot = async () => JSON.stringify({ draft: await readDraft(db, owner, group.id), reminder: await listPaymentReturns(db, owner), commands: await pendingCommands(db, owner), group: await readVisibleGroup(db, owner, group.id) });
    const before = await snapshot();
    await pauseAccountRequests();
    await assert.rejects(syncOutbox(db, old), /Could not connect/);
    assert.equal(calls.length, 0);
    resumeAccountRequests();
    await syncOutbox(db, next);
    assert.equal(await readDraft(db, other, group.id), null); assert.equal(await readVisibleGroup(db, other, group.id), null);
    assert.deepEqual(await listPaymentReturns(db, other), []); assert.deepEqual(await pendingCommands(db, other), []);
    assert.equal(calls.length, 0, 'the new identity never replays any previous-owner command');
    assert.equal(await snapshot(), before, 'returning to the old owner restores byte-identical decisions and IDs');
  } finally { resumeAccountRequests(); globalThis.fetch = originalFetch; raw.close(); }
});
