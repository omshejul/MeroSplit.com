import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accountOwner, ApiError, syncOutbox } from '../src/api.ts';
import { migrate, enqueue, enqueueBill, pendingCommands, saveGroup, discardCommand, readGroup } from '../src/storage.ts';
import { serializedDatabase } from '../src/database.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Command, Group, Session } from '../src/types.ts';
import { pendingMediaUpload, removePendingMediaUpload, retryAccountMediaUploads, retryMediaUpload, saveMediaUpload } from '../src/media.ts';
import type { MediaMetadata } from '../src/media.ts';

const session: Session = { token: 'synthetic-audit', userId: '1', email: 'audit@example.invalid', baseUrl: 'https://audit.invalid' };
const owner = accountOwner(session);
const group: Group = { id: 'g', name: 'Trip', version: 1, participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], expenses: [], settlements: [], balances: { a: '0', b: '0' }, transfers: [], activity: [] };
const bill = (id: string, description: string): Command => ({ command_id: id, group_id: 'g', method: 'POST', path: '/groups/g/expenses', body: { command_id: id, id, description, total: '100', paid: { a: '100', b: '0' }, split: { mode: 'equal', values: { a: '1', b: '1' } }, date: '2026-11-01', category: 'other', notes: '' }, state: 'pending', error: null });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('audit: a bill edited behind a slow earlier write must send its newly saved body', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw));
  const started = gate(), release = gate(), posts: Record<string, unknown>[] = [];
  let job: Promise<unknown> | undefined;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); posts.push(body);
      if (body.command_id === 'first') { started.resolve(); await release.promise; }
      return Response.json({ id: body.id, version: 2 });
    }
    return Response.json({ ...group, version: 2 });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    await enqueue(db, owner, bill('first', 'Earlier bill'));
    await enqueueBill(db, owner, bill('second', 'Original lunch'));
    job = syncOutbox(db, session); await started.promise;
    const edit = bill('edit-second', 'Corrected lunch');
    await enqueueBill(db, owner, { ...edit, method: 'PUT', path: '/groups/g/expenses/second', body: { ...edit.body, id: 'second', version: 0 } });
    assert.equal((await pendingCommands(db, owner))[1].body.description, 'Corrected lunch', 'the edit committed before its command was attempted');
    release.resolve(); await job;
    assert.deepEqual({ posted: posts[1]?.description, retained: (await pendingCommands(db, owner)).map(row => row.body.description) }, { posted: 'Corrected lunch', retained: [] }, 'a committed local edit must not be replaced by the drainer\'s stale copy');
  } finally { release.resolve(); await job?.catch(() => {}); globalThis.fetch = original; raw.close(); }
});

test('audit: discarding an unattempted saved change behind a slow write must prevent its POST', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw));
  const started = gate(), release = gate(), posts: string[] = [];
  let job: Promise<unknown> | undefined;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); posts.push(body.command_id);
      if (body.command_id === 'first') { started.resolve(); await release.promise; }
      return Response.json({ id: body.id, version: 2 });
    }
    return Response.json({ ...group, version: 2 });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    await enqueue(db, owner, bill('first', 'Earlier bill'));
    await enqueue(db, owner, bill('discarded', 'Do not send'));
    await enqueue(db, owner, bill('third', 'Keep this later bill'));
    job = syncOutbox(db, session); await started.promise;
    assert.equal((await pendingCommands(db, owner))[1].attempted, undefined);
    await discardCommand(db, owner, 'discarded');
    release.resolve(); await job;
    assert.deepEqual(posts, ['first'], 'the discarded command never reached the server before deletion');
    assert.deepEqual((await pendingCommands(db, owner)).map(row => row.command_id), ['third']);
    await syncOutbox(db, session);
    assert.deepEqual(posts, ['first', 'third'], 'the next drainer resumes from the changed queue boundary');
    assert.deepEqual(await pendingCommands(db, owner), []);
  } finally { release.resolve(); await job?.catch(() => {}); globalThis.fetch = original; raw.close(); }
});

