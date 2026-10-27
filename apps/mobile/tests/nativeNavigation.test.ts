import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import * as routes from '../src/routes.ts';

// Real router/state and URL codec, with only the native rendering boundary supplied.
const native = createRequire(import.meta.url).resolve('@react-navigation/native/package.json');
const core = createRequire(native).resolve('@react-navigation/core/package.json');
const { StackRouter, StackActions, CommonActions } = await import(pathToFileURL(createRequire(core).resolve('@react-navigation/routers')).href);
const { getStateFromPath } = await import(pathToFileURL(join(dirname(core), 'lib/module/getStateFromPath.js')).href);
const { getPathFromState } = await import(pathToFileURL(join(dirname(core), 'lib/module/getPathFromState.js')).href);
const source = ts.createSourceFile('AppStack.tsx', readFileSync(new URL('../src/AppStack.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const code = ts.transpile(source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n'), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }), Fragment: 'Fragment' };
const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.children ? [tree, ...tree.children.flatMap(nodes)] : [];
function module(env: Record<string, any> = {}) {
  const context = { render: () => null, blocked: false };
  const scope = { ...routes, React, StackActions, getStateFromPath, Platform: { OS: 'web' }, createContext: () => context,
    createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen', Group: 'Group' }), useUI: () => ({ palette: {}, motion: { enabled: true } }),
    KeyboardDialog: 'KeyboardDialog', DialogFocus: 'DialogFocus', Dialog: { Title: 'Title' }, CancelDialogActions: 'CancelDialogActions', Button: 'Button',
    ScreenDraftDiscard: { Provider: 'DraftDiscard' }, ScreenRemovalLock: { Provider: 'Lock' }, useCallback: (fn: any) => fn, ...env };
  return new Function('env', `with(env){${code};return {useAppNavigation,RouteScene,AppStack,webLinking};}`)(scope);
}
function navigationHarness() {
  const router = StackRouter({ initialRouteName: 'home' });
  const config = { routeNames: routes.screenNames, routeParamList: { home: { tab: 'Groups' } }, routeGetIdList: {} };
  let state = router.getInitialState(config), actions: any[] = [], intercept: ((action: any) => void) | undefined;
  const apply = (action: any) => { const next = router.getStateForAction(state, action, config); if (next) state = next.stale === false ? next : router.getRehydratedState(next, config); };
  const ref: any = { isReady: () => true, addListener: () => () => {}, getRootState: () => state, getCurrentRoute: () => state.routes[state.index], canGoBack: () => state.index > 0,
    goBack: () => ref.dispatch(CommonActions.goBack()), dispatch: (action: any) => { actions.push(action); if (intercept) intercept(action); else apply(action); } };
  ref.current = ref;
  const api = module({ useNavigationContainerRef: () => ref, useSyncExternalStore: (_subscribe: any, snapshot: any) => snapshot() });
  return { apply, intercept: (handler: (action: any) => void) => { intercept = handler; }, navigation: () => api.useAppNavigation(), state: () => state, names: () => state.routes.map((route: any) => route.name), actions,
    reset: (route: routes.AppRoute) => ref.dispatch(CommonActions.reset({ index: 0, routes: [route] })) };
}

test('native push/pop retains Groups -> group -> bill -> history/chat and Settings returns once', () => {
  const h = navigationHarness();
  h.navigation().go('group', { groupId: 'g' }); const groupKey = h.state().routes.at(-1).key;
  h.navigation().go('expenseDetail', { expenseId: 'b' });
  h.navigation().go('expenseVersions');
  assert.deepEqual(h.names(), ['home', 'group', 'expenseDetail', 'expenseVersions']);
  h.navigation().back(true); assert.deepEqual(h.names(), ['home', 'group', 'expenseDetail']);
  h.navigation().go('billChat'); h.navigation().back(true); h.navigation().back(true);
  assert.deepEqual(h.names(), ['home', 'group']); assert.equal(h.state().routes.at(-1).key, groupKey);
  h.navigation().go('members'); h.navigation().back(true); assert.deepEqual(h.names(), ['home', 'group']);
  h.navigation().go('home', { tab: 'Account' }); h.navigation().go('signInMethods'); h.navigation().back(true);
  assert.deepEqual(h.names(), ['home']); assert.equal(h.navigation().route.params.tab, 'Account');
});

