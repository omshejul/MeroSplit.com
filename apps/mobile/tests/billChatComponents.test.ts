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
    Platform: { OS: 'native' }, KeyboardAvoidingView: 'KeyboardAvoidingView', useSafeAreaInsets: () => ({ top: 24, bottom: 24 }), storageIsDurable: () => true, View: 'View', BottomSafeArea: 'BottomSafeArea', Text: 'Text', FlatList: 'FlatList', ScrollView: 'ScrollView', Button: 'Button', TextField: 'TextField', TextInput: 'TextInput', Icon: 'Icon', ChatComposerSurface: 'ChatComposerSurface', IconAction: 'IconAction', SettingsRow: 'SettingsRow', ChatControls: 'ChatControls', ChatMenu: 'ChatMenu', KeyboardDialog: 'KeyboardDialog', Dialog: Object.assign(() => {}, { Title: 'Title', Content: 'Content', Actions: 'Actions' }),
    Crypto: { randomUUID: () => 'synthetic-client-uuid' }, ApiError, accountOwner, request: send, getDatabase: async () => db, useUI: () => ({ ui: {}, palette: {}, motion: { enabled: true } }), useWindowDimensions: () => ({ height: 720 }), Linking: { openURL: async () => {} },
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
  env.ChatLoadingState = 'ChatLoadingState';
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
    await migrate(db); const empty = app.render(); assert.equal(find(empty, 'FlatList').props.inverted, false); await app.commit(); app.page(page([message('1'), message('2')]));
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

test('Quiet receipt keeps the same bubble key across server confirmation and excludes optimistic rows from read ACKs', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), calls: any[] = [];
  let confirm!: (value: any) => void;
  const send: typeof request = async <T>(_session: Session, path: string, _method?: string, body?: any): Promise<T> => {
    calls.push({ path, body });
    if (path.endsWith('/chat')) return new Promise(resolve => { confirm = resolve; });
    return { seen: 1 } as T;
  };
  const app = component(db, send);
  const composer = (tree: any) => nodes(tree).find(node => node.type?.name === 'ChatComposer')!;
  try {
    await migrate(db); app.render(); await app.commit(); app.page(page([]));
    let tree = app.render(); await app.commit();
    const scrolls: any[] = [];
    let initial = find(tree, 'FlatList'); initial.props.ref.current = { scrollToOffset: (value: any) => scrolls.push(value) };
    initial.props.onContentSizeChange(320, 80);
    initial.props.onScrollBeginDrag(); initial.props.onScroll({ nativeEvent: { contentOffset: { y: 200 } } });
    composer(tree).props.onChange('Yes, ₹200 each.'); tree = app.render(); await app.commit();
    composer(tree).props.onSend(); await tick(); tree = app.render(); await app.commit();
    let flat = find(tree, 'FlatList'), row = flat.props.data[0];
    flat.props.onContentSizeChange(320, 160);
    assert.deepEqual(scrolls.at(-1), { offset: 0, animated: false }, 'first local message positions the empty history immediately');
    flat.props.onContentSizeChange(320, 180);
    assert.deepEqual(scrolls.at(-1), { offset: 0, animated: true }, 'sending follows the pending bubble without waiting for confirmation');
    assert.equal(row.pending.text, 'Yes, ₹200 each.');
    assert.equal(flat.props.inverted, true);
    const key = flat.props.keyExtractor(row);
    const pendingView = app.row({ ...flat.props.renderItem({ item: row, index: 0 }).props });
    assert.ok(nodes(pendingView).some(node => node.type === 'Icon' && node.props.name === 'history'));
    assert.ok(!nodes(pendingView).some(node => node.props.title === 'Retry'));
    assert.equal(composer(tree).props.disabled, false);
    flat.props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, item: row }] });
    tree = app.render(); await app.commit();
    assert.equal(calls.length, 1, 'A local bubble must never emit a seen request');
    composer(tree).props.onChange('A new draft');
    confirm({ ...message('99'), client_id: row.client_id, sender_id: session.userId, text: row.text });
    await tick(); tree = app.render(); await app.commit();
    flat = find(tree, 'FlatList'); row = flat.props.data[0];
    assert.equal(flat.props.data.length, 1); assert.equal(row.pending, undefined);
    assert.equal(flat.props.keyExtractor(row), key);
    assert.equal(composer(tree).props.text, 'A new draft');
    const savedView = app.row({ ...flat.props.renderItem({ item: row, index: 0 }).props });
    assert.ok(nodes(savedView).some(node => node.type === 'Icon' && node.props.name === 'check'));
    assert.ok(nodes(savedView).some(node => node.props.accessibilityLabel === 'Sent'));
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});

test('Quiet receipt keeps failure/retry beside its bubble and reuses the immutable client ID', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), ids: string[] = []; let fail = true;
  const send: typeof request = async <T>(_session: Session, path: string, _method?: string, body?: any): Promise<T> => {
    if (path.endsWith('/chat')) {
      ids.push(body.client_id);
      if (fail) throw Error('Connection lost before confirmation');
      return { ...message('101'), client_id: body.client_id, sender_id: session.userId, text: body.text } as T;
    }
    return { seen: 1 } as T;
  };
  const app = component(db, send);
  try {
    await migrate(db); app.render(); await app.commit(); app.page(page([])); let tree = app.render(); await app.commit();
    const compose = () => nodes(tree).find(node => node.type?.name === 'ChatComposer')!;
    compose().props.onChange('Saved message'); tree = app.render(); await app.commit(); compose().props.onSend();
    await tick(); await chat.flushChatWrites(); await tick(); tree = app.render(); await app.commit();
    const flat = find(tree, 'FlatList'), row = flat.props.data[0], rendered = flat.props.renderItem({ item: row, index: 0 });
    const bubble = app.row(rendered.props);
    assert.ok(nodes(bubble).some(node => node.props.accessibilityLabel === 'Not confirmed'));
    assert.ok(button(bubble, 'Retry'));
    assert.ok(!find(tree, 'BottomSafeArea').children.some((node: any) => node?.type === 'ScrollView'));
    fail = false; rendered.props.onRetry(); await tick(); tree = app.render(); await app.commit();
    assert.deepEqual(ids, ['synthetic-client-uuid', 'synthetic-client-uuid']);
    assert.equal(find(tree, 'FlatList').props.data.length, 1);
    assert.equal(find(tree, 'FlatList').props.data[0].pending, undefined);
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});

