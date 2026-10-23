import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accountOwner, refreshGroups, syncOutbox } from '../src/api.ts';
import { migrate, saveGroup, readGroup, readVisibleGroup, listGroups, saveDraft, readDraft, enqueue, pendingCommands, reconcileGroupCache } from '../src/storage.ts';
import { previewPending } from '../src/ledger.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Group, Expense, Session, Command } from '../src/types.ts';
const session: Session = { baseUrl: 'https://browsing.test', userId: 'one', email: 'one@example.test', token: 'synthetic' }, owner = accountOwner(session);
const bill: Expense = { id: 'bill', version: 1, description: 'Tea', total: '900', paid: { a: '900', b: '0' }, shares: { a: '300', b: '600' }, split: { mode: 'exact', values: { a: '300', b: '600' } }, date: '2026-10-17', category: 'other', notes: '', deleted: false };
const full: Group = { id: 'g', name: 'Trip', version: 1, participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], expenses: [bill], settlements: [], activity: [], balances: { a: '600', b: '-600' }, transfers: [{ sender: 'b', recipient: 'a', amount: '600' }] };
const summary = (version = 1): Group => ({ ...full, version, read_mode: 'summary', expenses: [], totals: { spending: '900', paid: { a: '900', b: '0' }, shares: { a: '300', b: '600' } }, history: { bills: { next_cursor: 'signed' }, activity: { next_cursor: null }, settlements: { next_cursor: null }, attempts: { next_cursor: null } } });

test('Browsing pages live separately from complete snapshots and a newer version invalidates old text', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, owner, full, 'shared'); await saveGroup(db, owner, summary(), 'shared');
    assert.equal((await readGroup(db, owner, 'g'))?.group.expenses.length, 1);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.group.read_mode, 'summary');
    assert.equal((await listGroups(db, owner)).length, 1);
    await saveGroup(db, owner, summary(2), 'shared');
    assert.equal(await readGroup(db, owner, 'g'), null, 'old complete history is invalidated rather than retaining redacted text');
    await saveGroup(db, owner, summary(1), 'shared');
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.group.version, 2);
  } finally { raw.close(); }
});

test('Cold bounded refresh fetches summary only and unchanged refresh reuses its page with zero writes', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch, calls: string[] = [];
  try {
    await migrate(db);
    globalThis.fetch = async url => { calls.push(String(url)); return Response.json(String(url).endsWith('/groups') ? { groups: [{ id: 'g', version: 1 }] } : summary()); };
    await refreshGroups(db, session, 'summary');
    assert.deepEqual(calls, ['https://browsing.test/api/v1/groups', 'https://browsing.test/api/v1/groups/g/summary']);
    const before = raw.prepare('SELECT total_changes() n').get()!.n; calls.length = 0;
    await refreshGroups(db, session, 'summary');
    assert.deepEqual(calls, ['https://browsing.test/api/v1/groups']);
    assert.equal(raw.prepare('SELECT total_changes() n').get()!.n, before);
  } finally { globalThis.fetch = original; raw.close(); }
});

test('Bounded acknowledgments atomically retain accepted summary and clear immutable command, never claiming complete history', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
  try {
    await migrate(db); await saveGroup(db, owner, summary(), 'shared');
    await enqueue(db, owner, { command_id: 'c', group_id: 'g', path: '/groups/g/expenses', method: 'POST', body: { command_id: 'c' }, state: 'pending', error: null });
    globalThis.fetch = async (url, init) => Response.json(init?.method === 'POST' ? { id: 'g', version: 2 } : summary(2));
    await syncOutbox(db, session, 'summary');
    assert.equal((await pendingCommands(db, owner)).length, 0);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.group.version, 2);
    assert.equal(await readGroup(db, owner, 'g'), null);
  } finally { globalThis.fetch = original; raw.close(); }
});

test('Revocation hides both cache forms, preserves pending work and never prunes after failed changed-group fetch', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
  try {
    await migrate(db); await saveGroup(db, owner, full, 'shared'); await saveGroup(db, owner, summary(), 'shared'); await saveDraft(db, owner, 'g', { description: 'Keep this' });
    globalThis.fetch = async url => String(url).endsWith('/groups') ? Response.json({ groups: [{ id: 'other', version: 1 }] }) : Promise.reject(new Error('offline'));
    await assert.rejects(refreshGroups(db, session, 'summary'));
    assert.equal((await listGroups(db, owner)).length, 1);
    assert.deepEqual(await reconcileGroupCache(db, owner, []), ['g']);
    assert.equal((await listGroups(db, owner)).length, 0);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.kind, 'unavailable');
    assert.equal((await readGroup(db, owner, 'g'))?.kind, 'unavailable');
    assert.deepEqual(await readDraft(db, owner, 'g'), { description: 'Keep this' });
  } finally { globalThis.fetch = original; raw.close(); }
});

test('Missing older bill cannot create a false pending balance; one focused detail permits exact delta without loading all history', () => {
  const change: Command = { command_id: 'edit', group_id: 'g', base_version: 1, path: '/groups/g/expenses/bill', method: 'PUT', body: { ...bill, total: '1200', paid: { a: '1200', b: '0' }, split: { mode: 'exact', values: { a: '400', b: '800' } } }, state: 'pending', error: null };
  assert.throws(() => previewPending(summary(), [change]), /Open this saved bill/);
  const preview = previewPending({ ...summary(), focused_expense: bill }, [change]);
  assert.deepEqual(preview.balances, { a: '800', b: '-800' });
  assert.deepEqual(summary().totals?.spending, '900', 'complete accepted totals are independent of the displayed page');
});


test('Lost acknowledgments for backdated bills and old payments cannot double-count complete server balances', async () => {
  const accepted = { ...summary(2), balances: { a: '600', b: '-600' } };
  const billCommand: Command = { command_id: 'lost', group_id: 'g', base_version: 1, path: '/groups/g/expenses', method: 'POST', body: bill, state: 'pending', error: null };
  const payment: Command = { ...billCommand, path: '/groups/g/settlements', body: { id: 'old-payment', sender: 'b', recipient: 'a', amount: '100' } };
  for (const command of [billCommand, payment, { ...billCommand, base_version: undefined }]) assert.throws(() => previewPending(accepted, [command]), /Balances show accepted records/);
  assert.deepEqual(previewPending(summary(), [billCommand]).balances, { a: '1200', b: '-1200' }, 'known unchanged baseline permits an exact offline preview');
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try { await migrate(db); await enqueue(db, owner, billCommand); assert.equal((await pendingCommands(db, owner))[0].base_version, 1); }
  finally { raw.close(); }
});


test('Upgrade a previously opened browsing database without changing old immutable command bodies', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await enqueue(db, owner, { command_id: 'old', group_id: 'g', path: '/groups/g/expenses', method: 'POST', body: { command_id: 'old', description: 'Unsent old bill' }, state: 'pending', error: null });
    raw.exec('ALTER TABLE outbox DROP COLUMN base_version; PRAGMA user_version=3;');
    await migrate(db);
    const command = (await pendingCommands(db, owner))[0];
    assert.equal(command.command_id, 'old'); assert.equal(command.base_version, undefined);
    assert.deepEqual(command.body, { command_id: 'old', description: 'Unsent old bill' });
    assert.throws(() => previewPending(summary(), [command]), /Balances show accepted records/);
  } finally { raw.close(); }
});
