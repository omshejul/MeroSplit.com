import { withSharedUI } from './componentHarness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ApiError } from '../src/api.ts';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, saveGroup, readVisibleGroup } from '../src/storage.ts';

const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nav = ts.createSourceFile('AppNavigation.tsx', readFileSync(new URL('../src/AppNavigation.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function production(name: string, env: any, source = app) {
  let found: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); }
  visit(source); assert.ok(found, name);
  return new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${ts.transpile(found.getText(source).replace(/^export (?:default )?/, ''), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return ${name}}`)(withSharedUI(env));
}
const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) };
function nodes(tree: any): any[] { return Array.isArray(tree) ? tree.flatMap(nodes) : tree?.children ? [tree, ...tree.children.flatMap(nodes)] : []; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  const response = deferred<any>(), active = { token: 'A' }, group = { id: 'g', version: 1 };
  const state: any = { busy: false, reading: 0, route: {}, navigations: [], saved: [] };
  const env: any = { ApiError, appUpdates: { engage() {} }, session: active, selected: { group }, pending: [], lock: { current: false },
    scopeGeneration: { current: 0 }, browseCurrent: { current: 'route-one' }, activeSessionRef: { current: active }, ownerRef: { current: 'owner' }, owner: 'owner',
    profileRevision: { current: 0 }, opening: { current: null }, openRequests: { current: new Map() }, submissions: { current: new Set() }, authHeldRef: { current: false }, navigation: { ref: { getRootState: () => state.route, getCurrentRoute: () => ({ key: state.route.key ?? 'route-one' }) } },
    setBusyRoutes: (v: string[]) => state.busy = v.length > 0,
    setReading: (v: any) => state.reading = typeof v === 'function' ? v(state.reading) : v,
    setBusy: (v: boolean) => state.busy = v, setNotice() {}, setExpired() {}, publishIfChanged: async () => {},
    withBill: () => response.promise, withPayment: () => response.promise, getDatabase: async () => ({ withExclusiveTransactionAsync: async (work: any) => work({}) }), accountOwner: () => 'owner', readVisibleGroup: async () => null,
    saveGroup: async (_db: any, _owner: any, value: any) => state.saved.push(value), navigate: (...args: any[]) => state.navigations.push(args),
  };
  env.setSubmission = production('setSubmission', env); env.perform = production('perform', env);
  env.background = production('background', env); env.browse = production('browse', env);
  env.saveReadGroup = production('saveReadGroup', env);
  return { env, state, response, group };
}

test('slow production bill read leaves unrelated controls editable and releases no duplicate write protection', async () => {
  const f = fixture(), opening = production('openBill', f.env)({ id: 'bill' });
  assert.equal(f.state.busy, false, 'a detail GET must not set the global form busy flag');
  assert.equal(f.env.lock.current, false, 'a detail GET must not own the mutation lock');
  f.response.resolve(f.group); await opening;
});

test('a late production detail read cannot navigate after leaving its route or changing account', async () => {
  for (const change of ['route', 'account']) {
    const f = fixture(), opening = production('openBill', f.env)({ id: 'bill' });
    if (change === 'route') { f.env.browseCurrent.current = 'route-two'; f.state.route = { key: 'route-two' }; }
    else f.env.activeSessionRef.current = { token: 'B' };
    f.response.resolve(f.group); await opening;
    assert.deepEqual(f.state.navigations, [], change);
  }
});

test('production header keeps Back and Feedback actions without a global loading indicator', () => {
  const actions: string[] = [];
  const env = { React, useUI: () => ({ palette: {} }), styles: {}, View: 'View', Text: 'Text', IconAction: 'IconAction', ActivityIndicator: 'ActivityIndicator' };
  const tree = production('ScreenHeader', env, nav)({ title: 'Groups', busy: true, onBack: () => actions.push('back'), onFeedback: () => actions.push('feedback') });
  const buttons = nodes(tree).filter(n => n.type === 'IconAction');
  assert.deepEqual(buttons.map(n => n.props.label), ['Back', 'Feedback']);
  assert.ok(buttons.every(n => !n.props.disabled)); buttons.forEach(n => n.props.onPress());
  assert.deepEqual(actions, ['back', 'feedback']);
  assert.ok(!nodes(tree).some(n => n.type === 'ActivityIndicator'));
});

test('production tabs remain selectable while a request is loading', () => {
  const selected: string[] = [];
  const env = { React, useUI: () => ({ palette: {}, motion: { enabled: false } }), useMotionValue: () => 1, Platform: { OS: 'ios' }, styles: {}, Button: 'Button', Animated: { View: 'View' }, View: 'View', Text: 'Text', Icon: 'Icon', StyleSheet: { absoluteFill: {} }, radii: {} };
  const tree = production('TabButton', env, nav)({ item: { value: 'Account', label: 'Me' }, selected: false, busy: true, onSelect: (v: string) => selected.push(v) });
  assert.ok(!tree.props.disabled); assert.ok(!tree.props.accessibilityState.disabled);
  tree.props.onPress(); assert.deepEqual(selected, ['Account']);
});

test('real repeated taps coalesce, while input or Feedback interaction cancels only late navigation', async () => {
  const f = fixture(); let reads = 0, engagements = 0;
  f.env.withBill = () => { reads++; return f.response.promise; };
  const engage = production('engage', { ...f.env, notices: { engage: () => engagements++ } });
  const open = production('openBill', f.env);
  const first = open({ id: 'bill' }); engage(); const second = open({ id: 'bill' });
  assert.equal(reads, 1, 'the second touch rejoins the existing request');
  const draft = { value: 'still editing', feedbackOpen: true }; engage();
  f.response.resolve(f.group); await Promise.all([first, second]);
  assert.deepEqual(f.state.navigations, []); assert.equal(f.state.reading, 0);
  assert.deepEqual(draft, { value: 'still editing', feedbackOpen: true }); assert.equal(engagements, 2);
});

test('latest chosen bill wins even if an older response finishes after it', async () => {
  const f = fixture(), old = deferred<any>(), latest = deferred<any>();
  f.env.withBill = (_active: any, _group: any, id: string) => id === 'old' ? old.promise : latest.promise;
  const open = production('openBill', f.env), first = open({ id: 'old' }), second = open({ id: 'latest' });
  latest.resolve(f.group); await second; old.resolve(f.group); await first;
  assert.deepEqual(f.state.navigations, [['expenseDetail', { expenseId: 'latest' }]]);
});

test('a stale account callback cannot start another account read', async () => {
  const f = fixture(); f.env.activeSessionRef.current = { token: 'B' }; let reads = 0;
  f.env.withBill = () => { reads++; return Promise.resolve(f.group); };
  await assert.rejects(production('openBill', f.env)({ id: 'old-account' }), /account changed/i);
  assert.equal(reads, 0); assert.deepEqual(f.state.navigations, []);
});

test('delayed export cannot open a sharing dialog over another screen', async () => {
  const f = fixture(), data = deferred<any>(); let shares = 0;
  Object.assign(f.env, { draftWrites: { current: Promise.resolve() }, flushChatWrites: async () => {}, isOnline: () => true, portableExport: () => data.promise, shareJson: async () => { shares++; } });
  const exporting = production('exportData', f.env)(); await Promise.resolve();
  f.state.route = { key: 'elsewhere' }; data.resolve({ account_data_status: 'included' }); await exporting;
  assert.equal(shares, 0); assert.equal(f.state.busy, false);
});

test('actual account export callsite keeps its deferred read outside the submission lock', async () => {
  const f = fixture(), data = deferred<any>();
  Object.assign(f.env, { draftWrites: { current: Promise.resolve() }, flushChatWrites: async () => {}, isOnline: () => true, portableExport: () => data.promise, shareJson: async () => {} });
  f.env.exportData = production('exportData', f.env);
  let callback: ts.Expression | undefined;
  function visit(n: ts.Node) { if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(app) === 'ExportData') { const attr = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(app) === 'onExport') as ts.JsxAttribute; callback = (attr.initializer as ts.JsxExpression).expression; } ts.forEachChild(n, visit); } visit(app); assert.ok(callback);
  const run = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';return ${callback.getText(app)};}`)(withSharedUI(f.env));
  const exporting = run(); await Promise.resolve();
  assert.equal(f.state.busy, false); assert.equal(f.env.lock.current, false);
  data.resolve({ account_data_status: 'included' }); await exporting;
});

