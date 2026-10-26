import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accountOwner, ApiError, requestEmailCode, confirmEmailCode, request, syncOutbox } from '../src/api.ts';
import { migrate, enqueue, pendingCommands, readGroup, saveGroup, replaceCommand } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Command, Group, Session } from '../src/types.ts';

const session: Session = { token: 'synthetic-token', userId: '1', email: 'synthetic@example.invalid', baseUrl: 'https://example.invalid' };
const owner = accountOwner(session);
const group: Group = { id: 'g', name: 'Trip', version: 0, participants: [], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
const command: Command = { command_id: 'c', group_id: 'g', method: 'POST', path: '/groups', body: { command_id: 'c', id: 'g' }, state: 'pending', error: null };

test('Lost responses retry the same command, conflicts remain durable and accounts stay isolated', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  const writes: string[] = [];
  let loseResponse = true, conflict = false, denySnapshot = false;
  globalThis.fetch = async (url, options) => {
    assert.equal((options?.headers as Record<string, string>)['X-Session-Token'], session.token);
    if (options?.method === 'POST') {
      writes.push(String(options.body));
      if (conflict) return Response.json({ error: 'conflict', detail: 'Accepted revision changed.' }, { status: 409 });
      if (loseResponse) { loseResponse = false; throw new TypeError('Response lost after commit'); }
      return Response.json({ id: 'g', version: 1 });
    }
    assert.equal(String(url), `${session.baseUrl}/api/v1/groups/g`);
    return denySnapshot ? Response.json({ detail: 'Snapshot unavailable' }, { status: 403 }) : Response.json({ ...group, version: 1 });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    await enqueue(db, owner, command); await enqueue(db, 'different-account', { ...command, command_id: 'other' });
    await assert.rejects(syncOutbox(db, session), /Could not connect/);
    assert.equal((await pendingCommands(db, owner))[0].state, 'pending');
    await syncOutbox(db, session);
    assert.equal(writes[0], writes[1]);
    assert.equal((await pendingCommands(db, owner)).length, 0);
    assert.equal((await pendingCommands(db, 'different-account')).length, 1);
    assert.equal((await readGroup(db, owner, 'g'))?.group.version, 1);
    await enqueue(db, owner, { ...command, command_id: 'conflict', body: { command_id: 'conflict' } }); conflict = true;
    await assert.rejects(syncOutbox(db, session), /Accepted revision/);
    assert.equal((await pendingCommands(db, owner))[0].state, 'conflict');
    const before = writes.length;
    await assert.rejects(syncOutbox(db, session), /Resolve/); assert.equal(writes.length, before);
    const replacement = { ...command, command_id: 'reviewed', body: { command_id: 'reviewed', version: 2 } };
    await replaceCommand(db, owner, 'conflict', replacement); conflict = false; denySnapshot = true;
    await assert.rejects(syncOutbox(db, session), /Snapshot unavailable/);
    assert.equal((await pendingCommands(db, owner))[0].state, 'pending', 'a failed read cannot classify an accepted write as rejected');
    denySnapshot = false; await syncOutbox(db, session);
    assert.equal((await pendingCommands(db, owner)).length, 0);
  } finally { globalThis.fetch = original; raw.close(); }
});

test('Native auth uses allauth response and an account/backend ownership key', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/code/request')) {
      assert.deepEqual(JSON.parse(String(options?.body)), { email: 'person@example.invalid', email_reminders_disclosed: false });
      return Response.json({ meta: { session_token: 'pre-auth' }, data: { challenge_id: 'synthetic-challenge', expires_in: 180, retry_after: 60 } });
    }
    assert.equal(String(url), 'https://example.invalid/_allauth/app/v1/auth/code/confirm');
    assert.deepEqual(JSON.parse(String(options?.body)), { challenge_id: 'synthetic-challenge', code: '0123', email_reminders_disclosed: false });
    assert.equal((options?.headers as Record<string, string>)['X-Session-Token'], 'pre-auth');
    return Response.json({ meta: { session_token: 'test-session', is_authenticated: true }, data: { user: { id: 17, email: 'person@example.invalid' } } });
  };
  try {
    const challenge = await requestEmailCode('https://example.invalid/', 'person@example.invalid');
    const result = await confirmEmailCode('https://example.invalid/', challenge.challengeId, '0123');
    assert.equal(result.userId, '17'); assert.equal(result.token, 'test-session');
    assert.notEqual(accountOwner(result), accountOwner({ ...result, baseUrl: 'https://other.invalid' }));
  } finally { globalThis.fetch = original; }
});

test('Connection failures hide native diagnostics while HTTP conflicts keep their status', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('java.net.UnknownHostException: private.host.internal'); };
    for (const action of [() => request(session, '/groups'), () => requestEmailCode(session.baseUrl, session.email)]) {
      await assert.rejects(action(), error => error instanceof Error && /Could not connect/.test(error.message) && !/java\.net|private\.host/.test(error.message));
    }
    globalThis.fetch = async () => Response.json({ detail: 'Accepted revision changed.' }, { status: 409 });
    await assert.rejects(request(session, '/groups/g'), error => error instanceof ApiError && error.status === 409 && error.message === 'Accepted revision changed.');
  } finally { globalThis.fetch = original; }
});

test('a newer accepted bill replaces a stale offline edit automatically and later commands continue', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  const edit: Command = { ...command, command_id: 'edit', method: 'PUT', path: '/groups/g/expenses/bill', body: { command_id: 'edit', id: 'bill', version: 1 } };
  const latest = { ...group, version: 3, expenses: [{ id: 'bill', version: 2, description: 'Reuben latest' }] };
  const calls: string[] = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url).split('/api/v1')[1]; calls.push(`${options?.method ?? 'GET'} ${path}`);
    if (options?.method === 'PUT') return Response.json({ detail: 'Expense changed; fetch the current revision before retrying' }, { status: 409 });
    if (path === edit.path) return Response.json(latest.expenses[0]);
    if (options?.method === 'POST') return Response.json({ id: 'g', version: 3 });
    return Response.json(latest);
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await enqueue(db, owner, edit);
    await enqueue(db, owner, { ...command, command_id: 'later', body: { command_id: 'later' } });
    await syncOutbox(db, session);
    assert.equal((await pendingCommands(db, owner)).length, 0);
    assert.equal((await readGroup(db, owner, 'g'))?.group.expenses[0].description, 'Reuben latest');
    assert.equal(calls.filter(value => value.startsWith('PUT')).length, 1, 'never overwrite the newer server edit');
    assert.ok(calls.includes('POST /groups'), 'later work is not blocked');
    await enqueue(db, owner, { ...edit, command_id: 'old-conflict', state: 'conflict' });
    await syncOutbox(db, session);
    assert.equal((await pendingCommands(db, owner)).length, 0, 'existing conflict queues also recover automatically');
  } finally { globalThis.fetch = original; raw.close(); }
});

test('a failed canonical read keeps the stale bill queued for automatic retry', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  globalThis.fetch = async (_url, options) => options?.method === 'PUT'
    ? Response.json({ detail: 'Expense changed' }, { status: 409 }) : Response.json({ detail: 'Unavailable' }, { status: 503 });
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    await enqueue(db, owner, { ...command, method: 'PUT', path: '/groups/g/expenses/bill', body: { command_id: 'c', version: 1 } });
    await assert.rejects(syncOutbox(db, session), /Unavailable/);
    assert.equal((await pendingCommands(db, owner))[0].state, 'pending');
  } finally { globalThis.fetch = original; raw.close(); }
});
