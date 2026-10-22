import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { accountOwner, ApiError, request } from '../src/api.ts';
import { pendingMediaUpload, retryMediaUpload, saveMediaUpload, uploadMedia } from '../src/media.ts';
import type { MediaMetadata, PendingMediaUpload, PickedMedia } from '../src/media.ts';
import { migrate, readDraft, saveDraft } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Session } from '../src/types.ts';

const session: Session = { baseUrl: 'https://example.test', userId: '1', email: 'qa@example.test', token: 'synthetic' };
const path = '/groups/g/expenses/e/attachments';
const pending: PendingMediaUpload = { id: 'd2c160d0-847c-4ea1-b4f7-60d06d5994c6', path, file: { uri: 'file:///synthetic/staged.png', name: 'receipt.png', type: 'image/png', size: 15 } };
const metadata: MediaMetadata = { id: pending.id, name: 'receipt.jpg', content_type: 'image/jpeg', size: 10 };
const emptyList: typeof request = async <T>(): Promise<T> => ({ attachments: [], can_modify: true }) as T;

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

test('Deterministic input rejection releases the draft and staged bytes for choosing a corrected file', async () => {
  for (const status of [400, 413, 415, 422]) {
    const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); let cleanup = 0;
    try {
      await migrate(db); await saveMediaUpload(db, session, pending);
      const post: typeof uploadMedia = async <T>(): Promise<T> => { throw new ApiError(status, 'Invalid input'); };
      await assert.rejects(retryMediaUpload(db, session, path, emptyList, post, async () => { cleanup++; }), error => error instanceof ApiError && error.status === status);
      assert.equal(await pendingMediaUpload(db, session, path), null); assert.equal(cleanup, 1);
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
