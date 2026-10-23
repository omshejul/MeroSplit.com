import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountOwner, ApiError, claimLegacyGroup, request, syncOutbox } from '../src/api.ts';
import { emptyGroup, previewPending } from '../src/ledger.ts';
import { putLocalExpense, recalculateLocal } from './fixtures.ts';
import { bindLegacyGroup, enqueue, listLegacyGroups, listLegacyRecoveries, migrate, pendingCommands, readDraft, readGroup, readLegacySource, removeLegacyRecovery, saveDraft, saveGroup } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Command, Group, Session } from '../src/types.ts';

const session: Session = { baseUrl: 'https://example.test', userId: '1', email: 'qa@example.test', token: 'synthetic' }, owner = accountOwner(session);
const legacy = putLocalExpense(emptyGroup('g', 'Trip', [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]), { id: 'e', version: 1, description: 'Lunch', total: '10000', paid: { A: '10000' }, split: { mode: 'equal', values: { A: '1', B: '1' } }, date: '2026-10-16', category: 'general', notes: '', deleted: false });
const canonical: Group = { ...legacy, version: 4, owner_id: 1, participants: legacy.participants.map(person => ({ ...person, user_id: person.id === 'A' ? 1 : null })) };
const missing: typeof request = async <T>(): Promise<T> => { throw new ApiError(404, 'Group not found'); };
const server = (group: Group): typeof request => async <T>(active: Session, path: string, method = 'GET'): Promise<T> => { assert.equal(active, session); assert.equal(path, '/groups/g'); assert.equal(method, 'GET'); return group as T; };
const ids = () => { let id = 0; return () => `synthetic-command-${++id}`; };

test('Unowned phone records remain unassigned until an explicit account claim; other accounts cannot reclaim them', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, 'local', legacy, 'local');
    assert.deepEqual(await listLegacyGroups(db), [legacy]);
    assert.equal(await readGroup(db, owner, 'g'), null); assert.deepEqual(await listLegacyRecoveries(db, owner), []);
    await assert.rejects(claimLegacyGroup(db, session, 'g', 'unknown-person', ids(), missing), /Choose which person/);
    await assert.rejects(claimLegacyGroup(db, session, 'g', 'A', ids(), async <T>(): Promise<T> => { throw new Error('Offline'); }), /Offline/);
    assert.deepEqual(await listLegacyGroups(db), [legacy]);
    assert.equal((await claimLegacyGroup(db, session, 'g', 'A', ids(), missing)).status, 'queued');
    assert.deepEqual(await listLegacyGroups(db), []);
    const other = { ...session, userId: '2' };
    assert.deepEqual(await listLegacyRecoveries(db, accountOwner(other)), []);
    await assert.rejects(claimLegacyGroup(db, other, 'g', 'A', ids(), missing), /no longer available to this account/);
    assert.equal(await readGroup(db, accountOwner(other), 'g'), null);
  } finally { raw.close(); }
});

test('Claim keeps deleted bills, reversed payments, original activity and drafts, with immutable retry IDs across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merosplit-claim-')), file = join(directory, 'test.db');
  let raw = new DatabaseSync(file), db = sqliteAdapter(raw);
  try {
    await migrate(db);
    const original = recalculateLocal({ ...legacy, version: 30, activity: ['Original phone history'], expenses: legacy.expenses.map(expense => ({ ...expense, deleted: true })), settlements: [{ id: 'payment', sender: 'B', recipient: 'A', amount: '1250', reversed: true }] });
    await saveGroup(db, 'local', original, 'local'); await saveDraft(db, 'local', 'g', { description: 'Unfinished bill' });
    await claimLegacyGroup(db, session, 'g', 'A', ids(), missing);
    const commands = await pendingCommands(db, owner);
    assert.deepEqual(commands.map(command => `${command.method} ${command.path}`), ['POST /groups', 'POST /groups/g/expenses', 'DELETE /groups/g/expenses/e', 'POST /groups/g/settlements', 'POST /groups/g/settlements/payment/reverse']);
    assert.equal(commands[2].body.version, 1); assert.equal(commands[3].body.date, null); assert.equal(new Set(commands.map(command => command.command_id)).size, 5);
    const cached = (await readGroup(db, owner, 'g'))!.group;
    assert.equal(cached.version, 0); assert.deepEqual(previewPending(cached, commands).balances, original.balances);
    assert.deepEqual(cached.participants.map(person => person.user_id), [1, null]);
    assert.deepEqual(await readDraft(db, owner, 'g'), { description: 'Unfinished bill' });
    assert.deepEqual((await listLegacyRecoveries(db, owner))[0].group, original);
    raw.close(); raw = new DatabaseSync(file); db = sqliteAdapter(raw);
    await claimLegacyGroup(db, session, 'g', 'A', () => { throw new Error('Must reuse saved IDs'); }, missing);
    assert.deepEqual(await pendingCommands(db, owner), commands);
  } finally { raw.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Same-UUID published shadows reuse server records and never enqueue a duplicate bill', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, 'local', { ...legacy, version: 99 }, 'local');
    const result = await claimLegacyGroup(db, session, 'g', 'A', () => { throw new Error('No new command needed'); }, server(canonical));
    assert.equal(result.status, 'existing'); assert.deepEqual((await readGroup(db, owner, 'g'))?.group, canonical);
    assert.deepEqual(await pendingCommands(db, owner), []); assert.deepEqual(await listLegacyGroups(db), []);
    assert.equal((await listLegacyRecoveries(db, owner))[0].group.version, 99);
  } finally { raw.close(); }
});

