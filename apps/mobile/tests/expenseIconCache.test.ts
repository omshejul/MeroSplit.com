import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, wipeAccount } from '../src/storage.ts';
import { categoryKey } from '../src/categoryIcons.ts';
import * as cache from '../src/expenseIconCache.ts';

const key = categoryKey('group', 'bill', 'Dinner');
test('resolved icons survive a real SQLite restart and load before cached bills are shown', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-icons-')), path = join(folder, 'cache.db'), owner = 'restart';
  let raw = new DatabaseSync(path);
  try {
    let db = sqliteAdapter(raw); await migrate(db);
    await cache.hydrateExpenseIcons(db, owner);
    const many = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [categoryKey('group', `bill-${i}`, 'Coffee'), 'coffee']));
    await Promise.all([cache.saveExpenseIcons(db, owner, many), cache.saveExpenseIcons(db, owner, { [key]: 'food' })]);
    raw.close(); raw = new DatabaseSync(path); db = sqliteAdapter(raw); await migrate(db);
    const restarted = await import(`../src/expenseIconCache.ts?restart=${Date.now()}`);
    assert.deepEqual(restarted.cachedExpenseIcons(owner), {});
    await restarted.hydrateExpenseIcons(db, owner);
    assert.equal(restarted.cachedExpenseIcons(owner)[key], 'food');
    assert.equal(Object.keys(restarted.cachedExpenseIcons(owner)).length, 451);
    assert.deepEqual(restarted.cachedExpenseIcons('another-account'), {});
    assert.equal((await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version, 6);
    assert.equal((await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM drafts'))?.n, 0);
  } finally { raw.close(); rmSync(folder, { recursive: true }); }
});

test('corrupt entries are ignored, current hints win hydration, and deletion cannot resurrect queued hints', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), owner = 'corrupt';
  try {
    await migrate(db); await cache.hydrateExpenseIcons(db, 'initialize');
    await db.runAsync('INSERT INTO expense_icon_cache(owner,body) VALUES(?,?)', owner, JSON.stringify({ [key]: 'food', wrong: 'taxi', [categoryKey('g', 'id', 'Bad')]: 'unrecognized' }));
    const write = cache.saveExpenseIcons(db, owner, { [key]: 'coffee' });
    await cache.hydrateExpenseIcons(db, owner); await write;
    assert.deepEqual(cache.cachedExpenseIcons(owner), { [key]: 'coffee' });
    const queued = cache.saveExpenseIcons(db, owner, { [key]: 'taxi' });
    const wiped = wipeAccount(db, owner); await Promise.all([queued, wiped]);
    assert.deepEqual(cache.cachedExpenseIcons(owner), {});
    assert.equal(await db.getFirstAsync('SELECT body FROM expense_icon_cache WHERE owner=?', owner), null);
    await db.runAsync('INSERT INTO expense_icon_cache(owner,body) VALUES(?,?)', 'broken', '{bad');
    await cache.hydrateExpenseIcons(db, 'broken'); assert.deepEqual(cache.cachedExpenseIcons('broken'), {});
  } finally { raw.close(); }
});