test('actual GroupScreen search callback never scrolls for a stale discarded response', async () => {
  const file = ts.createSourceFile('GroupScreen.tsx', readFileSync(new URL('../src/GroupScreen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  function visit(n: ts.Node) { if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(file) === 'BillSearch') { const attr = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(file) === 'onSearch') as ts.JsxAttribute; callback = (attr.initializer as ts.JsxExpression).expression; } ts.forEachChild(n, visit); } visit(file); assert.ok(callback);
  const offsets: any[] = [], response = deferred<boolean>();
  let searchFunction: ts.FunctionDeclaration | undefined;
  function find(n: ts.Node) { if (ts.isFunctionDeclaration(n) && n.name?.text === 'runSearch') searchFunction = n; ts.forEachChild(n, find); } find(file); assert.ok(searchFunction);
  const env = { setLoadingSearch() {}, AbortController, searchRequest: { current: null }, historyWindow: {}, onHistoryPage: () => response.promise, historyResource: 'transactions', search: 'text', accepted: {}, list: { current: { scrollToOffset: (v: any) => offsets.push(v) } } };
  const run = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${ts.transpile(searchFunction.getText(file), {target: ts.ScriptTarget.ES2022})};return ${callback.getText(file)};}`)(withSharedUI(env));
  run(); response.resolve(false); for (let i = 0; i < 10; i++) await Promise.resolve(); assert.deepEqual(offsets, []);
});

test('a real Back and return to the same screen still invalidates an older navigation read', async () => {
  const f = fixture(), open = production('openBill', f.env), first = open({ id: 'bill' });
  f.state.route = { key: 'route-one' }; // New navigator state, even with the same restored route key.
  f.response.resolve(f.group); await first; assert.deepEqual(f.state.navigations, []);
});

test('submission lock rejects the same action twice but does not lock a different route or release another write', async () => {
  const f = fixture(), write = deferred<void>(); let posts = 0;
  const first = f.env.perform(() => { posts++; return write.promise; });
  await assert.rejects(f.env.perform(async () => { posts++; }), /Please wait/); assert.equal(posts, 1);
  f.state.route = { key: 'unrelated' }; await f.env.perform(async () => { posts++; });
  assert.equal(posts, 2); assert.equal(f.env.lock.current, true, 'the first write still owns its lock');
  assert.equal(f.env.submissions.current.has('unrelated'), false);
  write.resolve(); await first; assert.equal(f.env.lock.current, false);
  f.env.lock.current = true; await assert.rejects(f.env.perform(async () => {}), /Please wait/, 'reserved restart lock remains exclusive');
});

test('independent named account actions stay usable without allowing duplicate submissions', async () => {
  const f = fixture(), write = deferred<void>();
  const first = f.env.perform(() => write.promise, true, 'profile-name');
  await assert.rejects(f.env.perform(async () => {}, true, 'profile-name'), /Please wait/);
  await f.env.perform(async () => {}, false, 'appearance');
  assert.equal(f.env.lock.current, true); assert.equal(f.env.submissions.current.has('route-one'), false);
  write.resolve(); await first; assert.equal(f.env.lock.current, false);
});

test('actual background sync coalesces without taking the submission lock', async () => {
  const f = fixture(), done = deferred<void>(); let runs = 0;
  Object.assign(f.env, { accountRefresh: { current: null }, runAccountRefresh: () => { runs++; return done.promise; } });
  f.env.syncAccount = production('syncAccount', f.env); f.env.sync = production('sync', f.env);
  let declaration: ts.VariableDeclaration | undefined;
  function visit(n: ts.Node) { if (ts.isVariableDeclaration(n) && n.name.getText(app) === 'syncQuietly') declaration = n; ts.forEachChild(n, visit); } visit(app); assert.ok(declaration?.initializer);
  const sync = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';return ${declaration.initializer.getText(app)};}`)(withSharedUI(f.env));
  sync(); sync(); assert.equal(runs, 1); assert.equal(f.state.busy, false); assert.equal(f.env.lock.current, false);
  await f.env.perform(async () => {}); done.resolve(); for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(f.state.reading, 0);
});

test('a current refresh expires only its own401 session after the global read lock is removed', async () => {
  for (const stale of [false, true]) {
    const f = fixture(), response = deferred<any>(); let expired = false;
    Object.assign(f.env, { setSyncing() {}, setSyncProblem() {}, setVerifiedEmptyOwner() {}, setExpired: () => { expired = true; }, readProfile: () => response.promise });
    const refreshing = production('runAccountRefresh', f.env)(f.env.session);
    await Promise.resolve(); if (stale) f.env.activeSessionRef.current = { token: 'new-account' };
    response.resolve(Promise.reject(new ApiError(401, 'Expired')));
    await assert.rejects(refreshing, /Expired/); assert.equal(expired, !stale);
  }
});

test('the actual ProfileSettings callsite keeps a typed name draft editable during a deferred bill read', async () => {
  const f = fixture(), pending = production('openBill', f.env)({ id: 'bill' });
  let element: ts.JsxSelfClosingElement | undefined;
  function visit(n: ts.Node) { if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(app) === 'ProfileSettings') element = n; ts.forEachChild(n, visit); } visit(app); assert.ok(element);
  const props = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${ts.transpile('return '+element.getText(app), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}}`)(withSharedUI({ React, ProfileSettings: 'ProfileSettings', owner: 'owner', myName: 'Original', vpa: '', busy: f.state.busy, saveName() {}, saveUPI() {} })).props;
  const source = ts.createSourceFile('ProfileSettings.tsx', readFileSync(new URL('../src/ProfileSettings.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let cursor = 0; const slots: any[] = [];
  const env = { React, useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => slots[i] = value]; }, useRef: (initial: any) => { const i = cursor++; return slots[i] ??= { current: initial }; }, useEffect() {},
    useUI: () => ({ ui: {}, palette: {}, inputColors: {}, appearance: 'system', colorFamily: 'basic' }), useWindowDimensions: () => ({ height: 900 }), modes: [{ value: 'system', label: 'System' }], colorFamilies: [{ value: 'basic', label: 'Basic' }], isDarkOnly: () => false, validUPIAddress: () => true, Platform: { OS: 'ios' },
    View: 'View', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', SettingsRow: 'SettingsRow', KeyboardDialog: 'KeyboardDialog', DialogScrollBody: 'DialogScrollBody', Dialog: { Title: 'Title', Actions: 'Actions' }, Button: 'Button', ErrorText: 'ErrorText', CancelDialogActions: 'CancelDialogActions', Keyboard: { dismiss() {} },
  };
  const render = production('ProfileSettings', env, source), view = () => { cursor = 0; return nodes(render(props)); };
  view().find(n => n.type === 'SettingsRow' && n.props.label === 'Name').props.onPress();
  let input = view().find(n => n.type === 'TextInput'); assert.equal(input.props.editable, true); input.props.onChangeText('My unfinished name');
  const engage = production('engage', { ...f.env, notices: { engage() {} } }); engage();
  f.response.resolve(f.group); await pending; input = view().find(n => n.type === 'TextInput');
  assert.equal(input.props.value, 'My unfinished name'); assert.equal(input.props.editable, true); assert.deepEqual(f.state.navigations, []);
});

test('actual App stack and hardware Back ignore loading while auth and local critical removal guards remain', () => {
  let blocked: ts.Expression | undefined, handler: ts.ArrowFunction | undefined;
  function visit(n: ts.Node) {
    if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(app) === 'AppStack') {
      const a = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(app) === 'blocked') as ts.JsxAttribute;
      blocked = (a.initializer as ts.JsxExpression).expression;
    }
    if (ts.isCallExpression(n) && n.expression.getText(app) === 'BackHandler.addEventListener') handler = n.arguments[1] as ts.ArrowFunction;
    ts.forEachChild(n, visit);
  } visit(app); assert.ok(blocked && handler);
  const evaluate = new Function('busy', 'authHeld', `return ${blocked.getText(app)};`);
  assert.equal(evaluate(true, false), false); assert.equal(evaluate(false, true), true);
  const env: any = { busy: true, authHeldRef: { current: false }, screen: 'expenseDetail', tab: 'Groups', showArchived: false, showHidden: false };
  const run = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${ts.transpile('const back=' + handler.getText(app) + ';return back;', { target: ts.ScriptTarget.ES2022 })}}`)(withSharedUI(env));
  assert.equal(run(), false); env.authHeldRef.current = true; assert.equal(run(), true);
});