test('An account display-name change reuses the matching historical ledger and preserves recovery without duplicate bills', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, 'local', legacy, 'local');
    const renamed = { ...canonical, participants: canonical.participants.map(person => ({ ...person, recorded_name: person.name, name: person.user_id === 1 ? 'Updated profile name' : person.name })) };
    const result = await claimLegacyGroup(db, session, 'g', 'A', () => { throw new Error('No duplicate commands'); }, server(renamed));
    assert.equal(result.status, 'existing');
    assert.deepEqual((await readGroup(db, owner, 'g'))?.group, renamed);
    assert.deepEqual(await pendingCommands(db, owner), []);
    assert.deepEqual((await listLegacyRecoveries(db, owner))[0].group, legacy);
  } finally { raw.close(); }
});

test('Copied migration drafts rebase only their revision while retaining the proposal and original source', async () => {
  for (const accepted of [null, canonical]) {
    const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
    try {
      await migrate(db); await saveGroup(db, 'local', legacy, 'local');
      const draft = { schemaVersion: 1, groupId: 'g', expenseId: 'e', expenseVersion: 99, id: 'e', description: 'Unfinished proposal', amount: '150.00', payerAmounts: { A: '150.00' }, participantIds: ['A', 'B'] };
      await saveDraft(db, 'local', 'g', draft);
      await claimLegacyGroup(db, session, 'g', 'A', ids(), accepted ? server(accepted) : missing);
      assert.deepEqual(await readDraft(db, owner, 'g'), { ...draft, expenseVersion: accepted ? canonical.expenses[0].version : 1 });
      assert.deepEqual((await listLegacyRecoveries(db, owner))[0].draft, draft);
    } finally { raw.close(); }
  }
});

test('A still-pending published shadow reuses its existing queued identities and account draft', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, 'local', legacy, 'local');
    await claimLegacyGroup(db, session, 'g', 'A', ids(), missing);
    const queued = await pendingCommands(db, owner);
    // Recreate the earlier app's global shadow beside its account pending copy.
    await db.runAsync("DELETE FROM drafts WHERE owner=? AND group_id='legacy-recovery:g'", owner);
    await saveGroup(db, 'local', legacy, 'local'); await saveDraft(db, owner, 'g', { description: 'Keep account draft' });
    await claimLegacyGroup(db, session, 'g', 'A', () => { throw new Error('Must retain original pending IDs'); }, missing);
    assert.deepEqual(await pendingCommands(db, owner), queued);
    assert.deepEqual(await readDraft(db, owner, 'g'), { description: 'Keep account draft' });
    assert.equal((await listLegacyRecoveries(db, owner))[0].status, 'queued');
  } finally { raw.close(); }
});

test('Divergent shadows and their drafts/commands are preserved without overwriting canonical or another account', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db);
    const edited = { ...legacy, expenses: legacy.expenses.map(expense => ({ ...expense, notes: 'Private difference' })) };
    const localCommand: Command = { command_id: 'private-command', group_id: 'g', method: 'PUT', path: '/groups/g/expenses/e', body: { notes: 'Original pending edit' }, state: 'conflict', error: 'Original conflict' };
    await saveGroup(db, 'local', edited, 'local'); await saveDraft(db, 'local', 'g', { description: 'Phone draft' }); await enqueue(db, 'local', localCommand);
    await saveDraft(db, owner, 'g', { description: 'Account draft' });
    await saveGroup(db, 'another-account', legacy, 'shared');
    const result = await claimLegacyGroup(db, session, 'g', 'A', ids(), server(canonical));
    assert.equal(result.status, 'conflict'); assert.deepEqual((await readGroup(db, owner, 'g'))?.group, canonical);
    assert.deepEqual(await readDraft(db, owner, 'g'), { description: 'Account draft' }); assert.deepEqual(await pendingCommands(db, owner), []);
    const [recovery] = await listLegacyRecoveries(db, owner);
    assert.deepEqual(recovery.group, edited); assert.deepEqual(recovery.commands, [localCommand]); assert.deepEqual(recovery.draft, { description: 'Phone draft' });
    assert.deepEqual((await readGroup(db, 'another-account', 'g'))?.group, legacy);
    assert.deepEqual(await listLegacyRecoveries(db, 'another-account'), []);
  } finally { raw.close(); }
});

