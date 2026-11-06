import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { accountOwner } from '../src/api.ts';
import { previewPending } from '../src/ledger.ts';
import { enqueueExpenseWithMedia, pendingMediaUpload } from '../src/media.ts';
import { migrate, enqueue, pendingCommands, readVisibleGroup, saveGroup } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Command, Expense, Group, GroupTransaction, Session } from '../src/types.ts';

const session: Session = { baseUrl: 'https://pending-ledger.invalid', userId: '1', email: 'owner@example.invalid', token: 'synthetic' }, owner = accountOwner(session);
const bill: Expense = { id: 'bill', version: 1, description: 'Accepted tea', total: '1000', paid: { a: '1000' }, shares: { a: '500', b: '500' }, split: { mode: 'equal', values: { a: '1', b: '1' } }, date: '2026-10-25', category: 'other', notes: '', deleted: false };
const payment = { id: 'payment', sender: 'b', recipient: 'a', amount: '100', date: '2026-10-25', provenance: 'manual_record' };
const accepted: Group = { id: 'g', name: 'Trip', version: 3, read_mode: 'summary', participants: [{ id: 'a', name: 'A', user_id: 1 }, { id: 'b', name: 'B' }], expenses: [bill], settlements: [payment], balances: { a: '400', b: '-400' }, transfers: [{ sender: 'b', recipient: 'a', amount: '400' }], activity: [], transactions: [{ kind: 'payment', date: payment.date, payment }, { kind: 'bill', date: bill.date, bill }], history: { transactions: { cursor: null, next_cursor: 'older-unloaded', previous: [], query: '' } } };
const command = (id: string, method: Command['method'], suffix: string, body: Command['body'] = {}): Command => ({ command_id: id, group_id: 'g', base_version: 3, method, path: `/groups/g${suffix}`, body: { ...body, command_id: id }, state: 'pending', error: null });
const edit = command('edit', 'PUT', '/expenses/bill', { ...bill, description: 'Saved tea edit', total: '2000', paid: { a: '2000' } });
const photo = command('photo', 'POST', '/expenses', { ...bill, id: 'photo-bill', description: 'Saved photo bill', total: '200', paid: { a: '200' }, date: '2026-10-26' });
const keys = (rows: GroupTransaction[] = []) => rows.map(row => row.kind === 'bill' ? `bill:${row.bill.id}` : `payment:${row.payment.id}`);

