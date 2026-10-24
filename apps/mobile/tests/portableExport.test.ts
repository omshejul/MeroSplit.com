import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accountOwner, ApiError, type request } from '../src/api.ts';
import { migrate, saveDraft, saveGroup, enqueue } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import { portableExport } from '../src/portableExport.ts';
import { accountDeletionInput } from '../src/accountDeletion.ts';
import { APP_ORIGIN, parseNativeLink, publicAppUrl } from '../src/appLinks.ts';

const session = { baseUrl: 'https://merosplit.omshejul.com', token: 'private-not-for-export', userId: '1', email: 'owner@example.invalid' };
const file = { uri: 'file:///private/merosplit-upload-one.png', name: 'Photo.png', type: 'image/png', size: 3 };
const group = { id: 'g', name: 'Saved trip', version: 0, participants: [], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };

test('one portable file includes server data, local/unavailable/earlier work, recovery and deduplicated pending bytes', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), owner = accountOwner(session);
  try {
    await migrate(db); await saveGroup(db, owner, group, 'unavailable'); await saveGroup(db, 'local', { ...group, id: 'earlier' }, 'local');
    await saveDraft(db, owner, 'g', { amount: '100', attachment: { id: 'one', file } });
    await saveDraft(db, owner, 'media-upload:/groups/g/expenses/e/attachments', { id: 'one', file });
    await saveDraft(db, owner, 'legacy:g', { status: 'conflict', draft: { notes: 'Keep original recovery' } });
    await saveDraft(db, 'local', 'earlier', { notes: 'Unclaimed phone work' });
    await saveDraft(db, 'other-account', 'secret', { text: 'Do not export another account' });
    await enqueue(db, owner, { command_id: 'c', group_id: 'g', method: 'POST', path: '/groups/g/expenses', body: { id: 'e' }, state: 'pending', error: null });
    let reads = 0;
    const send: typeof request = async <T>(active: unknown, path: string) => { assert.equal(active, session); assert.equal(path, '/account/export'); return { account: { email: session.email } } as T; };
    const data = await portableExport(db, session, true, send, async value => { reads++; assert.equal(value.uri, file.uri); return 'YWJj'; });
    assert.equal(data.account_data_status, 'included'); assert.equal(reads, 1);
    assert.equal(data.saved_work.groups[0].kind, 'unavailable'); assert.equal(data.saved_work.pending_commands.length, 1);
    assert.equal(data.saved_work.drafts.length, 3); assert.equal(data.unclaimed_device_work.groups[0].id, 'earlier');
    assert.equal(data.unclaimed_device_work.drafts[0].data.notes, 'Unclaimed phone work');
    assert.equal(Buffer.from(data.saved_work.pending_files[0].data_base64, 'base64').toString(), 'abc');
    assert.doesNotMatch(JSON.stringify(data), /private-not-for-export|Do not export another account/);
  } finally { raw.close(); }
});

test('offline/server failure exports explicitly local-only; missing or oversized file cancels without deleting work', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), owner = accountOwner(session);
  try {
    await migrate(db); await saveDraft(db, owner, 'g', { attachment: { file } });
    let requests = 0;
    const send: typeof request = async <T>(): Promise<T> => { requests++; throw new ApiError(503, 'Unavailable'); };
    const offline = await portableExport(db, session, false, send, async () => 'YWJj');
    assert.equal(requests, 0); assert.equal(offline.account_data_status, 'unavailable_offline'); assert.equal(offline.account_data, null);
    assert.equal((await portableExport(db, session, true, send, async () => 'YWJj')).account_data_status, 'unavailable_connection');
    await assert.rejects(portableExport(db, session, false, send, async () => { throw Error('Missing bytes'); }), /export was cancelled/);
    await assert.rejects(portableExport(db, session, false, send, async () => 'YQ=='), /read all/);
    assert.equal((await db.getAllAsync('SELECT * FROM drafts WHERE owner=?', owner)).length, 1);
    await saveDraft(db, owner, 'g', { attachment: { file: { ...file, size: 41 * 1_048_576 } } });
    await assert.rejects(portableExport(db, session, false, send, async () => { throw Error('Must not read'); }), /40 MB/);
  } finally { raw.close(); }
});

test('delete requires exact word and current email; public links canonicalize without rewriting account identity', () => {
  for (const word of ['', 'Delete', ' delete', 'delete ']) assert.throws(() => accountDeletionInput(word, session.email, session.email));
  assert.throws(() => accountDeletionInput('delete', 'other@example.invalid', session.email));
  assert.deepEqual(accountDeletionInput('delete', ' OWNER@example.invalid ', session.email), { confirmation: 'delete', email: 'OWNER@example.invalid' });
  assert.equal(APP_ORIGIN, 'https://merosplit.com');
  assert.equal(publicAppUrl('https://old.example.invalid/app/invite/token#proof=abc'), 'https://merosplit.com/app/invite/token#proof=abc');
  assert.equal(session.baseUrl, 'https://merosplit.omshejul.com');
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  assert.deepEqual(parseNativeLink(`${session.baseUrl}/app/groups/${id}`), parseNativeLink(`${APP_ORIGIN}/app/groups/${id}`));
});
