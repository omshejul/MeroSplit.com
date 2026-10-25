import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { categoryKey, categoryIcon, expenseCategory } from '../src/categoryIcons.ts';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class ApiError extends Error { status: number; constructor(status: number) { super('Synthetic failure'); this.status = status; } }
const bill = { id: 'bill', groupId: 'group', title: 'Dinner', category: 'general', category_auto: true };
const hint = (state = 'ready', category: string | null = 'food', fields = {}) => ({ items: [{ id: bill.id, group_id: bill.groupId, title: bill.title, state, category, ...fields }] });
function fixture() {
  let index = 0, props = { session: { userId: 'one', token: 'token-one' } as any, visible: [bill], active: true, online: true };
  const state: any[] = [], deps: any[][] = [], cleanups: any[] = [], effects: (() => void)[] = [], timers = new Map<number, { fn: () => void; delay: number }>();
  const calls: { path: string; signal: AbortSignal; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  let timerId = 0;
  const env = { categoryKey, categoryIcon, ApiError, accountOwner: (session: any) => session.userId,
    request: (_: any, path: string, _method: any, _body: any, _format: any, signal: AbortSignal) => new Promise((resolve, reject) => calls.push({ path, signal, resolve, reject })),
    useRef: (value: any) => state[index++] ??= { current: value },
    useState: (value: any) => { const key = index++; return [state[key] ??= value, (value: any) => { state[key] = typeof value === 'function' ? value(state[key]) : value; }]; },
    useEffect: (fn: () => any, values: any[]) => { const key = index++; if (!deps[key] || values.some((value, i) => value !== deps[key][i])) { effects.push(() => { cleanups[key]?.(); cleanups[key] = fn(); }); deps[key] = values; } },
    setTimeout: (fn: () => void, delay: number) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
  };
  const source = ts.createSourceFile('useExpenseIcons.ts', readFileSync(new URL('../src/useExpenseIcons.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const body = source.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(source).replace(/^export /, '')).join('\n');
  const hook = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022 })};return useExpenseIcons;}`)(env);
  return { calls, timers, render(changes: Partial<typeof props> = {}) { props = { ...props, ...changes }; index = 0; return hook(props.session, props.visible, props.active, props.online); },
    async commit() { effects.splice(0).forEach(fn => fn()); await tick(); }, async fire() { const [id, timer] = timers.entries().next().value!; timers.delete(id); timer.fn(); await tick(); },
    unmount() { cleanups.forEach(fn => fn?.()); } };
}

test('advisory icons use only current visible IDs and never financial writes', async () => {
  const app = fixture(); assert.deepEqual(app.render(), {}); await app.commit();
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].path, '/expense-icons?ids=bill');
  app.calls[0].resolve(hint()); await tick();
  assert.equal(app.render()[categoryKey('group', 'bill', 'Dinner')], 'food');
  assert.deepEqual(app.render({ visible: [] }), {}); await app.commit();
  assert.equal(app.calls.length, 1); assert.equal(app.timers.size, 0); app.unmount();
});

test('pending alone refreshes with a finite budget; ready, uncertain, unknown and failed stop', async () => {
  const app = fixture(); app.render(); await app.commit();
  for (let i = 0; i < 4; i++) {
    app.calls[i].resolve(hint('pending', null)); await tick();
    if (i < 3) { assert.equal([...app.timers.values()][0].delay, [5000, 15000, 30000][i]); await app.fire(); }
  }
  assert.equal(app.calls.length, 4); assert.equal(app.timers.size, 0); app.unmount();
  for (const state of ['ready', 'uncertain', 'failed', 'unfamiliar']) {
    const app = fixture(); app.render(); await app.commit(); app.calls[0].resolve(hint(state, state === 'ready' ? 'food' : null)); await tick();
    assert.equal(app.timers.size, 0); app.unmount();
  }
});

test('account, token, group, exact title, mode, foreground and offline changes abort stale results', async () => {
  for (const change of [{ session: { userId: 'two', token: 'token-two' } }, { session: { userId: 'one', token: 'renewed' } },
    { visible: [{ ...bill, groupId: 'another' }] }, { visible: [{ ...bill, title: 'DINNER' }] }, { visible: [{ ...bill, title: 'Dinner ' }] },
    { visible: [{ ...bill, category_auto: false }] }, { active: false }, { online: false }]) {
    const app = fixture(); app.render(); await app.commit(); app.render(change); await app.commit();
    assert.equal(app.calls[0].signal.aborted, true); app.calls[0].resolve(hint()); await tick();
    assert.deepEqual(app.render(), {}); app.unmount();
  }
});

test('offline retains an accepted same-account icon; revocation clears it and failed reads never retry', async () => {
  const app = fixture(); app.render(); await app.commit(); app.calls[0].resolve(hint()); await tick();
  assert.equal(Object.values(app.render({ online: false }))[0], 'food'); await app.commit();
  app.render({ online: true }); await app.commit(); app.calls[1].reject(new ApiError(404)); await tick();
  assert.deepEqual(app.render(), {}); assert.equal(app.timers.size, 0); app.unmount();
  const failed = fixture(); failed.render(); await failed.commit(); failed.calls[0].reject(Error('Offline')); await tick();
  assert.deepEqual(failed.render(), {}); assert.equal(failed.calls.length, 1); assert.equal(failed.timers.size, 0); failed.unmount();
});

test('malformed identities/categories keep receipt and visible requests are bounded', async () => {
  for (const fields of [{ id: 'another' }, { group_id: 'another' }, { title: 'Old title' }, { category: 'invented' }]) {
    const app = fixture(); app.render(); await app.commit(); app.calls[0].resolve(hint('ready', 'food', fields)); await tick(); assert.deepEqual(app.render(), {}); app.unmount();
  }
  const app = fixture(); app.render({ visible: Array.from({ length: 100 }, (_, i) => ({ ...bill, id: `bill-${i}` })) }); await app.commit();
  assert.equal(decodeURIComponent(app.calls[0].path.split('=')[1]).split(',').length, 20); app.unmount();
});

test('explicit manual categories including General override prior automatic icons immediately', () => {
  const icons = { [categoryKey('group', 'bill', 'Dinner')]: 'food' };
  assert.equal(expenseCategory(bill, icons), 'food');
  assert.equal(expenseCategory({ ...bill, category_auto: false }, icons), 'general');
  assert.equal(expenseCategory({ ...bill, category: 'water' }, icons), 'water');
  assert.equal(expenseCategory({ ...bill, title: 'New title' }, icons), undefined);
});
