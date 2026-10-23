import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountOwner, request } from '../src/api.ts';
import { migrate, readDraft, readVisibleGroup, saveDraft } from '../src/storage.ts';
import { readPendingSplitwiseImport, retrySplitwiseImport, SPLITWISE_IMPORT_DRAFT, startSplitwiseImport } from '../src/splitwiseImport.ts';
import type { SplitwiseImportReceipt, SplitwiseImportRequest } from '../src/splitwiseImport.ts';
import type { Group, Session } from '../src/types.ts';
import { sqliteAdapter } from './sqlite.ts';

const session: Session = { baseUrl: 'https://example.test', userId: '1', email: 'qa@example.test', token: 'synthetic' };
const body: SplitwiseImportRequest = { command_id: 'command-1', id: 'group-1', csv: 'synthetic CSV content', name: 'Trip', self_index: 0, payers: { '7': 1 } };
const group: Group = { read_mode: 'summary', totals: { spending: '5000', paid: { A: '5000', B: '0' }, shares: { A: '2500', B: '2500' } }, history: { bills: { next_cursor: null }, activity: { next_cursor: null }, settlements: { next_cursor: null }, attempts: { next_cursor: null } }, id: body.id, name: body.name, version: 1, participants: [{ id: 'A', name: 'Asha', user_id: 1 }, { id: 'B', name: 'Kabir' }], expenses: [], settlements: [], balances: { A: '2500', B: '-2500' }, transfers: [], activity: [] };
const receipt: SplitwiseImportReceipt = { id: group.id, version: group.version, already_imported: false };
const accepted: typeof request = async <T>(_session: Session, path: string): Promise<T> => (path === '/imports/splitwise' ? receipt : group) as T;

test('Confirm saves immutable full request before POST and clears it only with accepted cached group', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), owner = accountOwner(session);
  try {
    await migrate(db);
    const mutable = structuredClone(body);
    await startSplitwiseImport(db, session, mutable);
    mutable.csv = 'changed later'; mutable.payers['7'] = 0;
    const calls: string[] = [];
    const send: typeof request = async <T>(active: Session, path: string, method = 'GET', sent?: unknown): Promise<T> => {
      calls.push(`${method} ${path}`); assert.equal(active, session);
      assert.deepEqual(await readPendingSplitwiseImport(db, session), body);
      assert.equal(await readVisibleGroup(db, owner, group.id), null);
      if (method === 'POST') assert.deepEqual(sent, body);
      return (method === 'POST' ? receipt : group) as T;
    };
    assert.deepEqual(await retrySplitwiseImport(db, session, send), { group, alreadyImported: false });
    assert.deepEqual(calls, ['POST /imports/splitwise', 'GET /groups/group-1/summary']);
    assert.deepEqual((await readVisibleGroup(db, owner, group.id))?.group, group);
    assert.equal((await readVisibleGroup(db, owner, group.id))?.kind, 'shared');
    assert.equal(await readPendingSplitwiseImport(db, session), null);
  } finally { raw.close(); }
});

test('Lost accepted response survives SQLite restart and retries exactly the same command', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-import-')), file = join(folder, 'app.db');
  let raw = new DatabaseSync(file), db = sqliteAdapter(raw);
  try {
    await migrate(db); await startSplitwiseImport(db, session, body);
    let acceptedRequest: unknown;
    const lost: typeof request = async <T>(_session: Session, path: string, _method?: string, sent?: unknown): Promise<T> => {
      assert.equal(path, '/imports/splitwise'); acceptedRequest = sent;
      throw new Error('Response lost after acceptance');
    };
    await assert.rejects(retrySplitwiseImport(db, session, lost), /Response lost/);
    raw.close(); raw = new DatabaseSync(file); db = sqliteAdapter(raw);
    assert.deepEqual(await readPendingSplitwiseImport(db, session), body);
    const recover: typeof request = async <T>(_session: Session, path: string, _method?: string, sent?: unknown): Promise<T> => {
      if (path === '/imports/splitwise') { assert.deepEqual(sent, acceptedRequest); return { ...receipt, already_imported: true } as T; }
      return group as T;
    };
    assert.deepEqual(await retrySplitwiseImport(db, session, recover), { group, alreadyImported: true });
    assert.equal(await readPendingSplitwiseImport(db, session), null);
  } finally { raw.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('Readback failure retains request and repeat receipt may open the existing imported group', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await startSplitwiseImport(db, session, body);
    const fail: typeof request = async <T>(_session: Session, path: string): Promise<T> => {
      if (path === '/imports/splitwise') return receipt as T;
      throw new Error('Readback offline');
    };
    await assert.rejects(retrySplitwiseImport(db, session, fail), /Readback offline/);
    assert.deepEqual(await readPendingSplitwiseImport(db, session), body);
    assert.equal(await readVisibleGroup(db, accountOwner(session), group.id), null);
    const existing = { ...group, id: 'original-imported-group' };
    const recover: typeof request = async <T>(_session: Session, path: string): Promise<T> => {
      if (path === '/imports/splitwise') return { ...receipt, id: existing.id, already_imported: true } as T;
      assert.equal(path, `/groups/${existing.id}/summary`); return existing as T;
    };
    assert.deepEqual(await retrySplitwiseImport(db, session, recover), { group: existing, alreadyImported: true });
    assert.equal(await readVisibleGroup(db, accountOwner(session), body.id), null);
    assert.deepEqual((await readVisibleGroup(db, accountOwner(session), existing.id))?.group, existing);
  } finally { raw.close(); }
});

