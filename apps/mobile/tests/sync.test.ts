import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { accountOwner, ApiError, requestEmailCode, confirmEmailCode, request, syncOutbox, refreshGroups } from '../src/api.ts';
import { migrate, enqueue, pendingCommands, readGroup, saveGroup, replaceCommand, listGroups } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Command, Group, Session } from '../src/types.ts';

const session: Session = { token: 'synthetic-token', userId: '1', email: 'synthetic@example.invalid', baseUrl: 'https://example.invalid' };
const owner = accountOwner(session);
const group: Group = { id: 'g', name: 'Trip', version: 0, participants: [], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
const command: Command = { command_id: 'c', group_id: 'g', method: 'POST', path: '/groups', body: { command_id: 'c', id: 'g' }, state: 'pending', error: null };

test('an older background index cannot prune a concurrently accepted group but still removes unchanged revoked access', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(yes => { release = yes; }), fetching = new Promise<void>(yes => { started = yes; });
  globalThis.fetch = async () => { started(); await gate; return Response.json({ groups: [] }); };
  let job: Promise<unknown> | undefined;
  try {
    await migrate(db); await saveGroup(db, owner, { ...group, id: 'revoked', version: 1 }, 'shared');
    job = refreshGroups(db, session); await fetching;
    await saveGroup(db, owner, { ...group, id: 'newly-accepted', version: 1 }, 'shared');
    release(); await job;
    assert.deepEqual((await listGroups(db, owner)).map(row => row.group.id), ['newly-accepted']);
  } finally { release(); await job?.catch(() => {}); globalThis.fetch = original; raw.close(); }
});

for (const conflict of [false, true]) test(`overlapping background and action drains stay ordered${conflict ? ' and hold dependent work after409' : ''}`, async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), posts: string[] = [];
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(yes => { release = yes; }), firstPost = new Promise<void>(yes => { started = yes; });
  const jobs: Promise<unknown>[] = [];
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      const id = JSON.parse(String(options.body)).command_id; posts.push(id);
      if (id === 'c') { started(); await gate; }
      if (conflict) return Response.json({ detail: 'Accepted revision changed.' }, { status: 409 });
      return Response.json({ id: 'g', command_id: id, version: id === 'c' ? 1 : 2 });
    }
    return Response.json({ ...group, version: 2 });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await enqueue(db, owner, command);
    const first = syncOutbox(db, session); jobs.push(first); await firstPost;
    await enqueue(db, owner, { ...command, command_id: 'later', body: { command_id: 'later', id: 'later' } });
    const later = syncOutbox(db, session); jobs.push(later);
    // Both callers have had a chance to enter the real SQLite/request path.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.deepEqual(posts, ['c'], 'no concurrent duplicate HTTP replay'); release();
    if (conflict) {
      await assert.rejects(first, /Accepted revision/); await assert.rejects(later, /Resolve/);
      const kept = await pendingCommands(db, owner);
      assert.deepEqual(kept.map(row => [row.command_id, row.state, !!row.attempted]), [['c', 'conflict', true], ['later', 'pending', false]]);
      assert.deepEqual(posts, ['c']);
    } else {
      assert.deepEqual((await first).map(row => row.command_id), ['c']);
      assert.deepEqual((await later).map(row => row.command_id), ['later']);
      assert.deepEqual(posts, ['c', 'later']); assert.equal((await pendingCommands(db, owner)).length, 0);
    }
  } finally { release(); await Promise.allSettled(jobs); globalThis.fetch = original; raw.close(); }
});

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

test('a conflicting bill edit survives restart unchanged and blocks later work until explicit review', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bill-conflict-')), original = globalThis.fetch;
  let raw = new DatabaseSync(join(directory, 'cache.sqlite')), db = sqliteAdapter(raw), reviewed = false;
  const edit: Command = { ...command, command_id: 'edit', method: 'PUT', path: '/groups/g/expenses/bill', body: { command_id: 'edit', id: 'bill', version: 1, description: 'My saved edit', total: '2000', notes: 'Keep my notes' } };
  const latest = { ...group, version: 3, expenses: [{ id: 'bill', version: 2, description: 'Reuben latest' }] };
  const calls: string[] = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url).split('/api/v1')[1]; calls.push(`${options?.method ?? 'GET'} ${path}`);
    if (options?.method === 'PUT') return reviewed ? Response.json({ id: 'bill', version: 3 }) : Response.json({ detail: 'Expense changed; fetch the current revision before retrying' }, { status: 409 });
    if (path === edit.path) return Response.json(latest.expenses[0]);
    if (options?.method === 'POST') return Response.json({ id: 'g', version: 3 });
    return Response.json(latest);
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await enqueue(db, owner, edit);
    await enqueue(db, owner, { ...command, command_id: 'later', body: { command_id: 'later' } });
    await enqueue(db, 'other-account', edit);
    await assert.rejects(syncOutbox(db, session), /Expense changed/);
    raw.close(); raw = new DatabaseSync(join(directory, 'cache.sqlite')); db = sqliteAdapter(raw); await migrate(db);
    const saved = await pendingCommands(db, owner);
    assert.equal(saved[0].state, 'conflict'); assert.equal(saved[0].command_id, edit.command_id); assert.deepEqual(saved[0].body, edit.body);
    assert.deepEqual(saved.map(row => row.command_id), ['edit', 'later']);
    assert.deepEqual((await pendingCommands(db, 'other-account'))[0].body, edit.body);
    assert.deepEqual((await readGroup(db, owner, 'g'))?.group, group, 'a rejected edit cannot replace accepted cache');
    assert.deepEqual(calls, ['PUT /groups/g/expenses/bill']);
    await assert.rejects(syncOutbox(db, session), /Resolve/);
    assert.deepEqual(calls, ['PUT /groups/g/expenses/bill'], 'existing conflicts never silently replay or acknowledge');
    const replacement = { ...edit, command_id: 'reviewed-edit', body: { ...edit.body, command_id: 'reviewed-edit', version: 2 } };
    await replaceCommand(db, owner, edit.command_id, replacement); reviewed = true;
    await syncOutbox(db, session);
    assert.equal((await pendingCommands(db, owner)).length, 0);
    assert.ok(calls.includes('POST /groups'), 'later work continues only after explicit review');
    assert.equal((await pendingCommands(db, 'other-account')).length, 1);
  } finally { globalThis.fetch = original; raw.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a failed canonical read after an accepted bill write keeps the same command pending for retry', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  globalThis.fetch = async (_url, options) => options?.method === 'PUT'
    ? Response.json({ id: 'bill', version: 2 }) : Response.json({ detail: 'Unavailable' }, { status: 503 });
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    await enqueue(db, owner, { ...command, method: 'PUT', path: '/groups/g/expenses/bill', body: { command_id: 'c', version: 1 } });
    await assert.rejects(syncOutbox(db, session), /Unavailable/);
    assert.equal((await pendingCommands(db, owner))[0].state, 'pending');
    assert.deepEqual((await pendingCommands(db, owner))[0].body, { command_id: 'c', version: 1 });
  } finally { globalThis.fetch = original; raw.close(); }
});
