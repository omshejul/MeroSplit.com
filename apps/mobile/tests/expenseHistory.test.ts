import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, saveGroup, readExpenseHistory, saveExpenseHistory, forgetExpenseHistory } from '../src/storage.ts';
import { historyTime, historyValue, historyActions, historyLabels } from '../src/expenseHistory.ts';
import { ApiError, accountOwner } from '../src/api.ts';
import type { ExpenseVersion, ExpenseHistoryPage } from '../src/expenseHistory.ts';

const session = { userId: '1', baseUrl: 'https://synthetic.invalid', email: 'a@example.invalid', token: 'synthetic' };
const version = (id = 'edit'): ExpenseVersion => ({ id, sequence: 3, created_at: '2026-10-21T00:00:00Z', actor_name: 'Asha', currency: 'INR', names: { a: 'Asha', b: 'Noor' }, kind: 'edited', changes: [{ field: 'description', before: 'Dinner', after: 'Dinner at Olive' }], labels_recorded: true });
const page = (id = 'edit'): ExpenseHistoryPage => ({ group_id: 'group', expense_id: 'bill', items: [version(id)], next_before: null, legacy_gap: false, version: 3 });
const tick = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
function component(send: (...args: any[]) => Promise<any>) {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  const ready = (async () => { await migrate(db); for (const userId of ['1', '2']) await saveGroup(db, accountOwner({ ...session, userId }), { id:'group',name:'Dinner',version:3,participants:[],expenses:[],settlements:[],balances:{},transfers:[],activity:[] }, 'shared'); })();
  let cursor = 0, invalidations = 0;
  const state: any[] = [], dependencies: Record<number, any[]> = {}, cleanup: Record<number, any> = {};
  let effects: (() => void)[] = [];
  const env = { React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children }) },
    pageContentStyle: {}, Platform: { OS: 'native' }, View: 'View', Text: 'Text', FlatList: 'FlatList', LoadingSpinner: 'LoadingSpinner', Button: 'Button', ErrorText: 'ErrorText',
    StyleSheet: { create: (x: any) => x, hairlineWidth: 1 }, useUI: () => ({ ui: {}, palette: {} }),
    historyTime, historyValue, historyActions, historyLabels, ApiError, accountOwner, request: send, getDatabase: async () => { await ready; return db; }, readExpenseHistory, saveExpenseHistory, forgetExpenseHistory,
    setInterval: () => 1, clearInterval: () => {},
    useRef: (initial: any) => { const id = cursor++; return state[id] ??= { current: initial }; },
    useState: (initial: any) => { const id = cursor++; if (!(id in state)) state[id] = initial; return [state[id], (value: any) => { state[id] = typeof value === 'function' ? value(state[id]) : value; }]; },
    useEffect: (fn: () => any, values: any[]) => { const id = cursor++; if (!dependencies[id] || values.some((v, i) => v !== dependencies[id][i])) { effects.push(() => { cleanup[id]?.(); cleanup[id] = fn(); }); dependencies[id] = values; } },
  };
  const hook = ts.createSourceFile('useScrollPagination.ts', readFileSync(new URL('../src/useScrollPagination.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const hookBody = hook.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(hook).replace(/^export /, '')).join('\n');
  Object.assign(env, { useScrollPagination: new Function('env', `with(env){${ts.transpile(hookBody, { target: ts.ScriptTarget.ES2022 })};return useScrollPagination;}`)(env) });
  const source = ts.createSourceFile('ExpenseVersionHistory.tsx', readFileSync(new URL('../src/ExpenseVersionHistory.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const methods = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return {ExpenseVersionHistory,VersionHistoryRow};}`)(env);
  return { render: (changes: any = {}) => { cursor = 0; return methods.ExpenseVersionHistory({ session, groupId: 'group', expenseId: 'bill', groupVersion: 3, title: 'Dinner', active: true, online: true, onInvalidated: () => { invalidations++; }, ...changes }); },
    row: methods.VersionHistoryRow, invalidations: () => invalidations, commit: async () => { const run = effects; effects = []; run.forEach(fn => fn()); await tick(); }, unmount: () => { Object.values(cleanup).forEach(fn => fn?.()); raw.close(); } };
}

test('actual payer and split allocations retain zero-share participants and recorded labels', () => {
  const names = { a: 'Asha', b: 'Noor', c: 'Not involved' };
  assert.equal(historyValue('total', '276000', names, 'INR'), '₹2,760.00');
  assert.equal(historyValue('paid', { a: '276000', b: '0' }, names, 'INR'), 'Asha ₹2,760.00');
  const split = historyValue('split', { definition: { mode: 'percent', values: { a: '100', b: '0' } }, shares: { a: '276000', b: '0', c: '0' } }, names, 'INR');
  assert.match(split, /Asha ₹2,760.00 \(100%\)/); assert.match(split, /Noor ₹0.00 \(0%\)/); assert.doesNotMatch(split, /Not involved/);
  assert.match(historyValue('paid', { absent: '1' }, {}, 'INR'), /Name not recorded/);
  assert.equal(historyValue('notes', null, {}, 'INR'), 'Not recorded');
  assert.equal(historyValue('notes', '', {}, 'INR'), 'Empty');
});

test('relative times use actual server time and handle invalid and future timestamps', () => {
  const now = Date.parse('2026-10-21T01:00:00Z');
  assert.equal(historyTime('2026-10-21T00:48:00Z', now), '12 min. ago');
  assert.equal(historyTime('2026-10-21T01:00:01Z', now), 'Just now');
  assert.equal(historyTime('invalid', now), 'Time not recorded');
});

test('screen fetches only its entity via GET, preserves newest order and accessible actual values', async () => {
  const calls: any[] = [], app = component(async (...args) => { calls.push(args); return page(); });
  let tree = app.render(); assert.equal(tree.props.ListEmptyComponent.type, 'LoadingSpinner');
  await app.commit(); tree = app.render();
  assert.equal(calls.length, 1); assert.equal(calls[0][1], '/groups/group/expenses/bill/versions?limit=20'); assert.equal(calls[0][2], 'GET');
  assert.equal(tree.props.data[0].version.id, 'edit');
  const row = app.row(tree.props.data[0]);
  assert.equal(row.children[1].props.accessibilityLabel, 'From Dinner. To Dinner at Olive.');
  app.unmount();
});

test('late account or entity responses never render in the new scope', async () => {
  const resolves: ((value: any) => void)[] = [], calls: any[] = [];
  const app = component((...args) => { calls.push(args); return new Promise(resolve => resolves.push(resolve)); });
  app.render(); await app.commit();
  const changed = { session: { ...session, userId: '2', token: 'new' } };
  assert.equal(app.render(changed).props.data.length, 0); await app.commit();
  assert.equal(calls[0][5].aborted, true);
  resolves[0](page('old-account')); await tick(); assert.equal(app.render(changed).props.data.length, 0);
  resolves[1](page('current-account')); await tick(); assert.equal(app.render(changed).props.data[0].version.id, 'current-account');
  app.unmount();
});

test('offline screen retains downloaded data, inactive or denied reads hide it', async () => {
  let fail = false, calls = 0;
  const app = component(async () => { calls++; if (fail) throw new ApiError(404, 'Denied'); return page(); });
  app.render(); await app.commit(); assert.equal(app.render().props.data.length, 1);
  assert.equal(app.render({ online: false }).props.data.length, 1); await app.commit(); assert.equal(calls, 1);
  fail = true; app.render(); await app.commit(); const tree = app.render(); assert.equal(tree.props.data.length, 0); assert.equal(tree.props.ListEmptyComponent.type, 'View'); assert.equal(app.invalidations(),1,'history invalidation must also clear the parent acknowledgement');
  assert.equal(app.render({ active: false }), null); await app.commit(); app.unmount();
});

test('malformed entity identity is withheld and unmount aborts the current request', async () => {
  let signal: AbortSignal | undefined;
  const app = component(async (...args) => { signal = args[5]; return { ...page(), expense_id: 'different' }; });
  app.render(); await app.commit(); assert.equal(app.render().props.data.length, 0);
  app.unmount(); assert.equal(signal?.aborted, true);
});


test('empty bounded pages retain earlier-history navigation instead of claiming no history exists', async () => {
  let calls = 0;
  const app = component(async (_session, path) => {
    calls++;
    if (!path.includes('?before=')) return { ...page(), items: [], next_before: 2 };
    assert.equal(path, '/groups/group/expenses/bill/versions?before=2&limit=20');
    return { ...page('earlier-real-edit'), items: [{ ...version('earlier-real-edit'), sequence:1 }] };
  });
  app.render(); await app.commit(); let tree = app.render();
  assert.equal(tree.props.ListEmptyComponent.children[0], 'No recorded changes on this page.');
  tree.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
  tree.props.onContentSizeChange(320, 100);
  tree.props.onEndReached(); await tick(); assert.equal(calls, 1);
  tree.props.onScrollBeginDrag();
  tree.props.onScroll({ nativeEvent: { contentOffset: { y: -5 }, contentSize: { height: 100 }, layoutMeasurement: { height: 500 } } });
  await tick(); tree = app.render(); await app.commit();
  assert.equal(calls, 2); assert.equal(tree.props.data[0].version.id, 'earlier-real-edit');
  app.unmount();
});


test('via MCP is a small muted marker only for durable server provenance', () => {
  const app = component(async () => page());
  const marked = app.row({ version: { ...version(), via_mcp: true }, change: version().changes[0] });
  const plain = app.row({ version: version(), change: version().changes[0] });
  assert.equal(marked.children[0].children[1].children[0], 'via MCP');
  assert.equal(marked.children[0].children[1].props.style[1].fontSize, 12);
  assert.equal(plain.children[0].children[1], false);
  assert.equal(marked.children[1].props.accessibilityLabel, plain.children[1].props.accessibilityLabel);
});


test('a changed server revision clears old history instead of mixing redacted or newer versions', async () => {
  let calls = 0;
  const app = component(async () => ++calls === 1 ? { ...page(), next_before: 2 } : { ...page('new'), version: 4 });
  app.render(); await app.commit(); let tree = app.render();
  tree.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
  tree.props.onScrollBeginDrag(); await tick(); tree = app.render(); await app.commit();
  assert.equal(calls, 2); assert.equal(tree.props.data.length, 0);
  assert.equal(tree.props.ListEmptyComponent.children[0].children[0], 'History changed. Refresh to see the latest.');
  app.unmount();
});