test('Quiet receipt labels offline and rejected messages without claiming they were sent', () => {
  const raw = new DatabaseSync(':memory:'), app = component(sqliteAdapter(raw), async <T>() => ({}) as T);
  const pending = { id: 'client', text: 'Unsent', error: 'Unknown network outcome' };
  const row = chat.chatMessageRows([], [pending], session.userId)[0];
  try {
    const offline = app.row({ message: row, own: true, active: false, showDate: false, online: false });
    assert.ok(nodes(offline).some(node => node.props.accessibilityLabel === 'Waiting for connection'));
    assert.ok(!nodes(offline).some(node => node.props.title === 'Retry'));
    const rejected = app.row({ message: { ...row, pending: { ...pending, rejected: true } }, own: true, active: true, showDate: false, online: false });
    assert.ok(button(rejected, 'Edit message'));
    assert.ok(nodes(rejected).some(node => node.props.accessibilityLabel === 'Not sent'));
  } finally { app.unmount(); raw.close(); }
});

for (const motion of [true, false]) test(`Chat follows new messages smoothly only when appropriate, motion=${motion}`, async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), scrolls: any[] = [];
  const app = component(db, async <T>() => ({ seen: 1 }) as T, { useUI: () => ({ ui: {}, palette: {}, motion: { enabled: motion } }) });
  try {
    await migrate(db); let tree = app.render(); await app.commit();
    let flat = find(tree, 'FlatList'); flat.props.ref.current = { scrollToOffset: (v: any) => scrolls.push(v) };
    flat.props.onContentSizeChange(320, 0);
    app.page(page([message('1')])); tree = app.render(); await app.commit(); flat = find(tree, 'FlatList'); flat.props.onContentSizeChange(320, 100);
    assert.equal(scrolls.at(-1).animated, false, 'initial history is positioned immediately');
    app.page(page([message('2')])); tree = app.render(); await app.commit(); flat = find(tree, 'FlatList'); flat.props.onContentSizeChange(320, 200);
    assert.equal(scrolls.at(-1).animated, motion, 'new incoming message follows smoothly');
    flat.props.onScroll({ nativeEvent: { contentOffset: { y: 180 } } }); const following = scrolls.length;
    app.page(page([message('25')])); tree = app.render(); await app.commit(); flat = find(tree, 'FlatList'); flat.props.onContentSizeChange(320, 240);
    assert.equal(scrolls.length, following + 1, 'messages arriving during programmatic scrolling keep following');
    flat.props.onScrollBeginDrag(); flat.props.onScroll({ nativeEvent: { contentOffset: { y: 300 } } }); const before = scrolls.length;
    app.page(page([message('3')])); tree = app.render(); await app.commit(); flat = find(tree, 'FlatList'); flat.props.onContentSizeChange(320, 200);
    assert.equal(scrolls.length, before, 'incoming message cannot pull the reader away');
    assert.ok(button(tree, 'New messages')); button(tree, 'New messages').props.onPress();
    assert.deepEqual(scrolls.at(-1), { offset: 0, animated: motion });
  } finally { app.unmount(); await chat.flushChatWrites(); raw.close(); }
});

test('initial history shows placeholders, then only confirmed empty history shows suggestions',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),app=component(db,async<T>()=>({seen:1})as T);
 const empty=(tree:any)=>find(tree,'FlatList').props.ListEmptyComponent;
 const has=(tree:any,type:string):boolean=>!!tree&&typeof tree==='object'&&(tree.type===type||tree.type?.name===type||(tree.children??[]).flat(Infinity).some((child:any)=>has(child,type)));
 try{await migrate(db);assert.ok(has(empty(app.render()),'ChatLoadingState'));await app.commit();assert.ok(has(empty(app.render()),'ChatLoadingState'));app.page(page([]));const known=app.render();assert.equal(has(empty(known),'ChatLoadingState'),false);assert.ok(has(empty(known),'ChatEmptyState'))}finally{app.unmount();raw.close()}
});
test('failed, offline and background history do not claim to still be loading',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),app=component(db,async<T>()=>({seen:1})as T);
 const has=(tree:any):boolean=>!!tree&&typeof tree==='object'&&(tree.type==='ChatLoadingState'||(tree.children??[]).flat(Infinity).some(has));
 try{await migrate(db);app.render();await app.commit();app.fail(Error('History unavailable'));assert.equal(has(find(app.render(),'FlatList').props.ListEmptyComponent),false);assert.equal(has(find(app.render({online:false}),'FlatList').props.ListEmptyComponent),false);assert.equal(has(find(app.render({active:false}),'FlatList').props.ListEmptyComponent),false)}finally{app.unmount();raw.close()}
});
