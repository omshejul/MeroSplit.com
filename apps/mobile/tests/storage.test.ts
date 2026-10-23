import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, saveGroup, readGroup, enqueue, pendingCommands, acceptCommand, createPendingGroup, markCommand, wipeAccount, saveDraft, readDraft, discardUnsentGroup, listGroups, listUnavailableGroups, reconcileGroupCache } from '../src/storage.ts';
import { sqliteAdapter as adapter } from './sqlite.ts';
import type { Group, Command } from '../src/types.ts';

const group: Group = { id: 'g', name: 'Trip', version: 0, participants: [{ id: 'A', name: 'A' }], expenses: [], settlements: [], balances: { A: '0' }, transfers: [], activity: [] };
const command: Command = { command_id: 'c', group_id: 'g', method: 'POST', path: '/groups', body: { command_id: 'c' }, state: 'pending', error: null };

test('SQLite restart, ownership, migrations, duplicate IDs and atomic publish', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'splitdumb-mobile-'));
  const file = join(folder, 'test.db');
  let raw = new DatabaseSync(file);
  try {
    let db = adapter(raw);
    await migrate(db); await migrate(db);
    await saveGroup(db, 'local', group, 'local');
    await saveDraft(db, 'account1', 'g', { description: 'Unfinished bill', amount: '100' });
    await createPendingGroup(db, 'account1', { ...group, version: 20, activity: ['local-only history'] }, [command]);
    assert.equal((await readGroup(db, 'account1', 'g'))?.group.version, 0);
    assert.deepEqual((await readGroup(db, 'account1', 'g'))?.group.activity, []);
    await enqueue(db, 'account1', command);
    assert.equal((await pendingCommands(db, 'account1')).length, 1);
    assert.deepEqual(await readDraft(db, 'account1', 'g'), { description: 'Unfinished bill', amount: '100' });
    assert.equal(await readDraft(db, 'account2', 'g'), null);
    await assert.rejects(enqueue(db, 'account1', { ...command, body: { different: true } }));
    raw.close(); raw = new DatabaseSync(file); db = adapter(raw);
    assert.equal((await readGroup(db, 'account1', 'g'))?.kind, 'shared');
    assert.equal((await pendingCommands(db, 'account1')).length, 1);
    assert.equal(await readGroup(db, 'account2', 'g'), null);
    await markCommand(db, 'account1', 'c', 'conflict', 'Newer accepted revision');
    assert.equal((await pendingCommands(db, 'account1'))[0].state, 'conflict');
    await acceptCommand(db, 'account1', 'c', { ...group, version: 1 });
    assert.equal((await pendingCommands(db, 'account1')).length, 0);
    assert.equal((await readGroup(db, 'account1', 'g'))?.group.version, 1);
    await saveGroup(db, 'account1', group, 'shared');
    assert.equal((await readGroup(db, 'account1', 'g'))?.group.version, 1, 'stale snapshot cannot rewind cache');
    await assert.rejects(createPendingGroup(db, 'account1', group, [command]));
    await wipeAccount(db, 'account1');
    assert.equal(await readGroup(db, 'account1', 'g'), null);
    assert.equal(await readDraft(db, 'account1', 'g'), null);
    assert.equal((await readGroup(db, 'local', 'g'))?.kind, 'local');
    await assert.rejects(db.withExclusiveTransactionAsync(async tx => { await saveGroup(tx, 'other', group, 'local'); throw new Error('Interrupted'); }));
    assert.equal(await readGroup(db, 'other', 'g'), null);
  } finally { raw.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('Upgrade version one retains accepted rows and adds draft storage', async () => {
  const raw = new DatabaseSync(':memory:'), db = adapter(raw);
  try {
    await migrate(db); await saveGroup(db, 'account1', { ...group, version: 4 }, 'shared');
    raw.exec('DROP TABLE drafts; PRAGMA user_version=1;');
    await migrate(db);
    assert.equal((await readGroup(db, 'account1', 'g'))?.group.version, 4);
    await saveDraft(db, 'account1', 'g', { description: 'after upgrade' });
    assert.deepEqual(await readDraft(db, 'account1', 'g'), { description: 'after upgrade' });
    assert.equal((await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version, 2);
  } finally { raw.close(); }
});

test('Discard provisional group atomically removes its dependent commands and draft for only that owner', async () => {
  const raw = new DatabaseSync(':memory:'), db = adapter(raw);
  try {
    await migrate(db);
    const creation = { ...command, body: { command_id: command.command_id, id: group.id } };
    const dependent = { ...command, command_id: 'expense', path: '/groups/g/expenses', body: { id: 'bill' } };
    await createPendingGroup(db, 'account1', group, [creation, dependent]);
    await saveDraft(db, 'account1', 'g', { description: 'Unsaved trip bill' });
    await createPendingGroup(db, 'account2', group, [creation]);
    await saveDraft(db, 'account2', 'g', { description: 'Other account draft' });
    await saveGroup(db, 'local', group, 'local');
    await saveDraft(db, 'local', 'g', { description: 'Original local draft' });
    await createPendingGroup(db, 'account1', { ...group, id: 'other' }, [{ ...creation, command_id: 'other-create', group_id: 'other', body: { id: 'other' } }]);
    await saveDraft(db, 'account1', 'other', { description: 'Other group draft' });

    await discardUnsentGroup(db, 'account1', 'g');
    assert.equal(await readGroup(db, 'account1', 'g'), null);
    assert.equal(await readDraft(db, 'account1', 'g'), null);
    assert.deepEqual((await pendingCommands(db, 'account1')).map(row => row.command_id), ['other-create']);
    assert.equal((await readGroup(db, 'account2', 'g'))?.kind, 'shared');
    assert.deepEqual(await readDraft(db, 'account2', 'g'), { description: 'Other account draft' });
    assert.equal((await pendingCommands(db, 'account2')).length, 1);
    assert.equal((await readGroup(db, 'local', 'g'))?.kind, 'local');
    assert.deepEqual(await readDraft(db, 'local', 'g'), { description: 'Original local draft' });
    assert.deepEqual(await readDraft(db, 'account1', 'other'), { description: 'Other group draft' });
    assert.equal((await readGroup(db, 'account1', 'other'))?.kind, 'shared');
  } finally { raw.close(); }
});

test('Discard refuses accepted, local, missing-create and mismatched-create groups without removing anything', async () => {
  for (const scenario of ['accepted', 'local', 'missing-create', 'mismatched-create']) {
    const raw = new DatabaseSync(':memory:'), db = adapter(raw);
    try {
      await migrate(db);
      await saveGroup(db, 'account1', { ...group, version: scenario === 'accepted' ? 1 : 0 }, scenario === 'local' ? 'local' : 'shared');
      await saveDraft(db, 'account1', 'g', { description: 'Keep draft' });
      const queued = { ...command, path: scenario === 'missing-create' ? '/groups/g/expenses' : '/groups', body: { id: scenario === 'mismatched-create' ? 'another-group' : 'g' } };
      await enqueue(db, 'account1', queued);
      await assert.rejects(discardUnsentGroup(db, 'account1', 'g'), /Only an unsynced new group/);
      assert.ok(await readGroup(db, 'account1', 'g'), scenario);
      assert.deepEqual(await readDraft(db, 'account1', 'g'), { description: 'Keep draft' }, scenario);
      assert.deepEqual(await pendingCommands(db, 'account1'), [queued], scenario);
    } finally { raw.close(); }
  }
});

test('Discard rolls every deletion back when SQLite interrupts the transaction', async () => {
  const raw = new DatabaseSync(':memory:'), db = adapter(raw);
  try {
    await migrate(db);
    const creation = { ...command, body: { id: group.id } };
    await createPendingGroup(db, 'account1', group, [creation]);
    await saveDraft(db, 'account1', 'g', { description: 'Keep after interruption' });
    raw.exec("CREATE TRIGGER interrupt_draft_delete BEFORE DELETE ON drafts BEGIN SELECT RAISE(ABORT, 'interrupted deletion'); END;");
    await assert.rejects(discardUnsentGroup(db, 'account1', 'g'), /interrupted deletion/);
    assert.ok(await readGroup(db, 'account1', 'g'));
    assert.deepEqual(await pendingCommands(db, 'account1'), [creation]);
    assert.deepEqual(await readDraft(db, 'account1', 'g'), { description: 'Keep after interruption' });
  } finally { raw.close(); }
});

test('Complete authorized refresh hides revoked bases, preserves pending creations/work, and restores reauthorized groups', async () => {
  const raw = new DatabaseSync(':memory:'), db = adapter(raw);
  try {
    await migrate(db);
    const accepted = { ...group, version: 4 }, revoked = { ...accepted, id: 'revoked' }, drafted = { ...accepted, id: 'drafted' };
    await saveGroup(db, 'account1', accepted, 'shared'); await saveGroup(db, 'account1', revoked, 'shared'); await saveGroup(db, 'account1', drafted, 'shared');
    await saveGroup(db, 'account1', { ...accepted, id: 'gone' }, 'shared');
    await saveGroup(db, 'account2', revoked, 'shared'); await saveGroup(db, 'local', group, 'local');
    const rejected: Command = { ...command, group_id: revoked.id, command_id: 'rejected', path: '/groups/revoked/expenses', state: 'conflict', error: 'Review this change' };
    await enqueue(db, 'account1', rejected); await saveDraft(db, 'account1', drafted.id, { amount: '123.45' });
    await saveDraft(db, 'account1', 'legacy-recovery:revoked', { group: revoked, draft: null, commands: [], selfId: 'A', status: 'conflict', reason: 'Keep original' });
    const creation = { ...command, command_id: 'new-group', group_id: 'new', body: { id: 'new' } };
    await createPendingGroup(db, 'account1', { ...group, id: 'new' }, [creation]);
    const updated = { ...accepted, name: 'Fresh server name', version: 5 };
    assert.deepEqual((await reconcileGroupCache(db, 'account1', [updated])).sort(), ['drafted', 'gone', 'revoked']);
    assert.deepEqual((await listGroups(db, 'account1')).map(row => row.group.id), ['g', 'new']);
    assert.deepEqual((await listUnavailableGroups(db, 'account1')).map(row => row.id), ['drafted', 'revoked']);
    assert.equal(await readGroup(db, 'account1', 'gone'), null);
    assert.deepEqual(await readDraft(db, 'account1', drafted.id), { amount: '123.45' });
    assert.deepEqual(await pendingCommands(db, 'account1'), [rejected, creation]);
    assert.ok(await readDraft(db, 'account1', 'legacy-recovery:revoked'));
    assert.deepEqual((await listGroups(db, 'account2')).map(row => row.group.id), ['revoked']); assert.equal((await listGroups(db, 'local')).length, 1);
    assert.deepEqual(await reconcileGroupCache(db, 'account1', [updated]), [], 'Repeated refresh does not repeat access-change notices');
    await reconcileGroupCache(db, 'account1', [updated, revoked, drafted]);
    assert.equal((await readGroup(db, 'account1', revoked.id))?.kind, 'shared'); assert.deepEqual(await listUnavailableGroups(db, 'account1'), []);
  } finally { raw.close(); }
});

test('Interrupted or invalid reconciliation cannot replace the authorized cache with a partial refresh', async () => {
  const raw = new DatabaseSync(':memory:'), db = adapter(raw);
  try {
    await migrate(db); await saveGroup(db, 'account1', { ...group, version: 1 }, 'shared');
    await saveGroup(db, 'account1', { ...group, id: 'revoked', version: 1 }, 'shared'); await saveDraft(db, 'account1', 'revoked', { amount: '50' });
    raw.exec("CREATE TRIGGER interrupt_access_update BEFORE UPDATE OF kind ON groups_cache WHEN NEW.kind='unavailable' BEGIN SELECT RAISE(ABORT, 'interrupted refresh'); END;");
    await assert.rejects(reconcileGroupCache(db, 'account1', [{ ...group, name: 'Changed', version: 2 }]), /interrupted refresh/);
    assert.equal((await readGroup(db, 'account1', group.id))?.group.name, group.name); assert.equal((await readGroup(db, 'account1', 'revoked'))?.kind, 'shared');
    await assert.rejects(reconcileGroupCache(db, 'account1', [group, group]), /incomplete/);
    assert.equal((await listGroups(db, 'account1')).length, 2); assert.deepEqual(await readDraft(db, 'account1', 'revoked'), { amount: '50' });
  } finally { raw.close(); }
});