test('profile GET cannot reopen a dialog after interaction, overwrite a newer save or rewrite native credentials', async () => {
  const f = fixture(); let me = deferred<any>(), writes = 0;
  const names: string[] = [], prompts: boolean[] = [], addresses: string[] = [];
  Object.assign(f.env, { profileRevision: { current: 0 }, profilePromptSafe: { current: true }, upiPrompts: { current: new Set() },
    request: () => me.promise, setMyName: (v: string) => names.push(v), setVpa: (v: string) => addresses.push(v), setUpiSetup: (v: boolean) => prompts.push(v),
    Platform: { OS: 'ios' }, saveSession: async () => { writes++; }, setSession() {},
  });
  f.env.rememberName = production('rememberName', f.env); const read = production('readProfile', f.env);
  const first = read(f.env.session); f.env.profilePromptSafe.current = false;
  me.resolve({ display_name: 'Server name', payment_profile: null }); await first;
  assert.equal(writes, 0); assert.deepEqual(names, ['Server name']); assert.deepEqual(prompts, []);
  me = deferred(); const old = read(f.env.session); f.env.profileRevision.current++;
  me.resolve({ display_name: 'Old name', payment_profile: { vpa: 'old@bank' } }); await old;
  assert.deepEqual(names, ['Server name']); assert.deepEqual(addresses, ['']);
});

