import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { accountOwner, ApiError, request } from '../src/api.ts';
import { clearAccountMediaUploads, clearMediaPreviews, pendingMediaUpload, retryMediaUpload, enqueueExpenseWithMedia, removePendingMediaUpload, saveMediaUpload, uploadMedia } from '../src/media.ts';
import type { MediaMetadata, PendingMediaUpload, PickedMedia } from '../src/media.ts';
import { migrate, readDraft, saveDraft, wipeAccount } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Session } from '../src/types.ts';

const session: Session = { baseUrl: 'https://example.test', userId: '1', email: 'qa@example.test', token: 'synthetic' };
const path = '/groups/g/expenses/e/attachments';
const pending: PendingMediaUpload = { id: 'd2c160d0-847c-4ea1-b4f7-60d06d5994c6', path, file: { uri: 'file:///synthetic/staged.png', name: 'receipt.png', type: 'image/png', size: 15 } };
const metadata: MediaMetadata = { id: pending.id, name: 'receipt.jpg', content_type: 'image/jpeg', size: 10 };
const emptyList: typeof request = async <T>(): Promise<T> => ({ attachments: [], can_modify: true }) as T;

test('Sign-out preview cleanup preserves staged uploads and unrelated files, including after one cleanup fails', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-preview-'));
  const names = [`merosplit-${pending.id}.png`, `merosplit-upload-${pending.id}.png`, 'unrelated-photo.png', 'merosplit-13dc400e-268e-4ab3-a905-08b357ca7850.pdf'];
  try {
    for (const name of names) writeFileSync(join(folder, name), 'synthetic bytes');
    await clearMediaPreviews(async () => names.map((name, index) => ({ name, delete: () => { if (index === 0) throw new Error('Busy preview'); unlinkSync(join(folder, name)); } })));
    assert.equal(existsSync(join(folder, names[0])), true); assert.equal(existsSync(join(folder, names[1])), true); assert.equal(existsSync(join(folder, names[2])), true); assert.equal(existsSync(join(folder, names[3])), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('Account deletion cleans only its own app-staged bytes before its drafts are wiped', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), folder = mkdtempSync(join(tmpdir(), 'merosplit-account-files-'));
  const accounts = [session, { ...session, userId: '2' }, { ...session, baseUrl: 'https://other.test' }];
  const ids = [pending.id, '13dc400e-268e-4ab3-a905-08b357ca7850', '4b8f5680-c7c4-45ec-8a2f-842fb5854090'];
  try {
    await migrate(db);
    for (const [index, account] of accounts.entries()) {
      const file = join(folder, `merosplit-upload-${ids[index]}.png`); writeFileSync(file, 'synthetic bytes');
      await saveMediaUpload(db, account, { ...pending, id: ids[index], file: { ...pending.file, uri: pathToFileURL(file).href } });
    }
    const originalFile = join(folder, 'original-user-photo.png'); writeFileSync(originalFile, 'Do not remove picker sources');
    await saveDraft(db, accountOwner(session), 'media-upload:malformed', { ...pending, file: { ...pending.file, uri: pathToFileURL(originalFile).href } });
    const cleaned: string[] = [];
    await clearAccountMediaUploads(db, session, async file => { cleaned.push(file.uri); unlinkSync(fileURLToPath(file.uri)); });
    assert.equal(cleaned.length, 1); assert.equal(existsSync(join(folder, `merosplit-upload-${ids[0]}.png`)), false);
    assert.equal(existsSync(originalFile), true);
    assert.ok(await pendingMediaUpload(db, session, path), 'Read pending paths before wipeAccount');
    await wipeAccount(db, accountOwner(session)); assert.equal(await pendingMediaUpload(db, session, path), null);
    for (const index of [1, 2]) { assert.ok(await pendingMediaUpload(db, accounts[index], path)); assert.equal(existsSync(join(folder, `merosplit-upload-${ids[index]}.png`)), true); }
  } finally { raw.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('Accepted POST plus lost POST/GET responses survives restart and recovers one attachment with the same ID', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-upload-')), dbPath = join(folder, 'app.db'), filePath = join(folder, 'staged.png');
  writeFileSync(filePath, 'synthetic bytes');
  const staged = { ...pending, file: { ...pending.file, uri: pathToFileURL(filePath).href } };
  let raw = new DatabaseSync(dbPath), db = sqliteAdapter(raw), gets = 0, posts = 0, cleanups = 0;
  const server = new Map<string, MediaMetadata>();
  const send: typeof request = async <T>(active: Session, endpoint: string): Promise<T> => {
    assert.equal(active, session); assert.equal(endpoint, path); gets++;
    if (gets === 2) throw new Error('Lost reconciliation GET');
    return { attachments: [...server.values()], can_modify: true } as T;
  };
  const post: typeof uploadMedia = async <T>(_session: Session, endpoint: string, file: PickedMedia, id: string): Promise<T> => {
    posts++; assert.equal(endpoint, path); assert.equal(id, pending.id);
    assert.deepEqual(await pendingMediaUpload(db, session, path), staged, 'The immutable command must already be durable before POST');
    assert.equal(readFileSync(fileURLToPath(file.uri), 'utf8'), 'synthetic bytes');
    server.set(id, metadata); throw new Error('Lost accepted POST response');
  };
  const cleanup = async () => { cleanups++; assert.equal(await pendingMediaUpload(db, session, path), null); unlinkSync(filePath); };
  try {
    await migrate(db); await saveMediaUpload(db, session, staged);
    await assert.rejects(retryMediaUpload(db, session, path, send, post, cleanup), /Lost accepted POST/);
    assert.deepEqual(await pendingMediaUpload(db, session, path), staged);
    assert.equal(cleanups, 0); assert.equal(existsSync(filePath), true); assert.equal(server.size, 1);
    raw.close(); raw = new DatabaseSync(dbPath); db = sqliteAdapter(raw);
    assert.deepEqual(await retryMediaUpload(db, session, path, send, post, cleanup), metadata);
    assert.equal(posts, 1); assert.equal(server.size, 1); assert.equal(cleanups, 1); assert.equal(existsSync(filePath), false);
    assert.equal(await pendingMediaUpload(db, session, path), null);
  } finally { raw.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('Uncertain and revoked upload outcomes retain the original request and staged bytes', async () => {
  for (const status of [401, 403, 404, 409, 429, 500, 503]) {
    const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); let cleanup = 0;
    try {
      await migrate(db); await saveMediaUpload(db, session, pending);
      const post: typeof uploadMedia = async <T>(): Promise<T> => { throw new ApiError(status, 'Unresolved upload'); };
      await assert.rejects(retryMediaUpload(db, session, path, emptyList, post, async () => { cleanup++; }), error => error instanceof ApiError && error.status === status);
      assert.deepEqual(await pendingMediaUpload(db, session, path), pending); assert.equal(cleanup, 0);
    } finally { raw.close(); }
  }
});

test('Deterministic input rejection retains the draft and staged bytes for preview and export', async () => {
  for (const status of [400, 413, 415, 422]) {
    const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); let cleanup = 0;
    try {
      await migrate(db); await saveMediaUpload(db, session, pending);
      const post: typeof uploadMedia = async <T>(): Promise<T> => { throw new ApiError(status, 'Invalid input'); };
      await assert.rejects(retryMediaUpload(db, session, path, emptyList, post, async () => { cleanup++; }), error => error instanceof ApiError && error.status === status);
      assert.deepEqual(await pendingMediaUpload(db, session, path), pending); assert.equal(cleanup, 0);
    } finally { raw.close(); }
  }
});

test('Pending uploads are immutable and isolated by account, server and bill', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); const mutable = structuredClone(pending); await saveMediaUpload(db, session, mutable); mutable.file.name = 'changed later';
    await assert.rejects(saveMediaUpload(db, session, { ...pending, id: 'another-id' }), /Finish the saved upload/);
    assert.deepEqual(await pendingMediaUpload(db, session, path), pending);
    for (const active of [{ ...session, userId: '2' }, { ...session, baseUrl: 'https://other.test' }]) {
      await assert.rejects(retryMediaUpload(db, active, path), /no saved upload/);
      assert.equal(await pendingMediaUpload(db, active, path), null);
    }
    await assert.rejects(retryMediaUpload(db, session, '/groups/g/expenses/another/attachments'), /no saved upload/);
    await saveDraft(db, accountOwner(session), `media-upload:${path}`, { ...pending, path: '/wrong-bill' });
    await assert.rejects(retryMediaUpload(db, session, path), /no saved upload/);
  } finally { raw.close(); }
});

test('A failed initial reconciliation cannot send bytes, and SQLite clear failure retains the retry identity', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); let posts = 0, cleanup = 0;
  const post: typeof uploadMedia = async <T>(): Promise<T> => { posts++; return { attachment: metadata, version: 2 } as T; };
  try {
    await migrate(db); await saveMediaUpload(db, session, pending);
    const offline: typeof request = async <T>(): Promise<T> => { throw new Error('Offline before reconciliation'); };
    await assert.rejects(retryMediaUpload(db, session, path, offline, post, async () => { cleanup++; }), /Offline before reconciliation/);
    assert.equal(posts, 0); assert.equal(cleanup, 0);
    raw.exec("CREATE TRIGGER fail_upload_clear BEFORE DELETE ON drafts BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
    await assert.rejects(retryMediaUpload(db, session, path, emptyList, post, async () => { cleanup++; }), /disk failure/);
    assert.deepEqual(await pendingMediaUpload(db, session, path), pending); assert.equal(posts, 1); assert.equal(cleanup, 0);
    raw.exec('DROP TRIGGER fail_upload_clear;');
    const accepted: typeof request = async <T>(): Promise<T> => ({ attachments: [metadata], can_modify: true }) as T;
    assert.deepEqual(await retryMediaUpload(db, session, path, accepted, post, async () => { cleanup++; }), metadata);
    assert.equal(posts, 1); assert.equal(cleanup, 1);
    assert.equal(await readDraft(db, accountOwner(session), `media-upload:${path}`), null);
  } finally { raw.close(); }
});


