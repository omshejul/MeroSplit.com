import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { accountOwner, ApiError, request } from '../src/api.ts';
import { APP_ORIGIN } from '../src/appLinks.ts';
import * as chat from '../src/billChat.ts';
import { migrate } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { ChatPage, ChatMessage } from '../src/billChat.ts';
import type { Session } from '../src/types.ts';

const session: Session = { baseUrl: 'https://example.test', userId: '1', email: 'qa@example.test', token: 'synthetic' };
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const message = (id: string): ChatMessage => ({ id, client_id: id, sender_id: '2', sender: 'Asha', text: 'Synthetic text ' + id, created_at: '2026-10-19T10:00:00Z', hidden: false, seen_token: 'visible-token-' + id });
const page = (messages: ChatMessage[]): ChatPage => ({ messages, older_cursor: 'before', after_cursor: 'after', can_send: true, policy_accepted: true, policy_version: 1, blocked_users: [], unread: 2, has_more_newer: false, removed_ids: [] });
type Element = { type: any; props: Record<string, any>; children: any[] };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
const find = (tree: any, type: any) => nodes(tree).find(node => node.type === type)!;
const button = (tree: any, title: string) => nodes(tree).find(node => node.props.title === title)!;

function component(db: any, send: typeof request, extra: Record<string, any> = {}) {
  let cursor = 0, states: any[] = [], effects: (() => void)[] = [], cleanups: Record<number, any> = {}, deps: Record<number, any[]> = {};
  let receive!: (value: ChatPage, older: boolean) => void, fail!: (error: unknown) => void;
  let starts = 0, stops = 0;
  const env: Record<string, any> = { APP_ORIGIN, ...chat, React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) },
    Platform: { OS: 'native' }, storageIsDurable: () => true, View: 'View', Text: 'Text', FlatList: 'FlatList', ScrollView: 'ScrollView', Button: 'Button', TextField: 'TextField', TextInput: 'TextInput', Icon: 'Icon', ChatComposerSurface: 'ChatComposerSurface', IconAction: 'IconAction', SettingsRow: 'SettingsRow', ChatControls: 'ChatControls', ChatMenu: 'ChatMenu', KeyboardDialog: 'KeyboardDialog', Dialog: Object.assign(() => {}, { Title: 'Title', Content: 'Content', Actions: 'Actions' }),
    Crypto: { randomUUID: () => 'synthetic-client-uuid' }, ApiError, accountOwner, request: send, getDatabase: async () => db, useUI: () => ({ ui: {}, palette: {} }), useWindowDimensions: () => ({ height: 720 }), Linking: { openURL: async () => {} },
    sendChatMessage: (...args: any[]) => chat.sendChatMessage(args[0], args[1], args[2], args[3], send),
    startChatReads: (_session: any, _path: string, _known: any, onPage: any, onError: any) => { starts++; receive = onPage; fail = onError; return { stop: () => stops++, refresh: () => {}, older: async () => {}, hasOlder: () => true }; },
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = typeof initial === 'function' ? initial() : initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
    useEffect: (fn: () => any, values: any[]) => { const id = cursor++; if (!deps[id] || values.some((value, i) => value !== deps[id][i])) { effects.push(() => { cleanups[id]?.(); cleanups[id] = fn(); }); deps[id] = values; } },
  };
  const pagingSource = ts.createSourceFile('useScrollPagination.ts', readFileSync(new URL('../src/useScrollPagination.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const pagingBody = pagingSource.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(pagingSource).replace(/^export /, '')).join('\n');
  env.useScrollPagination = new Function('env', `with(env){${ts.transpile(pagingBody, { target: ts.ScriptTarget.ES2022 })};return useScrollPagination;}`)(env);
  env.LoadingSpinner = 'LoadingSpinner';
  Object.assign(env, extra);
  const source = ts.createSourceFile('BillChatScreen.tsx', readFileSync(new URL('../src/BillChatScreen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const code = ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  const render = new Function('env', `with(env){${code}; return {BillChatScreen,ChatComposer,ChatEmptyState,ChatMessageRow};}`)(env);
  const props = { session, groupId: 'group', expenseId: 'bill', active: true, online: true };
  return { render: (changes = {}) => { cursor = 0; return render.BillChatScreen({ ...props, ...changes }); }, composer: render.ChatComposer, empty: render.ChatEmptyState, row: render.ChatMessageRow,
    commit: async () => { const pending = effects; effects = []; pending.forEach(fn => fn()); await tick(); },
    page: (value: ChatPage, older = false) => receive(value, older), fail: (error: unknown) => fail(error), counts: () => ({ starts, stops }), unmount: () => Object.values(cleanups).forEach(fn => fn?.()) };
}

test('Production screen acknowledges actual foreground viewable rows, never the page fetch or background callbacks', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), calls: { path: string; body: any; signal?: AbortSignal }[] = [];
  const send: typeof request = async <T>(_active: Session, path: string, _method?: string, body?: unknown, _type?: 'json' | 'text', signal?: AbortSignal): Promise<T> => { calls.push({ path, body, signal }); return { seen: 1 } as T; };
  const app = component(db, send);
  try {
    await migrate(db); app.render(); await app.commit(); app.page(page([message('1'), message('2')]));
    let tree = app.render(); await app.commit(); assert.equal(calls.length, 0);
    const flat = find(tree, 'FlatList');
    assert.equal(flat.props.inverted, true); assert.equal(flat.props.viewabilityConfig.minimumViewTime, 500);
    flat.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: message('1') }] });
    tree = app.render(); await app.commit(); assert.deepEqual(calls[0].body, { tokens: ['visible-token-1'] });
    app.render({ active: false }); await app.commit();
    flat.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: message('2') }] });
    app.render({ active: false }); await app.commit(); assert.equal(calls.length, 1); assert.equal(app.counts().stops, 1);
    app.render(); await app.commit(); assert.equal(app.counts().starts, 2);
    assert.deepEqual(calls[1].body, { tokens: ['visible-token-2'] });
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});