test('concurrent history searches publish only the latest query and never block a form', async () => {
  const f = fixture(), old = deferred<any>(), latest = deferred<any>();
  Object.assign(f.group, { expenses: [], settlements: [], transactions: [], history: { transactions: { query: '', next_cursor: null } } });
  Object.assign(f.env, { activeGroupRef: { current: 'g' }, selfId: 'self', load: async () => {}, setLedgerRevision() {},
    request: (_active: any, path: string) => path.includes('q=old') ? old.promise : latest.promise,
  });
  const page = production('historyPage', f.env), first = page('transactions', 'search', 'old'), second = page('transactions', 'search', 'latest');
  assert.equal(f.state.busy, false);
  const response = (id: string) => ({ read_mode: 'page', group_id: 'g', version: 1, items: [{ kind: 'bill', bill: { id } }], next_cursor: null });
  latest.resolve(response('latest')); assert.equal(await second, true); old.resolve(response('old')); assert.equal(await first, false);
  assert.equal(f.state.saved.length, 1); assert.equal(f.state.saved[0].history.transactions.query, 'latest');
});

test('real SQLite detail publication keeps newer pages/balances and cannot restore revoked access', async () => {
  const f = fixture(), raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); await migrate(db);
  const accepted: any = { ...f.group, read_mode: 'summary', expenses: [], settlements: [], transactions: [{ kind: 'bill', bill: { id: 'downloaded' } }], balances: { self: '400' }, history: { transactions: { query: 'current', next_cursor: 'older' } } };
  await saveGroup(db, 'owner', accepted, 'shared');
  Object.assign(f.env, { getDatabase: async () => db, readVisibleGroup, saveGroup });
  const save = production('saveReadGroup', f.env);
  assert.equal(await save(f.env.session, { ...accepted, transactions: [], balances: { self: '0' }, history: {}, focused_expense: { id: 'detail' } }), true);
  const kept = (await readVisibleGroup(db, 'owner', 'g'))!.group;
  assert.deepEqual(kept.transactions, accepted.transactions); assert.deepEqual(kept.balances, accepted.balances); assert.deepEqual(kept.history, accepted.history);
  await saveGroup(db, 'owner', { ...accepted, version: 2 }, 'unavailable');
  assert.equal(await save(f.env.session, accepted), false); assert.equal((await readVisibleGroup(db, 'owner', 'g'))!.kind, 'unavailable');
  raw.close();
});
