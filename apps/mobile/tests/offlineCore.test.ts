import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, saveGroup, enqueue, pendingCommands, readVisibleGroup, enqueueBill, confirmedSync, confirmSync } from '../src/storage.ts';
import { syncStatus } from '../src/syncState.ts';
import { accountOwner, cacheOfflineGroups } from '../src/api.ts';
import { recordConnection, serverReachable, subscribeConnection } from '../src/connectivity.ts';
import { previewPending } from '../src/ledger.ts';
import type { Group, Command } from '../src/types.ts';

const accepted: Group = { id: 'trip', name: 'Weekend', version: 3, owner_id: 1, participants: [{ id: 'self', name: 'You', user_id: 1 }], expenses: [], settlements: [], balances: { self: '0' }, transfers: [], activity: [{ id: 'old', detail: 'preserved' }] };
const person: Command = { command_id: 'person-command', group_id: 'trip', base_version: 3, method: 'POST', path: '/groups/trip/participants', body: { command_id: 'person-command', id: 'john', name: 'John', email: '' }, state: 'pending', error: null };
const rename: Command = { ...person, command_id: 'rename-command', path: '/groups/trip/participants/john/name', body: { command_id: 'rename-command', name: 'John Doe' } };
const bill: Command = { ...person, command_id: 'bill-command', path: '/groups/trip/expenses', body: { command_id: 'bill-command', id: 'bill', description: 'Lunch', total: '10000', paid: { self: '10000' }, split: { mode: 'equal', values: { self: '1', john: '1' } }, date: '2026-10-24', category: '', notes: 'Local draft' } };
const payment: Command = { ...person, command_id: 'payment-command', path: '/groups/trip/settlements', body: { command_id: 'payment-command', id: 'payment', sender: 'john', recipient: 'self', amount: '1000', date: '2026-10-24' } };