test('save returns to existing group; cross-group and cold entries have real fallback parents', () => {
  const h = navigationHarness();
  h.navigation().go('group', { groupId: 'g' }); const groupKey = h.state().routes.at(-1).key;
  h.navigation().go('expense', { expenseId: null }); h.navigation().go('group');
  assert.deepEqual(h.names(), ['home', 'group']); assert.equal(h.state().routes.at(-1).key, groupKey);
  h.navigation().go('billChat', { groupId: 'other', expenseId: 'other-bill' });
  assert.deepEqual(h.names(), ['home', 'group', 'expenseDetail', 'billChat']);
  assert.deepEqual(h.state().routes.slice(1).map((route: any) => route.params.groupId), ['other', 'other', 'other']);
  h.reset({ name: 'expenseVersions', params: { groupId: 'cold', expenseId: 'bill' } });
  h.navigation().back(true); assert.equal(h.navigation().route.name, 'expenseDetail');
  h.navigation().back(true); assert.equal(h.navigation().route.name, 'group');
  h.navigation().back(true); assert.equal(h.navigation().route.name, 'home');
});

function sceneHarness(name: routes.Screen = 'expense', accept: (action: any) => void = () => {}, key = 'exact-form-instance', current = () => true) {
  let cursor = 0, values: any[] = [], prevent = false, callback: any, focused = true, blocked = false;
  const dispatched: any[] = [], rendered: any[] = [], effects: (() => void)[] = [];
  const dispatch = (action: any) => { dispatched.push(action); accept(action); };
  const navigation = { dispatch, isFocused: () => focused && current() };
  const api = module({ useEffect: (fn: () => void) => effects.push(fn), useState: (initial: any) => { const id = cursor++; if (!(id in values)) values[id] = initial; return [values[id], (value: any) => values[id] = value]; },
    useRef: (initial: any) => values[cursor++] ??= { current: initial }, useContext: () => ({ render: (...args: any[]) => { rendered.push(args); return { type: 'Form', props: {}, children: [] }; }, blocked }),
    useIsFocused: () => focused, usePreventRemove: (enabled: boolean, fn: any) => { prevent = enabled; callback = fn; } });
  const route = { key, name, params: { groupId: 'g' } };
  return { render: () => { cursor = 0; return api.RouteScene({ route, navigation }); },
    remove: (action: any) => { if (prevent) callback({ data: { action } }); else dispatch(action); }, dispatched, rendered, flush: () => effects.splice(0).forEach(fn => fn()),
    blocked: (value: boolean) => { blocked = value; }, focus: (value: boolean) => { focused = value; }, prevented: () => prevent };
}

test('supported removal guard: Cancel retains exact route/form, Discard redispatches original action with red trash', async () => {
  const h = sceneHarness(), action = { type: 'POP', source: 'exact-form-instance', target: 'native-stack' };
  h.render(); h.remove(action); let tree = h.render();
  assert.equal(h.dispatched.length, 0); assert.equal(h.rendered[0][0], h.rendered.at(-1)[0]);
  assert.ok(JSON.stringify(tree).includes('Do you want to discard the draft?'));
  nodes(tree).find(node => node.type === 'CancelDialogActions').props.onCancel(); tree = h.render();
  assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog').props.visible, false); assert.equal(h.dispatched.length, 0);
  h.remove(action); tree = h.render(); const discard = nodes(tree).find(node => node.type === 'Button');
  assert.equal(discard.props.kind, 'danger'); assert.equal(discard.props.icon, 'remove'); discard.props.onPress(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.dispatched[0], action);
});

test('busy/local payment and attachment work block user removal; committed save can return without discard', () => {
  const h = sceneHarness(); h.blocked(true); h.render(); h.remove({ type: 'GO_BACK' }); assert.equal(h.dispatched.length, 0);
  let tree = h.render(); assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog').props.visible, false);
  h.blocked(false); tree = h.render(); nodes(tree).find(node => node.type === 'Lock').props.value(true); h.render(); h.remove({ type: 'GO_BACK' }); assert.equal(h.dispatched.length, 0);
  h.rendered.at(-1)[2](); h.render(); const saved = { ...StackActions.popTo('group'), appNavigation: true }; h.remove(saved); h.render(); h.flush(); assert.equal(h.dispatched.length, 0);
  nodes(h.render()).find(node => node.type === 'Lock').props.value(false); h.render(); h.flush(); assert.equal(h.dispatched[0], saved);
  const payment = sceneHarness('settle'); tree = payment.render(); nodes(tree).find(node => node.type === 'Lock').props.value(true); payment.render(); payment.remove({ type: 'GO_BACK' }); assert.equal(payment.dispatched.length, 0);
});

