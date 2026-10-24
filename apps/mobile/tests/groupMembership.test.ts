import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountOwner, refreshGroups, syncOutbox } from '../src/api.ts';
import { changeGroupMembership } from '../src/groupMembership.ts';
import { enqueue, migrate, pendingCommands, readDraft, readGroup, reconcileGroupCache, saveDraft, saveGroup } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Command, Group, Session } from '../src/types.ts';

const session: Session = { token: 'synthetic-token', userId: '1', email: 'synthetic@example.invalid', baseUrl: 'https://example.invalid' };
const owner = accountOwner(session);
const group: Group = { id: 'g', name: 'Trip', version: 2, participants: [], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
const leave: Command = { command_id: 'leave-id', group_id: 'g', method: 'POST', path: '/groups/g/leave', body: { command_id: 'leave-id' }, state: 'pending', error: null };
const options = { isOnline: () => true, flushDrafts: async () => {}, uuid: () => 'leave-id' };

test('committed leave/lost reply survives SQLite restart, replays one immutable ID, never GETs departed group, preserves drafts and other accounts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'membership-')), original = globalThis.fetch;
  let raw = new DatabaseSync(join(directory, 'qa.sqlite')), db = sqliteAdapter(raw);
  const writes: string[] = [];
  let first = true;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(String(url), `${session.baseUrl}/api/v1/groups/g/leave`);
      writes.push(String(init.body));
      if (first) { first = false; throw new Error('Lost accepted reply'); }
      return Response.json({ id: 'g', version: 3, disposition: 'left' });
    }
    assert.equal(String(url), `${session.baseUrl}/api/v1/groups`);
    return Response.json({ groups: [] });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    await saveGroup(db, 'other-owner', group, 'shared');
    await enqueue(db, 'other-owner', leave);
    const draft = { description: 'Unsent', amount: '12.00', split: { a: '5', b: '7' } };
    await assert.rejects(changeGroupMembership(db, session, 'g', 'leave', { ...options, flushDrafts: () => saveDraft(db, owner, 'g', draft) }), /Could not connect/);
    raw.close(); raw = new DatabaseSync(join(directory, 'qa.sqlite')); db = sqliteAdapter(raw);
    const result = await changeGroupMembership(db, session, 'g', 'leave', { ...options, uuid: () => { throw new Error('Must reuse existing ID'); } });
    assert.equal(result.disposition, 'left'); assert.equal(writes.length, 2); assert.equal(writes[0], writes[1]);
    assert.deepEqual(await readDraft(db, owner, 'g'), draft);
    assert.equal((await readGroup(db, owner, 'g'))?.kind, 'unavailable');
    assert.equal((await pendingCommands(db, owner)).length, 0);
    assert.equal((await pendingCommands(db, 'other-owner')).length, 1);
    assert.equal((await readGroup(db, 'other-owner', 'g'))?.kind, 'shared');
  } finally { globalThis.fetch = original; raw.close(); rmSync(directory, { recursive: true }); }
});

test('accepted POST then incomplete index leaves command durable; successful replay prunes no-draft cache atomically', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  let badIndex = true, posts = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ id: 'g', version: 3, disposition: 'left' }); }
    assert.equal(String(url), `${session.baseUrl}/api/v1/groups`);
    return Response.json(badIndex ? {} : { groups: [] });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    await assert.rejects(changeGroupMembership(db, session, 'g', 'leave', options), /incomplete/);
    assert.equal((await pendingCommands(db, owner))[0].state, 'pending');
    assert.equal((await readGroup(db, owner, 'g'))?.kind, 'shared');
    badIndex = false;
    await changeGroupMembership(db, session, 'g', 'leave', options);
    assert.equal(posts, 2); assert.equal(await readGroup(db, owner, 'g'), null);
    assert.deepEqual(await pendingCommands(db, owner), []);
  } finally { globalThis.fetch = original; raw.close(); }
});

test('offline does not create a departure; prior queued changes and flushed drafts finish before leave', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), events: string[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url).split('/api/v1')[1]; events.push(path);
    if (path === '/groups/g/leave') return Response.json({ id: 'g', version: 4, disposition: 'left' });
    if (path === '/groups') return Response.json({ groups: [] });
    if (init?.method === 'PUT') return Response.json({ id: 'g', version: 3 });
    return Response.json({ ...group, version: 3, read_mode: 'summary', history: {}, totals: { spending: '0', paid: {}, shares: {} } });
  };
  try {
    await migrate(db);
    await assert.rejects(changeGroupMembership(db, session, 'g', 'leave', { ...options, isOnline: () => false }), /internet/);
    assert.deepEqual(await pendingCommands(db, owner), []); assert.equal(events.length, 0);
    await enqueue(db, owner, { ...leave, command_id: 'earlier', method: 'PUT', path: '/groups/g/expenses/e', body: { command_id: 'earlier' } });
    await changeGroupMembership(db, session, 'g', 'leave', { ...options, flushDrafts: async () => { events.push('draft-flushed'); } });
    assert.deepEqual(events, ['draft-flushed', '/groups/g/expenses/e', '/groups/g/summary', '/groups/g/leave', '/groups']);
  } finally { globalThis.fetch = original; raw.close(); }
});