test('durable ordered offline person, group-only rename, bill and payment survive SQLite restart without editing accepted history', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'merosplit-offline-')); const file = join(dir, 'cache.db'); let raw = new DatabaseSync(file);
 try {
  let db = sqliteAdapter(raw); await migrate(db); await saveGroup(db, 'server|1', accepted, 'shared');
  for (const command of [person, rename, bill, payment]) await enqueue(db, 'server|1', command);
  raw.close(); raw = new DatabaseSync(file); db = sqliteAdapter(raw);
  const stored = (await readVisibleGroup(db, 'server|1', 'trip'))!.group;
  const queued = await pendingCommands(db, 'server|1'); const preview = previewPending(stored, queued);
  assert.deepEqual(queued.map(c => c.command_id), ['person-command', 'rename-command', 'bill-command', 'payment-command']);
  assert.equal(preview.participants.find(p => p.id === 'john')?.name, 'John Doe');
  assert.equal(preview.participants.find(p => p.id === 'john')?.user_id, null);
  assert.equal(preview.expenses[0].id, 'bill'); assert.equal(preview.settlements[0].id, 'payment');
  assert.deepEqual(preview.balances, { self: '4000', john: '-4000' });
  assert.deepEqual(stored, accepted); assert.deepEqual(preview.activity, accepted.activity);
  assert.equal(await readVisibleGroup(db, 'server|2', 'trip'), null); assert.deepEqual(await pendingCommands(db, 'server|2'), []);
  assert.deepEqual(previewPending(stored, queued), preview, 'restart/re-render never duplicates pending rows');
 } finally { raw.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('only unattempted offline bills merge; unknown outcomes retain immutable command bodies and IDs', async () => {
 const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
 try {
  await migrate(db); await enqueueBill(db, 'server|1', bill);
  await enqueueBill(db, 'server|1', { ...bill, command_id: 'edit', method: 'PUT', path: '/groups/trip/expenses/bill', body: { ...bill.body, version: 0, description: 'Lunch changed', command_id: 'edit' } });
  let rows = await pendingCommands(db, 'server|1'); assert.equal(rows.length, 1); assert.equal(rows[0].command_id, bill.command_id); assert.equal(rows[0].method, 'POST'); assert.equal(rows[0].body.description, 'Lunch changed'); assert.equal(rows[0].body.version, undefined);
  await db.runAsync('UPDATE outbox SET attempted=1 WHERE owner=?', 'server|1');
  const before = await pendingCommands(db, 'server|1');
  await assert.rejects(enqueueBill(db, 'server|1', { ...bill, body: { ...bill.body, total: '20000' } }), /unconfirmed/);
  assert.deepEqual(await pendingCommands(db, 'server|1'), before);
  assert.deepEqual(await pendingCommands(db, 'server|2'), []);
 } finally { raw.close(); }
});

test('full offline snapshot is downloaded without pruning other cached groups; failed download cannot mark sync confirmed', async () => {
 const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
 const session = { baseUrl: 'https://fixture.invalid', userId: '1', email: 'only@fixture.invalid', token: 'local-fixture' }, owner = accountOwner(session);
 try {
  await migrate(db); await saveGroup(db, owner, { ...accepted, read_mode: 'summary', history: { bills: { next_cursor: 'older' } } }, 'shared');
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(cacheOfflineGroups(db, session), /Could not connect/); assert.equal(await confirmedSync(db, owner), null);
  const full = { ...accepted, expenses: Array.from({ length: 80 }, (_, i) => ({ id: `bill-${i}`, description: `Bill ${i}` })) };
  let reads = 0; globalThis.fetch = async url => { reads++; assert.equal(String(url), session.baseUrl+'/api/v1/groups/trip'); return Response.json(full); };
  await cacheOfflineGroups(db, session); await confirmSync(db, owner);
  assert.ok(await confirmedSync(db, owner)); await cacheOfflineGroups(db, session); assert.equal(reads, 1, 'unchanged full snapshot reused');
  assert.equal((await db.getFirstAsync<{ n: number }>("SELECT json_array_length(snapshot,'$.expenses') AS n FROM groups_cache WHERE owner=?", owner))?.n, 80);
  await saveGroup(db, owner, { ...accepted, version: 4, read_mode: 'summary' }, 'shared'); assert.equal(await confirmedSync(db, owner), null, 'new version removes stale offline-ready checkpoint');
 } finally { globalThis.fetch = original; recordConnection(true); raw.close(); }
});

test('status derives from durable pending work, conflicts, actual persisted acknowledgement and account scope', async () => {
 const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), base = { commands: [] as Command[], pendingFiles: 0, confirmedAt: null, durable: true, syncing: false, problem: false };
 try {
  await migrate(db); assert.equal(syncStatus(base).label, 'Needs attention');
  assert.equal(syncStatus({ ...base, commands: [bill] }).label, 'Saved on device');
  assert.equal(syncStatus({ ...base, pendingFiles: 1 }).label, 'Saved on device');
  assert.equal(syncStatus({ ...base, drafts: true }).label, 'Saved on device');
  assert.equal(syncStatus({ ...base, pendingFiles: 1, problem: true }).label, 'Needs attention');
  assert.equal(syncStatus({ ...base, commands: [bill], syncing: true }).label, 'Syncing');
  assert.equal(syncStatus({ ...base, commands: [{ ...bill, state: 'conflict' }], syncing: true }).label, 'Needs attention');
  assert.equal(syncStatus({ ...base, commands: [bill], durable: false }).label, 'Needs attention');
  await confirmSync(db, 'server|1'); const confirmedAt = await confirmedSync(db, 'server|1');
  assert.equal(syncStatus({ ...base, confirmedAt }).label, 'Synced');
  assert.equal(syncStatus({ ...base, confirmedAt: await confirmedSync(db, 'server|2') }).label, 'Needs attention');
  assert.equal(syncStatus({ ...base, confirmedAt, commands: [bill] }).label, 'Saved on device');
  assert.equal(syncStatus({ ...base, confirmedAt, problem: true }).label, 'Needs attention');
 } finally { raw.close(); }
});

test('connection hints publish changes but never manufacture a server acknowledgement', () => {
 let calls = 0; const off = subscribeConnection(() => calls++);
 recordConnection(false); assert.equal(serverReachable(), false); recordConnection(false); assert.equal(calls, 1);
 recordConnection(true); assert.equal(calls, 2); off(); recordConnection(false); assert.equal(calls, 2); recordConnection(true);
});

test('an account change during offline download cannot save the old response or confirm it', async () => {
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),original=globalThis.fetch;
 const session={baseUrl:'https://fixture.invalid',userId:'1',email:'actor@fixture.invalid',token:'old-generation'},owner=accountOwner(session);let current=true;
 try {
  await migrate(db);await saveGroup(db,owner,{...accepted,read_mode:'summary'},'shared');
  globalThis.fetch=async()=>{current=false;return Response.json(accepted);};
  await assert.rejects(cacheOfflineGroups(db,session,()=>current),/account changed/);
  assert.equal(await confirmedSync(db,owner),null);
  assert.equal(await db.getFirstAsync('SELECT id FROM groups_cache WHERE owner=?',owner),null);
 } finally {globalThis.fetch=original;raw.close();}
});
