import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate, readDraft, saveDraft } from '../src/storage.ts';
import { sendStatementRequest } from '../src/statementRequest.ts';
import { sqliteAdapter } from './sqlite.ts';

const key = 'balance-statement-request';
const receipt = (command_id: string) => ({ id: randomUUID(), command_id, state: 'pending', error: '' });

test('unknown manual statement request survives SQLite restart, remains account-scoped, and clears only after matching receipt', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-statement-')), file = join(folder, 'local.db');
  let raw = new DatabaseSync(file), db = sqliteAdapter(raw);
  const sent: string[] = [], createId = () => randomUUID();
  try {
    await migrate(db);
    await assert.rejects(sendStatementRequest(db, 'account-a', createId, async id => { sent.push(id); throw Error('Lost response'); }));
    const saved = await readDraft<string>(db, 'account-a', key);
    await assert.rejects(sendStatementRequest(db, 'account-b', createId, async id => { sent.push(id); throw Error('Lost response'); }));
    assert.notEqual(sent[0], sent[1]);
    raw.close(); raw = new DatabaseSync(file); db = sqliteAdapter(raw);
    await sendStatementRequest(db, 'account-a', () => { throw Error('Must reuse saved ID'); }, async id => { sent.push(id); return receipt(id); });
    assert.equal(sent[2], saved);
    assert.equal(await readDraft(db, 'account-a', key), null);
    assert.equal(await readDraft(db, 'account-b', key), sent[1]);
    assert.equal((await db.getAllAsync('SELECT * FROM outbox')).length, 0);
  } finally { raw.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('wrong or malformed server receipts preserve the saved command and storage failure prevents POST', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db);
    await assert.rejects(sendStatementRequest(db, 'account', randomUUID, async () => receipt(randomUUID())), /Could not confirm/);
    const command = await readDraft<string>(db, 'account', key);
    await assert.rejects(sendStatementRequest(db, 'account', randomUUID, async id => ({ ...receipt(id), id: 'invalid' })), /Could not confirm/);
    assert.equal(await readDraft(db, 'account', key), command);
    let posts = 0;
    await assert.rejects(sendStatementRequest({ ...db, withExclusiveTransactionAsync: async () => { throw Error('Disk unavailable'); } }, 'account', randomUUID, async id => { posts++; return receipt(id); }));
    assert.equal(posts, 0);
  } finally { raw.close(); }
});

test('a late acknowledgment cannot clear a newer manual command', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db);
    const newer = randomUUID();
    await sendStatementRequest(db, 'account', randomUUID, async id => { await saveDraft(db, 'account', key, newer); return receipt(id); });
    assert.equal(await readDraft(db, 'account', key), newer);
  } finally { raw.close(); }
});
