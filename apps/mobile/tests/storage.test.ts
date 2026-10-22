import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, saveGroup, readGroup, enqueue, pendingCommands, acceptCommand, publishLocal, markCommand, wipeAccount, saveDraft, readDraft } from '../src/storage.ts';
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