test('audit: removing a saved attachment during background upload must remove the eventually accepted file', async () => {
  const raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw));
  const started = gate(), release = gate(), attachments: MediaMetadata[] = [];
  const path = '/groups/g/expenses/e/attachments';
  const upload = { id: 'saved-upload', path, file: { uri: 'file:///synthetic/receipt.png', name: 'receipt.png', type: 'image/png', size: 10 } };
  const metadata: MediaMetadata = { id: upload.id, name: 'receipt.png', content_type: 'image/png', size: 10 };
  let job: Promise<unknown> | undefined;
  let removing: Promise<void> | undefined;
  const send = async <T>(_session: Session, endpoint: string, method = 'GET'): Promise<T> => {
    if (method === 'DELETE') { attachments.splice(attachments.findIndex(row => endpoint.endsWith('/' + row.id)), 1); return { removed: true } as T; }
    return { attachments: [...attachments], can_modify: true } as T;
  };
  try {
    await migrate(db); await saveMediaUpload(db, session, upload);
    job = retryAccountMediaUploads(db, session, (connection, active, endpoint) => retryMediaUpload(connection, active, endpoint, send,
      async <T>(): Promise<T> => { started.resolve(); await release.promise; attachments.push(metadata); return { attachment: metadata, version: 2 } as T; }, async () => {}));
    await started.promise;
    removing = removePendingMediaUpload(db, session, path, send, async () => {});
    await new Promise<void>(done => setImmediate(done));
    release.resolve(); await Promise.all([job, removing]);
    assert.equal(await pendingMediaUpload(db, session, path), null, 'Remove file has completed successfully');
    assert.deepEqual(attachments, [], 'a concurrent background upload must not resurrect the explicitly removed attachment');
  } finally { release.resolve(); await Promise.allSettled([job, removing]); raw.close(); }
});

test('removing a background upload also clears a rejection recorded while removal waited', async () => {
  const raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw)), started = gate(), release = gate();
  const path = '/groups/g/expenses/e/attachments';
  const upload = { id: 'rejected-upload', path, file: { uri: 'file:///synthetic/receipt.png', name: 'receipt.png', type: 'image/png', size: 10 } };
  const send = async <T>(): Promise<T> => ({ attachments: [], can_modify: true }) as T;
  let uploading: Promise<unknown> | undefined, removing: Promise<void> | undefined;
  try {
    await migrate(db); await saveMediaUpload(db, session, upload);
    uploading = retryAccountMediaUploads(db, session, (connection, active, endpoint) => retryMediaUpload(connection, active, endpoint, send,
      async () => { started.resolve(); await release.promise; throw new ApiError(413, 'File rejected'); }, async () => {}));
    await started.promise;
    removing = removePendingMediaUpload(db, session, path, send, async () => {});
    await new Promise<void>(done => setImmediate(done));
    release.resolve(); await Promise.all([uploading, removing]);
    assert.equal(await pendingMediaUpload(db, session, path), null);
  } finally { release.resolve(); await Promise.allSettled([uploading, removing]); raw.close(); }
});

test('a stale pending-file selection removes its accepted ID without clearing a newer upload', async () => {
  const raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw));
  const path = '/groups/g/expenses/e/attachments';
  const selected = { id: 'selected-upload', path, file: { uri: 'file:///synthetic/selected.png', name: 'selected.png', type: 'image/png', size: 10 } };
  const next = { ...selected, id: 'new-upload', file: { ...selected.file, uri: 'file:///synthetic/new.png' } };
  const attachments: MediaMetadata[] = [{ id: selected.id, name: selected.file.name, content_type: selected.file.type, size: selected.file.size }];
  const send = async <T>(_session: Session, endpoint: string, method = 'GET'): Promise<T> => {
    if (method === 'DELETE') { assert.ok(endpoint.endsWith('/' + selected.id)); attachments.length = 0; return { removed: true } as T; }
    return { attachments: [...attachments], can_modify: true } as T;
  };
  try {
    await migrate(db); await saveMediaUpload(db, session, selected);
    await retryMediaUpload(db, session, path, send, undefined, async () => {});
    assert.equal(await pendingMediaUpload(db, session, path), null, 'background success cleared the draft before the next UI render');
    await saveMediaUpload(db, session, next);
    await removePendingMediaUpload(db, session, path, send, async () => {}, selected);
    assert.deepEqual(attachments, []); assert.deepEqual(await pendingMediaUpload(db, session, path), next);
  } finally { raw.close(); }
});

test('foreground upload retry reconciles success after a background upload clears its draft', async () => {
  const raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw)), started = gate(), release = gate();
  const path = '/groups/g/expenses/e/attachments';
  const upload = { id: 'shared-upload', path, file: { uri: 'file:///synthetic/receipt.png', name: 'receipt.png', type: 'image/png', size: 10 } };
  const metadata: MediaMetadata = { id: upload.id, name: upload.file.name, content_type: upload.file.type, size: upload.file.size };
  const attachments: MediaMetadata[] = [];
  const send = async <T>(): Promise<T> => ({ attachments: [...attachments], can_modify: true }) as T;
  let posts = 0, background: Promise<unknown> | undefined, foreground: Promise<MediaMetadata> | undefined;
  const post = async <T>(): Promise<T> => { posts++; started.resolve(); await release.promise; attachments.push(metadata); return { attachment: metadata } as T; };
  try {
    await migrate(db); await saveMediaUpload(db, session, upload);
    background = retryAccountMediaUploads(db, session, (connection, active, endpoint) => retryMediaUpload(connection, active, endpoint, send, post, async () => {}));
    await started.promise;
    foreground = retryMediaUpload(db, session, path, send, post, async () => {});
    await new Promise<void>(done => setImmediate(done));
    release.resolve(); await background;
    assert.deepEqual(await foreground, metadata);
    assert.equal(posts, 1); assert.equal(await pendingMediaUpload(db, session, path), null);
  } finally { release.resolve(); await Promise.allSettled([background, foreground]); raw.close(); }
});

