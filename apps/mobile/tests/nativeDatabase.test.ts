import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { migrate, saveDraft, readDraft } from '../src/storage.ts';
import { serializedDatabase } from '../src/database.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Database } from '../src/storage.ts';

// Execute the shipped native initializer with real SQLite connections. Expo's
// exclusive transaction API uses its own connection, unlike the browser adapter.
function initializer(openDatabaseAsync: () => Promise<Database>, migrateWork = migrate) {
  const source = ts.createSourceFile('native.ts', readFileSync(new URL('../src/native.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getDatabase')!;
  const code = ts.transpile(fn.getText(source).replace(/^export /, ''), { target: ts.ScriptTarget.ES2022 });
  return new Function('env', `with(env){ let database; ${code}; return getDatabase; }`)({ SQLite: { openDatabaseAsync }, migrate: migrateWork, serializedDatabase }) as () => Promise<Database>;
}
function connections() {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-native-lock-')), file = join(folder, 'cache.db'), opened: DatabaseSync[] = [];
  function open() {
    const raw = new DatabaseSync(file); opened.push(raw); raw.exec('PRAGMA busy_timeout=0');
    const adapter = sqliteAdapter(raw);
    return { ...adapter, async closeAsync() { if (raw.isOpen) raw.close(); }, async withExclusiveTransactionAsync(task: (tx: Database) => Promise<void>) {
      const writer = new DatabaseSync(file); writer.exec('PRAGMA busy_timeout=0');
      try { await sqliteAdapter(writer).withExclusiveTransactionAsync(task); } finally { writer.close(); }
    } };
  }
  return { open, file, cleanup() { opened.forEach(raw => { if (raw.isOpen) raw.close(); }); rmSync(folder, { recursive: true, force: true }); } };
}
const tick = () => new Promise<void>(done => setImmediate(done));

test('native writes wait for an active transaction and survive its rollback', async () => {
  const pool = connections(), getDatabase = initializer(async () => pool.open());
  try {
    const db = await getDatabase();
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(done => { started = done; }), held = new Promise<void>(done => { release = done; });
    const first = db.withExclusiveTransactionAsync(async tx => { await saveDraft(tx, 'one', 'inside', { changed: true }); started(); await held; throw Error('Cancel transaction'); });
    const rejected = assert.rejects(first, /Cancel transaction/);
    await entered;
    const outside = saveDraft(db, 'two', 'outside', { preserved: true }).then(() => null, error => error);
    await tick(); release(); await rejected;
    const error = await outside;
    assert.equal(error?.message ?? null, null, 'Concurrent native draft save must wait instead of database is locked');
    assert.equal(await readDraft(db, 'one', 'inside'), null);
    assert.deepEqual(await readDraft(db, 'two', 'outside'), { preserved: true });
  } finally { pool.cleanup(); }
});

test('native initialization can recover after a temporary migration failure', async () => {
  const pool = connections(); let attempts = 0, opens = 0;
  const getDatabase = initializer(async () => { opens++; return pool.open(); }, async db => { if (++attempts === 1) throw Error('Temporary startup failure'); await migrate(db); });
  try {
    await assert.rejects(getDatabase(), /Temporary startup failure/);
    const db = await getDatabase();
    await saveDraft(db, 'one', 'restart', { retained: true });
    assert.deepEqual(await readDraft(db, 'one', 'restart'), { retained: true });
    assert.equal(opens, 2);
    assert.equal(await getDatabase(), db);
  } finally { pool.cleanup(); }
});

test('competing transactions and ordinary writes commit once through the native initializer', async () => {
  const pool = connections(), getDatabase = initializer(async () => pool.open());
  try {
    const db = await getDatabase();
    await db.execAsync('CREATE TABLE write_counter(n INTEGER NOT NULL); INSERT INTO write_counter VALUES(0)');
    let callbacks = 0;
    await Promise.all(Array.from({ length: 80 }, (_, index) => index % 2
      ? db.runAsync('UPDATE write_counter SET n=n+1')
      : db.withExclusiveTransactionAsync(async tx => { callbacks++; await tx.runAsync('UPDATE write_counter SET n=n+1'); await tick(); })));
    assert.equal((await db.getFirstAsync<{ n: number }>('SELECT n FROM write_counter'))?.n, 80);
    assert.equal(callbacks, 40);
  } finally { pool.cleanup(); }
});

test('a transient external writer releases without replaying a transaction callback or losing drafts', async () => {
  const pool = connections(), getDatabase = initializer(async () => pool.open());
  let external: DatabaseSync | undefined;
  try {
    const db = await getDatabase(); external = new DatabaseSync(pool.file); external.exec('BEGIN IMMEDIATE');
    let calls = 0;
    const timer = setTimeout(() => external!.exec('COMMIT'), 60);
    try { await db.withExclusiveTransactionAsync(async tx => { calls++; await saveDraft(tx, 'one', 'stable-id', { preserved: true }); }); }
    finally { clearTimeout(timer); }
    assert.equal(calls, 1); assert.deepEqual(await readDraft(db, 'one', 'stable-id'), { preserved: true });
  } finally { if (external?.isTransaction) external.exec('ROLLBACK'); external?.close(); pool.cleanup(); }
});

test('a blocked COMMIT is retried without replaying the successful writes or callback', async () => {
  const pool = connections(), raw = new DatabaseSync(pool.file), reader = new DatabaseSync(pool.file);
  try {
    raw.exec('PRAGMA busy_timeout=0; CREATE TABLE counter(n INTEGER NOT NULL); INSERT INTO counter VALUES(0)');
    reader.exec('BEGIN; SELECT * FROM counter');
    const db = serializedDatabase(sqliteAdapter(raw), true); let calls = 0;
    const timer = setTimeout(() => reader.exec('COMMIT'), 60);
    try { await db.withExclusiveTransactionAsync(async tx => { calls++; await tx.runAsync('UPDATE counter SET n=n+1'); }); }
    finally { clearTimeout(timer); }
    assert.equal(calls, 1); assert.equal((await db.getFirstAsync<{ n: number }>('SELECT n FROM counter'))?.n, 1);
  } finally { if (reader.isTransaction) reader.exec('ROLLBACK'); reader.close(); raw.close(); pool.cleanup(); }
});

test('persistent locks fail with useful feedback, roll back, and leave the next queued save usable', async () => {
  const pool = connections(), getDatabase = initializer(async () => pool.open());
  let external: DatabaseSync | undefined;
  try {
    const db = await getDatabase(); external = new DatabaseSync(pool.file); external.exec('BEGIN IMMEDIATE');
    const error = await saveDraft(db, 'one', 'blocked', { value: 1 }).then(() => null, error => error);
    assert.match(error.message, /Please try again in a moment/); assert.equal(error.cause.errcode, 5);
    external.exec('COMMIT');
    assert.equal(await readDraft(db, 'one', 'blocked'), null);
    await saveDraft(db, 'one', 'next', { value: 2 });
    assert.deepEqual(await readDraft(db, 'one', 'next'), { value: 2 });
    let calls = 0;
    await assert.rejects(db.withExclusiveTransactionAsync(async tx => { calls++; await saveDraft(tx, 'one', 'rolled-back', {}); throw Error('Unrelated failure'); }), /Unrelated failure/);
    assert.equal(calls, 1); assert.equal(await readDraft(db, 'one', 'rolled-back'), null);
  } finally { if (external?.isTransaction) external.exec('ROLLBACK'); external?.close(); pool.cleanup(); }
});

test('multi-statement batches and non-lock errors are never replayed', async () => {
  const pool = connections(), raw = new DatabaseSync(pool.file); let calls = 0;
  try {
    const base = sqliteAdapter(raw), cause = Object.assign(new Error('database is locked'), { errcode: 5 });
    const db = serializedDatabase({ ...base, async execAsync(sql) { calls++; if (sql === 'partial-batch') { raw.exec('INSERT INTO counter VALUES(1)'); throw cause; } return base.execAsync(sql); } }, true);
    await db.execAsync('CREATE TABLE counter(n INTEGER)'); calls = 0;
    await assert.rejects(db.execAsync('partial-batch'), error => (error as Error & { cause: unknown }).cause === cause);
    assert.equal(calls, 1); assert.equal(raw.prepare('SELECT count(*) AS n FROM counter').get()!.n, 1);
    await assert.rejects(db.runAsync('INSERT INTO absent_table VALUES(1)'), /no such table/);
    await db.runAsync('INSERT INTO counter VALUES(2)'); assert.equal(raw.prepare('SELECT count(*) AS n FROM counter').get()!.n, 2);
  } finally { raw.close(); pool.cleanup(); }
});