test('Older-history reader receives a New messages action and keeps rendered data stable until choosing it', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), app = component(db, async <T>() => ({ seen: 1 }) as T);
  try {
    await migrate(db); app.render(); await app.commit(); app.page(page([message('1'), message('2')]));
    let tree = app.render(); await app.commit();
    const flat = find(tree, 'FlatList'); flat.props.onScroll({ nativeEvent: { contentOffset: { y: 200 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 500 } } });
    app.page(page([message('3')])); tree = app.render(); await app.commit();
    assert.ok(button(tree, 'New messages')); assert.deepEqual(find(tree, 'FlatList').props.data.map((row: ChatMessage) => row.id), ['2', '1']);
    button(tree, 'New messages').props.onPress(); tree = app.render(); await app.commit();
    assert.deepEqual(find(tree, 'FlatList').props.data.map((row: ChatMessage) => row.id), ['3', '2', '1']);
    app.page(page([message('0')]), true); tree = app.render(); await app.commit();
    assert.deepEqual(find(tree, 'FlatList').props.data.map((row: ChatMessage) => row.id), ['3', '2', '1', '0']);
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});

test('Actual screen callback reopens older paging after an empty chat fills, then block and unblock reset it', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  const reads: { url: string; resolve: (value: ChatPage) => void }[] = [], controls: any[] = [];
  const timers = new Map<number, () => void>(); let timerID = 0;
  const send: typeof request = async <T>(_active: Session, url: string, method = 'GET', body?: any): Promise<T> => {
    if (method === 'GET') return new Promise(resolve => reads.push({ url, resolve: value => resolve(value as T) }));
    if (method === 'PUT') controls.push(body);
    return { seen: 1 } as T;
  };
  const app = component(db, send, {
    startChatReads: (active: Session, path: string, known: () => string[], receive: any, fail: any) => chat.startChatReads(active, path, known, receive, fail, send,
      { set: fn => { timers.set(++timerID, fn); return timerID as any; }, clear: id => { timers.delete(Number(id)); } }),
  });
  const fire = async () => { const [id, fn] = timers.entries().next().value!; timers.delete(id); fn(); await tick(); };
  const messages = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => message(String(first + i)));
  const response = (rows: ChatMessage[], after: string, before: string | null = null): ChatPage => ({ ...page(rows), older_cursor: before, after_cursor: after });
  try {
    await migrate(db); app.render(); await app.commit();
    reads[0].resolve(response([], 'after0')); await tick(); app.render(); await app.commit();
    await fire(); reads[1].resolve(response(messages(1, 50), 'after50')); await tick(); app.render(); await app.commit();
    await fire(); reads[2].resolve(response(messages(51, 55), 'after55')); await tick();
    let tree = app.render(); await app.commit();
    assert.equal(find(tree, 'FlatList').props.data.length, 55);
    find(tree, 'FlatList').props.renderItem({ item: message('55'), index: 0 }).props.onBlock(); await tick();
    assert.deepEqual(controls, [{ user_id: 2, blocked: true }]);
    reads[3].resolve({ ...response([], 'after0'), blocked_users: [{ id: '2', name: 'Asha' }] }); await tick();
    tree = app.render(); await app.commit(); assert.equal(find(tree, 'FlatList').props.data.length, 0);
    nodes(tree).find(node => node.props.label === 'Chat settings')!.props.onPress(); tree = app.render(); await app.commit();
    find(tree, 'ChatControls').props.onUnblock('2'); await tick();
    assert.deepEqual(controls[1], { user_id: 2, blocked: false });
    reads[4].resolve(response(messages(6, 55), 'after55', 'before6')); await tick();
    tree = app.render(); await app.commit(); find(tree, 'ChatControls').props.onClose(); tree = app.render(); await app.commit();
    const flat = find(tree, 'FlatList'), nativeEvent = { contentOffset: { y: 0 }, contentSize: { height: 4000 }, layoutMeasurement: { height: 500 } };
    flat.props.ListFooterComponent.children.flat(Infinity).find((node: any) => node?.props?.title === 'Load older').props.onPress();
    flat.props.onScroll({ nativeEvent: { ...nativeEvent, contentOffset: { y: 3500 } } }); await tick();
    assert.equal(reads.length, 6, 'Actual screen cursor must allow the older-page request after unblock');
    assert.equal(new URL('https://example.test' + reads[5].url).searchParams.get('before'), 'before6');
    reads[5].resolve(response(messages(1, 5), 'after5')); await tick();
    tree = app.render(); await app.commit();
    const ids = find(tree, 'FlatList').props.data.map((row: ChatMessage) => row.id);
    assert.equal(ids.length, 55); assert.equal(new Set(ids).size, 55); assert.equal(ids.at(-1), '1');
    const count = reads.length; flat.props.onScrollBeginDrag(); flat.props.onScroll({ nativeEvent: { ...nativeEvent, contentOffset: { y: 3600 } } }); await tick();
    assert.equal(reads.length, count, 'No older request remains after paging to the end');
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});

