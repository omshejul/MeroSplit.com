import { categoryIcon } from './categoryIcons.ts';
import type { ExpenseIcons } from './categoryIcons';
import type { Database } from './storage';

const empty: ExpenseIcons = {};
const accounts = new Map<string, { icons: ExpenseIcons; loaded: boolean; generation: number; writes: Promise<void> }>();
const listeners = new Set<() => void>();
const entry = (owner: string) => {
  let value = accounts.get(owner);
  if (!value) { value = { icons: empty, loaded: false, generation: 0, writes: Promise.resolve() }; accounts.set(owner, value); }
  return value;
};
export const cachedExpenseIcons = (owner: string): ExpenseIcons => accounts.get(owner)?.icons ?? empty;
export function subscribeExpenseIcons(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(owner: string, icons: ExpenseIcons) {
  entry(owner).icons = icons;
  listeners.forEach(listener => listener());
}
function decode(body: string): ExpenseIcons {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, category]) => {
      try {
        const identity = JSON.parse(key);
        return Array.isArray(identity) && identity.length === 3 && identity.every(part => typeof part === 'string')
          && typeof category === 'string' && (categoryIcon(category) !== 'bill' || category === 'general');
      } catch { return false; }
    }));
  } catch { return {}; }
}
async function initialize(db: Database) {
  // Additive cosmetic cache. Older OTA readers still open ledger schema 6.
  await db.execAsync('CREATE TABLE IF NOT EXISTS expense_icon_cache (owner TEXT PRIMARY KEY, body TEXT NOT NULL)');
}
function queue(owner: string, task: () => Promise<void>): Promise<void> {
  const value = entry(owner), result = value.writes.then(task);
  value.writes = result.catch(() => {});
  return result;
}
export function hydrateExpenseIcons(db: Database, owner: string): Promise<void> {
  const value = entry(owner), generation = value.generation;
  if (value.loaded) return Promise.resolve();
  return queue(owner, async () => {
    if (value.loaded || value.generation !== generation) return;
    await initialize(db);
    const row = await db.getFirstAsync<{ body: string }>('SELECT body FROM expense_icon_cache WHERE owner=?', owner);
    if (value.generation !== generation) return;
    value.loaded = true;
    if (row) publish(owner, { ...decode(row.body), ...value.icons });
  });
}
export function saveExpenseIcons(db: Database, owner: string, icons: ExpenseIcons): Promise<void> {
  if (!Object.keys(icons).length) return Promise.resolve();
  const value = entry(owner), generation = value.generation;
  const patch = decode(JSON.stringify(icons));
  if (!Object.keys(patch).length) return Promise.resolve();
  if (Object.entries(patch).some(([key, category]) => value.icons[key] !== category)) publish(owner, { ...value.icons, ...patch });
  return queue(owner, async () => {
    if (value.generation !== generation) return;
    await initialize(db);
    await db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync<{ body: string }>('SELECT body FROM expense_icon_cache WHERE owner=?', owner);
      if (value.generation !== generation) return;
      await tx.runAsync('INSERT OR REPLACE INTO expense_icon_cache(owner,body) VALUES(?,?)', owner, JSON.stringify({ ...decode(row?.body ?? '{}'), ...patch }));
    });
  });
}
export function clearExpenseIcons(db: Database, owner: string): Promise<void> {
  const value = entry(owner); ++value.generation; value.loaded = true;
  publish(owner, empty);
  return queue(owner, async () => {
    await initialize(db);
    await db.runAsync('DELETE FROM expense_icon_cache WHERE owner=?', owner);
  });
}