test('a retry waiting behind removal never uploads the removed file again', async () => {
  const raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw)), started = gate(), release = gate();
  const path = '/groups/g/expenses/e/attachments';
  const selected = { id: 'removed-upload', path, file: { uri: 'file:///synthetic/receipt.png', name: 'receipt.png', type: 'image/png', size: 10 } };
  const metadata: MediaMetadata = { id: selected.id, name: selected.file.name, content_type: selected.file.type, size: selected.file.size };
  const attachments: MediaMetadata[] = [];
  const send = async <T>(_session: Session, _path: string, method = 'GET'): Promise<T> => {
    if (method === 'DELETE') attachments.length = 0;
    return { attachments: [...attachments], can_modify: true } as T;
  };
  let posts = 0, uploading: Promise<unknown> | undefined, removing: Promise<void> | undefined, retrying: Promise<unknown> | undefined;
  const post = async <T>(): Promise<T> => { posts++; started.resolve(); await release.promise; attachments.push(metadata); return { attachment: metadata } as T; };
  try {
    await migrate(db); await saveMediaUpload(db, session, selected);
    uploading = retryMediaUpload(db, session, path, send, post, async () => {}); await started.promise;
    removing = removePendingMediaUpload(db, session, path, send, async () => {}, selected);
    await new Promise<void>(done => setImmediate(done));
    retrying = assert.rejects(retryMediaUpload(db, session, path, send, post, async () => {}), /no saved upload/);
    await new Promise<void>(done => setImmediate(done));
    release.resolve(); await Promise.all([uploading, removing, retrying]);
    assert.equal(posts, 1); assert.deepEqual(attachments, []); assert.equal(await pendingMediaUpload(db, session, path), null);
  } finally { release.resolve(); await Promise.allSettled([uploading, removing, retrying]); raw.close(); }
});

test('audit control: HTTP failures preserve exact queued bodies and distinguish retry from review', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 429, 500, 503, 403, 404, 409, 422]) {
      const raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw)), command = bill('same-command', 'Preserved bill');
      try {
        await migrate(db); await enqueue(db, owner, command);
        globalThis.fetch = async () => Response.json({ detail: 'Synthetic HTTP failure' }, { status });
        await assert.rejects(syncOutbox(db, session), /Synthetic HTTP failure/);
        const [saved] = await pendingCommands(db, owner);
        assert.equal(saved.state, [401, 429, 500, 503].includes(status) ? 'pending' : status === 409 ? 'conflict' : 'rejected');
        assert.equal(saved.attempted, true); assert.deepEqual(saved.body, command.body); assert.equal(saved.command_id, command.command_id);
      } finally { raw.close(); }
    }
  } finally { globalThis.fetch = original; }
});

test('audit control: failed local acknowledgement rolls back its cache write and retries one server mutation', async () => {
  const original = globalThis.fetch, raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw));
  const accepted = new Set<string>(), posts: string[] = [];
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); posts.push(body.command_id); accepted.add(body.command_id);
      return Response.json({ id: body.id, version: 2 });
    }
    return Response.json({ ...group, version: 2 });
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await enqueue(db, owner, bill('durable-command', 'Retain until confirmed'));
    await db.execAsync("CREATE TRIGGER fail_ack BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    await assert.rejects(syncOutbox(db, session), /synthetic disk failure/);
    assert.equal((await readGroup(db, owner, group.id))?.group.version, 1, 'the canonical cache save rolls back with outbox deletion');
    assert.equal((await pendingCommands(db, owner))[0].attempted, true);
    await db.execAsync('DROP TRIGGER fail_ack'); await syncOutbox(db, session);
    assert.deepEqual(posts, ['durable-command', 'durable-command']); assert.equal(accepted.size, 1);
    assert.deepEqual(await pendingCommands(db, owner), []); assert.equal((await readGroup(db, owner, group.id))?.group.version, 2);
  } finally { globalThis.fetch = original; raw.close(); }
});