test('First-post consent stays explicit and repeated Send taps queue only one immutable message', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), posts: any[] = [];
  const send: typeof request = async <T>(_active: Session, path: string, method?: string, body?: any): Promise<T> => {
    if (method === 'POST' && path.endsWith('/chat')) { posts.push(body); return { ...message('3'), client_id: body.client_id, sender_id: '1', text: body.text } as T; }
    return { accepted: true } as T;
  };
  const app = component(db, send);
  try {
    await migrate(db); app.render(); await app.commit(); app.page({ ...page([]), policy_accepted: false });
    let tree = app.render(); await app.commit();
    const composer = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'ChatComposer')!;
    composer.props.onChange('My preserved draft'); tree = app.render(); await app.commit();
    const input = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'ChatComposer')!;
    input.props.onSend(); input.props.onSend(); tree = app.render(); await app.commit();
    assert.equal(posts.length, 0); assert.equal((await chat.readChatWork(db, session, chat.chatPath('group', 'bill'))).draft, 'My preserved draft');
    assert.ok(button(tree, 'Agree'));
    button(tree, 'Agree').props.onPress(); button(tree, 'Agree').props.onPress(); await tick();
    tree = app.render(); await app.commit(); assert.equal(posts.length, 1);
    assert.deepEqual((await chat.readChatWork(db, session, chat.chatPath('group', 'bill'))).pending, []);
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});


test('A native foreground reader recovering connection retries the saved message without relying on browser online events', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); let online = false, posts = 0;
  const send: typeof request = async <T>(_session: Session, path: string, method?: string, body?: any): Promise<T> => {
    if (method === 'POST' && path.endsWith('/chat')) { posts++; if (!online) throw Error('Offline'); return { ...message('3'), client_id: body.client_id, sender_id: '1', text: body.text } as T; }
    return { seen: 1 } as T;
  };
  const app = component(db, send);
  try {
    await migrate(db); await chat.queueChatMessage(db, session, chat.chatPath('group', 'bill'), 'retry-id', 'Saved offline text');
    app.render(); await app.commit(); app.page(page([])); app.render(); await app.commit(); await tick();
    assert.equal(posts, 1); assert.equal((await chat.readChatWork(db, session, chat.chatPath('group', 'bill'))).pending.length, 1);
    app.fail(Error('Read connection lost')); app.render(); await app.commit(); online = true;
    app.page(page([])); app.render(); await app.commit(); await tick();
    assert.equal(posts, 2); assert.deepEqual((await chat.readChatWork(db, session, chat.chatPath('group', 'bill'))).pending, []);
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});


