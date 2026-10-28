import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

type Element = { type: any; props: Record<string, any>; children: any[] };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function inbox(send: any) {
  let cursor = 0; const states: any[] = [], deps: Record<number, any[]> = {}, cleanups: Record<number, any> = {}; let effects: any[] = [], timer: any;
  const env = { React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) }, Text: 'Text', SectionHeading: 'SectionHeading', View: 'View', MotionReveal: 'MotionReveal', SettingsRow: 'SettingsRow', Button: 'Button', request: send, useUI: () => ({ ui: {} }),
    setTimeout: (fn: () => void) => { assert.equal(timer, undefined, 'one timer'); timer = fn; return 1; }, clearTimeout: () => { timer = undefined; },
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
    useEffect: (fn: () => any, values: any[]) => { const id = cursor++; if (!deps[id] || values.some((value, i) => value !== deps[id][i])) { effects.push(() => { cleanups[id]?.(); cleanups[id] = fn(); }); deps[id] = values; } } };
  const source = ts.createSourceFile('ChatInbox.tsx', readFileSync(new URL('../src/ChatInbox.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const render = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return ChatInbox;}`)(env);
  const props = { session: { baseUrl: 'https://example.test', userId: '1', token: 'one' }, active: true, busy: false, onOpen() {} };
  return { render: (changes = {}) => { cursor = 0; return render({ ...props, ...changes }); }, commit: async () => { const pending = effects; effects = []; pending.forEach(fn => fn()); await tick(); }, unmount: () => Object.values(cleanups).forEach(fn => fn?.()), timer: () => timer, advance: async () => { const fn = timer; timer = undefined; fn(); await tick(); } };
}

test('Unread Activity rows open the exact conversation and fetch never acknowledges it', async () => {
  const calls: string[] = [], opened: any[] = [];
  const app = inbox(async (_session: any, path: string) => { calls.push(path); return { conversations: [{ group_id: 'group', expense_id: 'bill', group: 'Weekend', bill: 'Groceries', unread: 2 }, { group_id: 'group', expense_id: 'second', group: 'Weekend', bill: 'Taxi', unread: 1 }], next_cursor: null }; });
  const props = { onOpen: (group: string, bill: string) => opened.push([group, bill]) };
  try {
    app.render(props); await app.commit(); const tree = app.render(props); await app.commit();
    const row = nodes(tree).find(node => node.type === 'SettingsRow')!;
    const rowList = nodes(tree).find((node: any) => node !== tree && node?.type === 'View' && node.props.style === undefined);
    assert.ok(rowList, 'mapped rows share one section container'); assert.equal(rowList.props.style, undefined);
    assert.equal(nodes(rowList).filter(node => node.type === 'SettingsRow').length, 2);
    assert.equal(tree.children.filter((node: any) => node?.type === 'SettingsRow').length, 0);
    assert.deepEqual(tree.props.style, { gap: 8 });
    assert.equal(row.props.value, '2 unread'); row.props.onPress(); assert.deepEqual(opened, [['group', 'bill']]);
    assert.deepEqual(calls, ['/me/chat-conversations?limit=20']); assert.equal(typeof app.timer(), 'function');
  } finally { app.unmount(); }
});

test('Pausing cancels the in-flight inbox and a late old-account response cannot appear in the new account', async () => {
  const calls: { account: string; signal: AbortSignal; resolve: (data: any) => void }[] = [], verification: boolean[] = [];
  const props = { onEmptyChange: (empty: boolean) => verification.push(empty) };
  const app = inbox(async (session: any, _path: string, _method: string, _body: unknown, _type: string, signal: AbortSignal) => new Promise(resolve => calls.push({ account: session.userId, signal, resolve })));
  try {
    app.render(props); await app.commit(); assert.equal(verification.at(-1), false, 'loading remains unverified'); app.render({ ...props, active: false }); await app.commit(); assert.equal(calls[0].signal.aborted, true);
    app.render({ ...props, session: { baseUrl: 'https://example.test', userId: '2', token: 'two' } }); await app.commit();
    calls[0].resolve({ conversations: [{ bill: 'Old private bill' }], next_cursor: null }); await tick();
    assert.equal(app.render({ ...props, session: { baseUrl: 'https://example.test', userId: '2', token: 'two' } }), null);
    calls[1].resolve({ conversations: [], next_cursor: null }); await tick();
    assert.equal(calls.length, 2); assert.equal(calls[1].account, '2');
  } finally { app.unmount(); }
});


test('Empty verification is false while loading, on errors or unread rows and true only after a current latest empty page', async () => {
  let result: any = { conversations: [], next_cursor: null }, failure = false, verified: boolean | undefined;
  const app = inbox(async () => { if (failure) throw Error('Synthetic unavailable'); return result; });
  const props = { onEmptyChange: (empty: boolean) => { verified = empty; } };
  try {
    app.render(props); await app.commit(); assert.equal(verified, true);
    failure = true; await app.advance(); assert.equal(verified, false);
    failure = false; await app.advance(); assert.equal(verified, true);
    result = { conversations: [{ group_id: 'g', expense_id: 'b', bill: 'Unread bill', unread: 1 }], next_cursor: null };
    await app.advance(); assert.equal(verified, false);
    app.render({ ...props, active: false }); await app.commit(); assert.equal(verified, false);
  } finally { app.unmount(); }
});
