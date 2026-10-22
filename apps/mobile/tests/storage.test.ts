import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, saveGroup, readGroup, enqueue, pendingCommands, acceptCommand, publishLocal, markCommand, wipeAccount, saveDraft, readDraft, discardUnsentGroup } from '../src/storage.ts';
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
    await publishLocal(db, 'account1', { ...group, version: 20, activity: ['local-only history'] }, [command]);
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
    await assert.rejects(publishLocal(db, 'account1', group, [command]));
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
    await publishLocal(db, 'account1', group, [creation, dependent]);
    await saveDraft(db, 'account1', 'g', { description: 'Unsaved trip bill' });
    await publishLocal(db, 'account2', group, [creation]);
    await saveDraft(db, 'account2', 'g', { description: 'Other account draft' });
    await saveGroup(db, 'local', group, 'local');
    await saveDraft(db, 'local', 'g', { description: 'Original local draft' });
    await publishLocal(db, 'account1', { ...group, id: 'other' }, [{ ...creation, command_id: 'other-create', group_id: 'other', body: { id: 'other' } }]);
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
    await publishLocal(db, 'account1', group, [creation]);
    await saveDraft(db, 'account1', 'g', { description: 'Keep after interruption' });
    raw.exec("CREATE TRIGGER interrupt_draft_delete BEFORE DELETE ON drafts BEGIN SELECT RAISE(ABORT, 'interrupted deletion'); END;");
    await assert.rejects(discardUnsentGroup(db, 'account1', 'g'), /interrupted deletion/);
    assert.ok(await readGroup(db, 'account1', 'g'));
    assert.deepEqual(await pendingCommands(db, 'account1'), [creation]);
    assert.deepEqual(await readDraft(db, 'account1', 'g'), { description: 'Keep after interruption' });
  } finally { raw.close(); }
});