test('A failed visible ACK retries on foreground refresh with the same visible IDs and deduplicates after success', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), calls: any[] = []; let fail = true;
  const send: typeof request = async <T>(_active: Session, path: string, _method?: string, body?: unknown): Promise<T> => {
    if (path.endsWith('/seen')) { calls.push(body); if (fail) throw Error('Transient ACK failure'); }
    return { seen: 1 } as T;
  };
  const app = component(db, send);
  try {
    await migrate(db); app.render(); await app.commit(); app.page(page([message('1'), message('2')]));
    let tree = app.render(); await app.commit();
    find(tree, 'FlatList').props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: message('1') }] });
    app.render(); await app.commit(); assert.equal(calls.length, 1);
    fail = false; app.page(page([])); app.render(); await app.commit();
    assert.deepEqual(calls, [{ tokens: ['visible-token-1'] }, { tokens: ['visible-token-1'] }]);
    app.page(page([])); app.render(); await app.commit(); assert.equal(calls.length, 2);
    // A failed ACK that is no longer visible must not be retried by a refresh.
    fail = true; tree = app.render();
    find(tree, 'FlatList').props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: message('2') }] });
    app.render(); await app.commit(); assert.equal(calls.length, 3);
    find(tree, 'FlatList').props.onViewableItemsChanged({ viewableItems: [] });
    app.render(); await app.commit(); fail = false; app.page(page([])); app.render(); await app.commit();
    assert.equal(calls.length, 3);
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});


test('Temporary browser chat warns only for unsent text and removes its beforeunload guard after clearing or leaving', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), listeners = new Set<(event: any) => void>(), changed: boolean[] = [];
  const app = component(db, async <T>() => ({ seen: 1 }) as T, { Platform: { OS: 'web' }, storageIsDurable: () => false, window: { addEventListener: (name: string, fn: any) => { assert.equal(name, 'beforeunload'); listeners.add(fn); }, removeEventListener: (_name: string, fn: any) => listeners.delete(fn) } });
  try {
    await migrate(db); app.render({ online: false, onUnsentChange: (unsent: boolean) => changed.push(unsent) }); await app.commit();
    let tree = app.render({ online: false, onUnsentChange: (unsent: boolean) => changed.push(unsent) }); await app.commit(); assert.equal(listeners.size, 0);
    const composer = () => nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'ChatComposer')!;
    composer().props.onChange('Temporary unsent text'); tree = app.render({ online: false, onUnsentChange: (unsent: boolean) => changed.push(unsent) }); await app.commit();
    assert.equal(listeners.size, 1); assert.ok(nodes(tree).some(node => node.children.includes('Unsent text lasts only in this tab.')));
    assert.ok(!nodes(tree).some(node => node.children.includes('Offline. Your draft stays here.')));
    let prevented = false; const event = { preventDefault: () => { prevented = true; }, returnValue: undefined as unknown };
    [...listeners][0](event); assert.equal(prevented, true); assert.equal(event.returnValue, '');
    composer().props.onChange(''); tree = app.render({ online: false, onUnsentChange: (unsent: boolean) => changed.push(unsent) }); await app.commit(); assert.equal(listeners.size, 0);
    composer().props.onChange('Another draft'); app.render({ online: false, onUnsentChange: (unsent: boolean) => changed.push(unsent) }); await app.commit(); assert.equal(listeners.size, 1);
    app.unmount(); assert.equal(listeners.size, 0); assert.deepEqual(changed, [false, true, false, true]);
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});


test('Compact composer keeps drafts editable while sending and rejects empty sends', () => {
  const raw = new DatabaseSync(':memory:'), app = component(sqliteAdapter(raw), async <T>() => ({}) as T);
  try {
    let tree = app.composer({ text: '   ', disabled: false, onChange: () => {}, onSend: () => {} });
    assert.equal(find(tree, 'TextInput').props.accessibilityLabel, 'Message');
    assert.equal(nodes(tree).find(node => node.props.accessibilityLabel === 'Send message')!.props.disabled, true);
    tree = app.composer({ text: 'New draft', disabled: false, sendDisabled: true, onChange: () => {}, onSend: () => {} });
    assert.equal(find(tree, 'TextInput').props.editable, true);
    assert.equal(nodes(tree).find(node => node.props.accessibilityLabel === 'Send message')!.props.disabled, true);
    assert.ok(!nodes(tree).some(node => node.props.label === 'Message' || node.props.title === 'Send'));
  } finally { raw.close(); }
});

test('Empty-state suggestions only compose text, and read-only chats disable them', () => {
  const raw = new DatabaseSync(':memory:'), app = component(sqliteAdapter(raw), async <T>() => ({}) as T), drafts: string[] = [];
  try {
    let tree = app.empty({ disabled: false, onSuggest: (text: string) => drafts.push(text) });
    button(tree, 'Check my share').props.onPress();
    button(tree, 'What’s included?').props.onPress();
    assert.deepEqual(drafts, ['Can you confirm my share?', 'What’s included in this bill?']);
    tree = app.empty({ disabled: true, onSuggest: () => {} });
    assert.equal(button(tree, 'Check my share').props.disabled, true);
  } finally { raw.close(); }
});