test('retained scenes preserve their route through focus changes; native gesture smoke remains separate', () => {
  const h = navigationHarness(); h.navigation().go('group', { groupId: 'g' }); h.navigation().go('expenseDetail', { expenseId: 'b' });
  const state = h.state(), scene = sceneHarness('expenseDetail'); scene.render(); scene.focus(false); scene.render(); scene.focus(true); scene.render();
  assert.equal(h.state(), state); assert.equal(scene.rendered.at(-1)[1], true); assert.equal(scene.prevented(), false);
  // Actual edge gesture/cancellation still requires the normal native package.
});

test('web canonical and alias links use navigator URL codec and retain cold parents', () => {
  const { webLinking } = module();
  for (const [path, name] of [['/app/groups/g', 'group'], ['/app/groups/g/bills/b', 'expenseDetail'], ['/app/groups/g/bills/b/versions', 'expenseVersions'], ['/app/chat/g/b', 'billChat'], ['/app/groups/g/bills/b/chat', 'billChat']]) {
    const state = webLinking.getStateFromPath(path, webLinking.config);
    assert.equal(state.routes.at(-1).name, name); assert.equal(state.routes[0].name, 'home');
    const roundTrip = webLinking.getStateFromPath(getPathFromState(state, webLinking.config), webLinking.config);
    assert.equal(roundTrip.routes.at(-1).name, name); assert.equal(roundTrip.routes.at(-1).params.groupId, 'g');
  }
});

test('App renders each retained route using its own group and record; account adoption clears the only stack', () => {
  const appText = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const app = ts.createSourceFile('App.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let render: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'renderScreen') render = node; ts.forEachChild(node, visit); } visit(app);
  const declarations = render!.body!.statements.slice(0, 10).map(node => node.getText(app)).join('\n');
  const compute = new Function('env', `with(env){${ts.transpile(declarations + ';return {screen,selected,expense,noticeVisibility};', { target: ts.ScriptTarget.ES2022 })}}`);
  const env = { route: { name: 'group', params: { groupId: 'behind' } }, focused: false, groups: [{ group: { id: 'behind', participants: [], expenses: [{ id: 'b' }], settlements: [] } }, { group: { id: 'front', participants: [], expenses: [], settlements: [] } }], commands: [], session: { userId: '1' },
    notices: { notices: [], acknowledgeVisible() {} }, authHeld: false, foreground: true, expired: false, alertOpen: false, viewport: null, scrollEpoch: 0, owner: 'account', online: true, groupVersions: { current: '' } };
  assert.equal(compute(env).selected.group.id, 'behind'); assert.equal(compute(env).noticeVisibility.enabled, false);
  assert.equal(compute({ ...env, route: { name: 'expenseDetail', params: { groupId: 'behind', expenseId: 'b' } } }).expense.id, 'b');
  assert.match(appText, /<AppStack scope=\{`\$\{owner\}\|\$\{navigationScope\}`\}/);
  assert.match(source.getText(), /<Stack.Group navigationKey=\{scope\}/);
  assert.match(appText, /setNavigationScope\(scope => scope \+ 1\)/);
  assert.doesNotMatch(appText, /setScreen|setGroupId|setExpenseId|MotionScreen|subscribeAppLinks|writeAppLink/);
  for (const file of ['ExpenseForm', 'SettleForm']) assert.match(readFileSync(new URL(`../src/${file}.tsx`, import.meta.url), 'utf8'), /useScreenRemovalLock\(/);
});


test('the actual form commit callback transfers both file ownership and navigation ownership', () => {
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'ExpenseForm') {
      const attr = node.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'onSave') as ts.JsxAttribute;
      callback = (attr.initializer as ts.JsxExpression).expression;
    }
    ts.forEachChild(node, visit);
  } visit(source);
  const calls: string[] = [], expense = {}, attachment = {};
  const handler = new Function('env', `with(env){${ts.transpile('const handler = ' + callback!.getText(source), { target: ts.ScriptTarget.ES2022 })};return handler;}`)({
    saveExpense: (value: unknown, file: unknown, onQueued: () => void) => { assert.equal(value, expense); assert.equal(file, attachment); calls.push('commit'); onQueued(); },
    billQueued: () => calls.push('navigation-ownership'),
  });
  handler(expense, attachment, () => calls.push('file-ownership'));
  assert.deepEqual(calls, ['commit', 'file-ownership', 'navigation-ownership']);
});