test('same-version private hidden changes merge from complete index and restore with no finance mutation', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  let hidden = true, gets = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') { hidden = false; return Response.json({ id: 'g', version: 2, disposition: 'restored' }); }
    assert.equal(String(url), `${session.baseUrl}/api/v1/groups`); gets++;
    return Response.json({ groups: [{ id: 'g', version: 2, hidden }] });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    await refreshGroups(db, session);
    assert.deepEqual((await readGroup(db, owner, 'g'))?.group, { ...group, hidden: true });
    await enqueue(db, owner, { ...leave, path: '/groups/g/restore' });
    await syncOutbox(db, session);
    assert.deepEqual((await readGroup(db, owner, 'g'))?.group, { ...group, hidden: false });
    assert.equal(gets, 2);
  } finally { globalThis.fetch = original; raw.close(); }
});

test('mismatched receipt/method/account or contradictory index cannot acknowledge membership', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await enqueue(db, owner, leave);
    const accepted = { commandId: leave.command_id, receipt: { id: 'g', version: 3, disposition: 'left' as const } };
    await assert.rejects(reconcileGroupCache(db, 'different-owner', [], accepted), /could not be confirmed/);
    await assert.rejects(reconcileGroupCache(db, owner, [group], accepted), /could not be confirmed/);
    await assert.rejects(reconcileGroupCache(db, owner, [], { ...accepted, receipt: { id: 'g', version: 3, disposition: 'hidden' } }), /could not be confirmed/);
    assert.equal((await pendingCommands(db, owner)).length, 1);
    assert.equal((await readGroup(db, owner, 'g'))?.kind, 'shared');
  } finally { raw.close(); }
});

test('server rejection stays review-required; helper never silently manufactures a replacement ID', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ detail: 'Settle ₹20 first' }, { status: 409 }); };
  try {
    await migrate(db);
    await assert.rejects(changeGroupMembership(db, session, 'g', 'leave', options), /Settle/);
    await assert.rejects(changeGroupMembership(db, session, 'g', 'leave', { ...options, uuid: () => { throw new Error('No replacement'); } }), /Resolve/);
    assert.equal(calls, 1); assert.equal((await pendingCommands(db, owner))[0].state, 'conflict');
  } finally { globalThis.fetch = original; raw.close(); }
});

test('retry stops after its accepted membership command, preserving later queued work rather than hiding success behind its failure', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(String(url), `${session.baseUrl}/api/v1/groups/g/leave`);
      return Response.json({ id: 'g', version: 3, disposition: 'left' });
    }
    assert.equal(String(url), `${session.baseUrl}/api/v1/groups`);
    return Response.json({ groups: [] });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    await enqueue(db, owner, leave);
    await enqueue(db, owner, { ...leave, command_id: 'later', path: '/groups/g/expenses', body: { command_id: 'later' } });
    assert.equal((await changeGroupMembership(db, session, 'g', 'leave', options)).disposition, 'left');
    assert.equal((await pendingCommands(db, owner))[0].command_id, 'later');
    assert.equal((await readGroup(db, owner, 'g'))?.kind, 'unavailable');
  } finally { globalThis.fetch = original; raw.close(); }
});


test('new Delete group finishes a legacy hide receipt then requests explicit departure with a fresh immutable command', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = []; let departed = false;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); bodies.push(body);
      departed = body.remove_membership === true;
      return Response.json({ id: 'g', version: departed ? 3 : 2, disposition: departed ? 'left' : 'hidden' });
    }
    if (String(url).endsWith('/summary')) return Response.json({ ...group, hidden: true, read_mode: 'summary', history: {}, totals: { spending: '0', paid: {}, shares: {} } });
    return Response.json({ groups: departed ? [] : [{ id: 'g', version: 2, hidden: true }] });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await saveDraft(db, owner, 'g', { notes: 'Retain saved work' }); await enqueue(db, owner, leave);
    const result = await changeGroupMembership(db, session, 'g', 'leave', { ...options, uuid: () => 'explicit-delete' });
    assert.equal(result.disposition, 'left');
    assert.deepEqual(bodies, [{ command_id: 'leave-id' }, { command_id: 'explicit-delete', remove_membership: true }]);
    assert.equal((await pendingCommands(db, owner)).length, 0);
    assert.equal((await readGroup(db, owner, 'g'))?.kind, 'unavailable');
  } finally { globalThis.fetch = original; raw.close(); }
});