test('Interrupted claim rolls back ownership transfer, source deletion, recovery and queued writes together', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, 'local', legacy, 'local'); await saveDraft(db, 'local', 'g', { description: 'Keep me' });
    raw.exec("CREATE TRIGGER interrupt_legacy_delete BEFORE DELETE ON groups_cache WHEN OLD.owner='local' BEGIN SELECT RAISE(ABORT, 'interrupted claim'); END;");
    await assert.rejects(claimLegacyGroup(db, session, 'g', 'A', ids(), missing), /interrupted claim/);
    assert.deepEqual((await readGroup(db, 'local', 'g'))?.group, legacy); assert.deepEqual(await readDraft(db, 'local', 'g'), { description: 'Keep me' });
    assert.equal(await readGroup(db, owner, 'g'), null); assert.deepEqual(await pendingCommands(db, owner), []); assert.deepEqual(await listLegacyRecoveries(db, owner), []);
    const source = (await readLegacySource(db, 'g'))!;
    await assert.rejects(bindLegacyGroup(db, 'local', { ...source, selfId: 'A', status: 'queued', reason: null }, null, []), /Sign in/);
  } finally { raw.close(); }
});

test('A source changed during live lookup is not claimed, and explicit recovery removal affects only that owner backup', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, 'local', legacy, 'local');
    const changed: typeof request = async <T>(): Promise<T> => { await saveDraft(db, 'local', 'g', { description: 'Late saved draft' }); throw new ApiError(404, 'Group not found'); };
    await assert.rejects(claimLegacyGroup(db, session, 'g', 'A', ids(), changed), /Phone records changed/);
    assert.deepEqual(await listLegacyGroups(db), [legacy]); assert.deepEqual(await pendingCommands(db, owner), []);
    await claimLegacyGroup(db, session, 'g', 'A', ids(), missing);
    const queued = await pendingCommands(db, owner);
    await removeLegacyRecovery(db, 'another-account', 'g'); assert.equal((await listLegacyRecoveries(db, owner)).length, 1);
    await removeLegacyRecovery(db, owner, 'g'); assert.deepEqual(await listLegacyRecoveries(db, owner), []);
    assert.deepEqual(await pendingCommands(db, owner), queued); assert.ok(await readGroup(db, owner, 'g'));
    assert.deepEqual(await readDraft(db, owner, 'g'), { description: 'Late saved draft' });
  } finally { raw.close(); }
});

test('Lost creation response retries the same legacy command; a hidden UUID collision stays recoverable without remapping', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), originalFetch = globalThis.fetch;
  try {
    await migrate(db); await saveGroup(db, 'local', emptyGroup('g', 'Trip', legacy.participants), 'local');
    await claimLegacyGroup(db, session, 'g', 'A', ids(), missing);
    const writes: string[] = []; let lost = true;
    globalThis.fetch = async (_url, options) => {
      if (options?.method === 'POST') { writes.push(String(options.body)); if (lost) { lost = false; throw new Error('Lost after commit'); } return Response.json({ id: 'g', version: 1 }); }
      return Response.json({ ...canonical, expenses: [], balances: { A: '0', B: '0' } });
    };
    await assert.rejects(syncOutbox(db, session), /Could not connect/); await syncOutbox(db, session);
    assert.equal(writes.length, 2); assert.equal(writes[0], writes[1]); assert.deepEqual(await pendingCommands(db, owner), []);
    await saveGroup(db, 'local', emptyGroup('hidden', 'Unpublished', legacy.participants), 'local');
    await claimLegacyGroup(db, session, 'hidden', 'A', ids(), missing);
    globalThis.fetch = async () => Response.json({ detail: 'A supplied ID is already in use' }, { status: 409 });
    await assert.rejects(syncOutbox(db, session), /already in use/);
    assert.equal((await pendingCommands(db, owner))[0].state, 'conflict');
    assert.equal((await pendingCommands(db, owner))[0].body.id, 'hidden');
    assert.ok((await listLegacyRecoveries(db, owner)).some(row => row.group.id === 'hidden'));
  } finally { globalThis.fetch = originalFetch; raw.close(); }
});