test('an uncached browser route attempts resolution once and cannot auto-loop after a failed load', () => {
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Node | undefined;
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('resolvedRoute.current === scope')) callback = node.arguments[0]; ts.forEachChild(node, visit); } visit(source);
  let reads = 0;
  const env = { ready: true, session: { token: 'current' }, authHeld: false, expired: false, busy: false, appLink: null, groupId: 'g', expenseId: null, settlementId: null, selected: null, expense: null, settlement: null,
    screen: 'group', resolvedRoute: { current: '' }, navigation: { route: { key: 'entry-one' } }, setAppLink: () => reads++ };
  const run = new Function('env', `with(env){${ts.transpile('const handler = ' + callback!.getText(source), { target: ts.ScriptTarget.ES2022 })};return handler;}`)(env);
  run(); run(); assert.equal(reads, 1); env.navigation.route.key = 'entry-two'; run(); assert.equal(reads, 2);
});


test('account switch and logout remove all old route keys through the native router', () => {
  const router = StackRouter({});
  const h = navigationHarness(); h.navigation().go('expenseDetail', { groupId: 'old-private', expenseId: 'old-bill' });
  const old = h.state();
  for (const entry of ['home', 'login', 'signInMethods']) {
    const config = { routeNames: [entry, ...routes.screenNames.filter(name => name !== entry)], routeParamList: {}, routeGetIdList: {}, routeKeyChanges: routes.screenNames };
    const next = router.getStateForRouteNamesChange(old, config);
    assert.deepEqual(next.routes.map((route: any) => route.name), [entry]);
    assert.ok(next.routes.every((route: any) => !old.routes.some((previous: any) => previous.key === route.key)));
  }
});


for (const lock of ['global', 'local'] as const) for (const destination of ['group', 'cross-group'] as const) {
  test(`app ${destination} navigation respects ${lock} payment lock and returns only after release`, () => {
    const h = navigationHarness(); h.navigation().go('group', { groupId: 'g' }); h.navigation().go('settle');
    const key = h.navigation().route.key!, original = h.state();
    const scene = sceneHarness('settle', h.apply, key, () => h.navigation().route.key === key);
    let tree = scene.render();
    if (lock === 'global') scene.blocked(true); else nodes(tree).find(node => node.type === 'Lock').props.value(true);
    scene.render(); h.intercept(scene.remove);
    h.navigation().go('group', destination === 'cross-group' ? { groupId: 'other' } : undefined);
    scene.render(); scene.flush();
    assert.equal(h.state(), original, 'generic go/popTo/reset must not remove a locked payment scene');
    if (lock === 'global') scene.blocked(false); else nodes(scene.render()).find(node => node.type === 'Lock').props.value(false);
    scene.render(); scene.flush();
    assert.equal(h.navigation().route.name, 'group');
    assert.equal(h.navigation().route.params.groupId, destination === 'cross-group' ? 'other' : 'g');
  });
}

test('a deferred save completion cannot remove another screen after focus or account changes', () => {
  const h = navigationHarness(); h.navigation().go('group', { groupId: 'g' }); h.navigation().go('settle');
  const key = h.navigation().route.key!;
  const scene = sceneHarness('settle', h.apply, key, () => h.navigation().route.key === key);
  scene.blocked(true); scene.render(); h.intercept(scene.remove); h.navigation().go('group'); scene.render(); scene.flush();
  h.apply(CommonActions.reset({ index: 0, routes: [{ name: 'home', params: { tab: 'Account' } }] }));
  const other = h.state(); scene.blocked(false); scene.focus(false); scene.render(); scene.flush();
  scene.focus(true); scene.render(); scene.flush();
  assert.equal(h.state(), other); assert.equal(scene.dispatched.length, 0, 'a stale completion has no current scene to remove');
});


test('committed bill completion waits for both locks and retains the real parent route', () => {
  const h = navigationHarness(); h.navigation().go('group', { groupId: 'g' }); const groupKey = h.navigation().route.key;
  h.navigation().go('expense', { expenseId: null }); const key = h.navigation().route.key!;
  const scene = sceneHarness('expense', h.apply, key, () => h.navigation().route.key === key);
  scene.blocked(true); nodes(scene.render()).find(node => node.type === 'Lock').props.value(true); scene.render();
  scene.rendered.at(-1)[2](); scene.render(); h.intercept(scene.remove); h.navigation().go('group'); scene.render(); scene.flush();
  assert.equal(h.navigation().route.name, 'expense');
  scene.blocked(false); scene.render(); scene.flush(); assert.equal(h.navigation().route.name, 'expense');
  nodes(scene.render()).find(node => node.type === 'Lock').props.value(false); scene.render(); scene.flush();
  assert.equal(h.navigation().route.key, groupKey); assert.equal(scene.dispatched.length, 1);
});