test('bill/file queue transfer is atomic: failed enqueue keeps the original draft and success has one immutable file intent', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  const bill = { command_id: 'bill-command', group_id: 'g', method: 'POST' as const, path: '/groups/g/expenses', body: { id: 'e' }, state: 'pending' as const, error: null };
  const attachment = { ...pending, path: '/groups/g/expenses/e/attachments' };
  const draft = { id: 'e', description: 'Dinner', attachment };
  try {
    await migrate(db); await saveDraft(db, accountOwner(session), 'g', draft);
    raw.exec("CREATE TRIGGER fail_bill_queue BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    await assert.rejects(enqueueExpenseWithMedia(db, session, bill, attachment), /disk full/);
    assert.deepEqual(await readDraft(db, accountOwner(session), 'g'), draft);
    assert.equal(await pendingMediaUpload(db, session, attachment.path), null);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM outbox').get()!.n, 0);
    raw.exec('DROP TRIGGER fail_bill_queue');
    await enqueueExpenseWithMedia(db, session, bill, attachment);
    await enqueueExpenseWithMedia(db, session, bill, attachment);
    assert.equal(await readDraft(db, accountOwner(session), 'g'), null);
    assert.deepEqual(await pendingMediaUpload(db, session, attachment.path), attachment);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM outbox').get()!.n, 1);
    let posts = 0;
    await assert.rejects(retryMediaUpload(db, session, attachment.path, async () => { throw new ApiError(404, 'Bill not committed'); }, async () => { posts++; throw Error('Must not send'); }), /Bill not committed/);
    assert.equal(posts, 0); assert.ok(await pendingMediaUpload(db, session, attachment.path));
  } finally { raw.close(); }
});

test('removing an uncertain upload reconciles and deletes only that exact accepted file; offline retains its bytes', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); let cleaned = 0;
  const calls: string[] = [];
  try {
    await migrate(db); await saveMediaUpload(db, session, pending);
    await assert.rejects(removePendingMediaUpload(db, session, path, async () => { throw Error('Offline'); }, async () => { cleaned++; }), /Offline/);
    assert.ok(await pendingMediaUpload(db, session, path)); assert.equal(cleaned, 0);
    const send: typeof request = async <T>(_session: Session, endpoint: string, method = 'GET'): Promise<T> => {
      calls.push(`${method} ${endpoint}`);
      return (method === 'GET' ? { attachments: [metadata], can_modify: true } : { removed: true }) as T;
    };
    await removePendingMediaUpload(db, session, path, send, async () => { cleaned++; });
    assert.deepEqual(calls, [`GET ${path}`, `DELETE ${path}/${pending.id}`]);
    assert.equal(cleaned, 1); assert.equal(await pendingMediaUpload(db, session, path), null);
  } finally { raw.close(); }
});