test('SQLite failure rolls cache and draft deletion back together, then retry recovers', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await startSplitwiseImport(db, session, body);
    raw.exec("CREATE TRIGGER fail_import_clear BEFORE DELETE ON drafts BEGIN SELECT RAISE(ABORT, 'interrupted cache commit'); END;");
    await assert.rejects(retrySplitwiseImport(db, session, accepted), /interrupted cache commit/);
    assert.equal(await readVisibleGroup(db, accountOwner(session), group.id), null);
    assert.deepEqual(await readPendingSplitwiseImport(db, session), body);
    raw.exec('DROP TRIGGER fail_import_clear;');
    await retrySplitwiseImport(db, session, accepted);
    assert.deepEqual((await readVisibleGroup(db, accountOwner(session), group.id))?.group, group);
    assert.equal(await readPendingSplitwiseImport(db, session), null);
  } finally { raw.close(); }
});

test('Account and server boundaries isolate pending imports and saved groups', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await startSplitwiseImport(db, session, body);
    const otherAccount = { ...session, userId: '2' }, otherServer = { ...session, baseUrl: 'https://other.test' };
    for (const other of [otherAccount, otherServer]) {
      assert.equal(await readPendingSplitwiseImport(db, other), null);
      await assert.rejects(retrySplitwiseImport(db, other, async <T>(): Promise<T> => { throw new Error('Must never request'); }), /no saved import/);
    }
    await saveDraft(db, accountOwner(otherAccount), SPLITWISE_IMPORT_DRAFT, { ...body, name: 'Other person' });
    await saveDraft(db, accountOwner(session), 'other-bill', { description: 'Keep this bill draft' });
    await retrySplitwiseImport(db, session, accepted);
    assert.equal((await readPendingSplitwiseImport(db, otherAccount))?.name, 'Other person');
    assert.equal(await readVisibleGroup(db, accountOwner(otherAccount), group.id), null);
    assert.equal(await readVisibleGroup(db, accountOwner(otherServer), group.id), null);
    assert.deepEqual(await readDraft(db, accountOwner(session), 'other-bill'), { description: 'Keep this bill draft' });
  } finally { raw.close(); }
});

test('One saved import cannot be overwritten by another file or changed choices', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await startSplitwiseImport(db, session, body);
    await startSplitwiseImport(db, session, structuredClone(body));
    for (const changed of [{ ...body, csv: 'another CSV' }, { ...body, command_id: 'new-id' }, { ...body, payers: { '7': 0 } }]) {
      await assert.rejects(startSplitwiseImport(db, session, changed), /Finish the saved import/);
      assert.deepEqual(await readPendingSplitwiseImport(db, session), body);
    }
  } finally { raw.close(); }
});

test('A failed persistence step sends nothing and a mismatched readback cannot clear the request', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db);
    raw.exec("CREATE TRIGGER fail_import_save BEFORE INSERT ON drafts BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    await assert.rejects(startSplitwiseImport(db, session, body), /disk full/);
    assert.equal(await readPendingSplitwiseImport(db, session), null);
    raw.exec('DROP TRIGGER fail_import_save;');
    await startSplitwiseImport(db, session, body);
    const mismatch: typeof request = async <T>(_session: Session, path: string): Promise<T> => (path === '/imports/splitwise' ? receipt : { ...group, id: 'wrong-group' }) as T;
    await assert.rejects(retrySplitwiseImport(db, session, mismatch), /could not be read/);
    assert.deepEqual(await readPendingSplitwiseImport(db, session), body);
    assert.equal(await readVisibleGroup(db, accountOwner(session), 'wrong-group'), null);
  } finally { raw.close(); }
});