test('offline transaction preview includes saved edit and new photo bill after SQLite restart without changing queue/file ownership', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-ledger-')), file = join(folder, 'cache.sqlite');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
  const image = join(folder, 'merosplit-upload-00000000-0000-4000-8000-000000000001.png'); writeFileSync(image, bytes);
  const upload = { id: '00000000-0000-4000-8000-000000000001', path: '/groups/g/expenses/photo-bill/attachments', file: { uri: pathToFileURL(image).href, name: 'receipt.png', type: 'image/png', size: bytes.length } };
  let raw = new DatabaseSync(file), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, owner, accepted, 'shared'); await enqueue(db, owner, edit);
    await enqueueExpenseWithMedia(db, session, photo, upload);
    await enqueue(db, 'another-owner', photo);
    const queued = await pendingCommands(db, owner);
    raw.close(); raw = new DatabaseSync(file); db = sqliteAdapter(raw); await migrate(db);
    const stored = (await readVisibleGroup(db, owner, 'g'))!.group, restarted = await pendingCommands(db, owner);
    const preview = previewPending(stored, restarted);
    assert.deepEqual(preview.balances, { a: '1000', b: '-1000' });
    assert.deepEqual(keys(preview.transactions), ['bill:photo-bill', 'payment:payment', 'bill:bill']);
    const edited = preview.transactions!.find(row => row.kind === 'bill' && row.bill.id === 'bill');
    assert.ok(edited?.kind === 'bill'); assert.equal(edited.bill.description, 'Saved tea edit');
    assert.deepEqual(preview.history, accepted.history, 'a local preview never invents a complete or refreshed accepted paging window');
    assert.deepEqual(previewPending(stored, restarted), preview, 'repeated projection cannot duplicate pending rows');
    assert.deepEqual(stored, accepted); assert.deepEqual(restarted, queued);
    assert.deepEqual(await pendingCommands(db, owner), queued, 'projection does not attempt or rewrite commands');
    assert.deepEqual(await pendingMediaUpload(db, session, upload.path), upload);
    assert.equal(await pendingMediaUpload(db, { ...session, userId: '2' }, upload.path), null);
    assert.deepEqual(await pendingCommands(db, 'another-owner'), [{ ...photo }]);
    assert.deepEqual(readFileSync(image), bytes, 'rendering/restart cannot remove or mutate staged photo bytes');
  } finally { raw.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('a pending edit moves only its own transaction using the accepted date/kind/id ordering', () => {
  const second = { ...bill, id: 'other-bill', date: '2026-10-24' };
  const group: Group = { ...accepted, expenses: [bill, second], transactions: [...accepted.transactions!, { kind: 'bill', date: second.date, bill: second }] };
  const preview = previewPending(group, [{ ...edit, body: { ...edit.body, date: '2026-10-20' } }, photo]);
  assert.deepEqual(keys(preview.transactions), ['bill:photo-bill', 'payment:payment', 'bill:other-bill', 'bill:bill']);
  assert.deepEqual(preview.transactions![1], group.transactions![0], 'accepted payment body stays intact');
  assert.deepEqual(preview.transactions![2], group.transactions![2], 'untouched accepted bill stays intact');
  assert.deepEqual(preview.history, group.history);
  assert.deepEqual(keys(group.transactions), ['payment:payment', 'bill:bill', 'bill:other-bill']);
});

test('focused bills outside a page are included only when explicitly changed, without reconstructing unloaded history', () => {
  const focused = { ...bill, id: 'focused', date: '2026-10-01' }, unrelated = { ...bill, id: 'not-in-window' };
  const group: Group = { ...accepted, focused_expense: focused, expenses: [...accepted.expenses, unrelated] };
  const preview = previewPending(group, [photo]);
  assert.deepEqual(keys(preview.transactions), ['bill:photo-bill', 'payment:payment', 'bill:bill']);
  const changed = command('focused-edit', 'PUT', '/expenses/focused', { ...focused, description: 'Saved focused edit' });
  assert.deepEqual(keys(previewPending(group, [changed]).transactions), ['payment:payment', 'bill:bill', 'bill:focused']);
  assert.deepEqual(preview.history, group.history);
});

test('bill/payment reversals and pending payments retain one transaction per kind/id and exact pending balances', () => {
  const reverseBill = command('reverse-bill', 'POST', '/expenses/bill/reverse', { version: 1 });
  const reversePayment = command('reverse-payment', 'POST', '/settlements/payment/reverse');
  const newPayment = command('new-payment', 'POST', '/settlements', { id: 'pending-payment', sender: 'b', recipient: 'a', amount: '50', date: '2026-10-25' });
  const preview = previewPending(accepted, [reverseBill, reverseBill, reversePayment, reversePayment, newPayment, newPayment]);
  assert.deepEqual(preview.balances, { a: '-50', b: '50' });
  assert.deepEqual(keys(preview.transactions), ['payment:pending-payment', 'payment:payment', 'bill:bill']);
  assert.equal(preview.transactions!.find(row => row.kind === 'bill')?.bill.deleted, true);
  assert.equal((preview.transactions!.find(row => row.kind === 'payment' && row.payment.id === 'payment') as Extract<GroupTransaction, { kind: 'payment' }>).payment.reversed, true);
  assert.deepEqual(preview.history, accepted.history); assert.equal(accepted.expenses[0].deleted, false);
});

test('empty transaction pages gain only queued records; legacy views, foreign commands and stale conflict guards remain intact', () => {
  const empty: Group = { ...accepted, transactions: [], expenses: [] };
  assert.deepEqual(keys(previewPending(empty, [photo]).transactions), ['bill:photo-bill']);
  const legacy = { ...accepted, transactions: undefined };
  assert.equal(previewPending(legacy, [photo]).transactions, undefined);
  assert.deepEqual(previewPending(accepted, [{ ...photo, group_id: 'elsewhere' }]).transactions, accepted.transactions);
  const stale = { ...accepted, version: 4 };
  assert.throws(() => previewPending(stale, [{ ...edit, state: 'conflict', attempted: true }, photo]), /Balances show accepted records/);
  assert.deepEqual(keys(stale.transactions), keys(accepted.transactions));
  for (const value of [command('delete', 'DELETE', '/expenses/bill'), command('restore', 'POST', '/expenses/bill/restore')]) assert.throws(() => previewPending(accepted, [value]), /until sync/);
});

test('transaction IDs remain scoped by bill/payment kind, and undated payments keep their real ordering', () => {
  const undated = { ...payment, id: 'undated', date: null };
  const group: Group = { ...accepted, settlements: [...accepted.settlements, undated], transactions: [...accepted.transactions!, { kind: 'payment', date: null, payment: undated }] };
  const sameIdBill = { ...photo, body: { ...photo.body, id: payment.id, date: payment.date } };
  const preview = previewPending(group, [sameIdBill]);
  assert.deepEqual(keys(preview.transactions), ['bill:payment', 'payment:payment', 'bill:bill', 'payment:undated']);
  assert.deepEqual(preview.transactions!.at(-1), group.transactions!.at(-1));
  assert.deepEqual(previewPending(group, [sameIdBill, sameIdBill]).transactions, preview.transactions);
});


test('same-day pending bills appear newest first, while an edit keeps its original position in both history formats', () => {
  const first = { ...bill, id: 'zzz', created_at: '2026-10-25T08:00:00.000000+00:00' };
  const second = { ...bill, id: 'aaa', created_at: '2026-10-25T09:00:00.000000+00:00' };
  const group = { ...accepted, expenses: [first, second], transactions: [{ kind: 'bill' as const, date: second.date, bill: second }, { kind: 'bill' as const, date: first.date, bill: first }] };
  const changed = command('edit-first', 'PUT', '/expenses/zzz', { ...first, description: 'Edited first' });
  const added = command('newest', 'POST', '/expenses', { ...bill, id: '000' });
  const preview = previewPending(group, [changed, added]);
  assert.deepEqual(keys(preview.transactions), ['bill:000', 'bill:aaa', 'bill:zzz']);
  assert.deepEqual(preview.expenses.map(row => row.id), ['zzz', 'aaa', '000']);
  assert.equal(preview.expenses[0].created_at, first.created_at);
  assert.deepEqual(previewPending({ ...group, transactions: undefined }, [changed]).expenses.map(row => row.id), ['zzz', 'aaa']);
});