test('a deferred generic action still asks to discard an uncommitted bill after locks release', () => {
  const scene = sceneHarness(); scene.blocked(true); scene.render(); scene.remove({ ...StackActions.popTo('group'), appNavigation: true });
  scene.render(); scene.flush(); assert.equal(scene.dispatched.length, 0);
  scene.blocked(false); scene.render(); scene.flush(); const tree = scene.render();
  assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog').props.visible, true); assert.equal(scene.dispatched.length, 0);
});

test('actual payment Save commits before returning and waits for app and form locks', async () => {
  const h = navigationHarness(); h.navigation().go('group', { groupId: 'g' }); h.navigation().go('settle');
  const key = h.navigation().route.key!, scene = sceneHarness('settle', h.apply, key, () => h.navigation().route.key === key);
  nodes(scene.render()).find(node => node.type === 'Lock').props.value(true); scene.render(); h.intercept(scene.remove);
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'savePayment') declaration = node; ts.forEachChild(node, visit); } visit(source);
  let committed = false; const completion = h.navigation();
  const save = new Function('env', `with(env){${ts.transpile(declaration!.getText(source), { target: ts.ScriptTarget.ES2022 })};return savePayment;}`)({
    selected: { group: { archived: false } }, selfId: 'self', pending: [], session: null, uuid: () => 'payment-id', groupId: 'g',
    command: (_method: string, path: string, body: any) => ({ path, body }),
    queue: async (command: any) => { assert.equal(command.path, '/groups/g/settlements'); assert.equal(command.body.id, 'payment-id'); committed = true; },
    navigation: { complete: (name: routes.Screen) => { assert.equal(committed, true); completion.complete(name); } },
    perform: async (work: () => Promise<void>) => { scene.blocked(true); scene.render(); try { await work(); } finally { scene.blocked(false); scene.render(); scene.flush(); } },
  });
  await save({ sender: 'self', recipient: 'other', amount: '100' });
  assert.equal(h.navigation().route.key, key, 'form saving remains a removal boundary after App.perform finishes');
  nodes(scene.render()).find(node => node.type === 'Lock').props.value(false); scene.render(); scene.flush();
  assert.deepEqual(h.names(), ['home', 'group']);
});


test('an old completion cannot navigate a different current route or a later account', () => {
  const h = navigationHarness(); h.navigation().go('group', { groupId: 'g' }); h.navigation().go('settle');
  const old = h.navigation();
  h.navigation().go('group', { groupId: 'other' }); const other = h.state();
  old.complete('group'); assert.equal(h.state(), other);
  h.reset({ name: 'home', params: { tab: 'Account' } }); const account = h.state();
  old.complete('group', { groupId: 'g' }); assert.equal(h.state(), account);
});


test('pending draft discard accepts one action and never redispatches after losing focus', async () => {
  for (const loseFocus of [false, true]) {
    const h = sceneHarness(); h.render(); h.remove({ type: 'GO_BACK' }); let tree = h.render();
    let clears = 0, finish!: (value: boolean) => void;
    nodes(tree).find(node => node.type === 'DraftDiscard').props.value.current = () => { clears++; return new Promise(resolve => { finish = resolve; }); };
    const button = nodes(tree).find(node => node.type === 'Button'); button.props.onPress(); button.props.onPress();
    assert.equal(clears, 1, 'only one persistence operation may own a removal');
    const busy = h.render(); assert.equal(nodes(busy).find(node => node.type === 'KeyboardDialog').props.dismissable,false);
    nodes(busy).find(node => node.type === 'CancelDialogActions').props.onCancel(); assert.equal(nodes(h.render()).find(node => node.type === 'KeyboardDialog').props.visible,true);
    if (loseFocus) { h.focus(false); h.render(); }
    finish(true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.dispatched.length, loseFocus ? 0 : 1);
    assert.equal(nodes(h.render()).find(node => node.type === 'KeyboardDialog').props.visible,false);
  }
});


test('one completed discard cannot navigate a scene that lost focus while storage was pending', async () => {
  const h = sceneHarness(); h.render(); h.remove({ type:'GO_BACK' }); const tree = h.render();
  let finish!: (value:boolean)=>void;
  nodes(tree).find(node => node.type === 'DraftDiscard').props.value.current = () => new Promise(resolve => { finish = resolve; });
  nodes(tree).find(node => node.type === 'Button').props.onPress(); h.focus(false); h.render(); finish(true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.dispatched.length,0);
});
