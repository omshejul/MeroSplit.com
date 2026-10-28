import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(name: string, mocks: Record<string, unknown>) {
  const source = readFileSync(new URL('../' + name, import.meta.url), 'utf8');
  const code = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true });
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((name: string) => { assert.ok(name in mocks, 'unexpected dependency ' + name); return mocks[name]; }, module, module.exports);
  return module.exports;
}
const a = { baseUrl: 'https://example.invalid', userId: '1', token: 'session-a', email: 'a@example.invalid' };
const b = { ...a, userId: '2', token: 'session-b', email: 'b@example.invalid' };
const response = (providers: string[], auto_link = true) => ({ auto_link, accounts: providers.map((provider, index) => ({ id: String(index + 1), provider, uid: provider + '-identity', email: provider + '@example.invalid', can_disconnect: true })) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let cursor = 0;
  const values: any[] = [], deps: any[] = [], cleanups: any[] = [], effects: any[] = [], calls: any[] = [];
  const react = {
    useState(initial: any) { const slot = cursor++; if (!(slot in values)) values[slot] = initial; return [values[slot], (next: any) => { values[slot] = typeof next === 'function' ? next(values[slot]) : next; }]; },
    useRef(initial: any) { const slot = cursor++; return values[slot] ??= { current: initial }; },
    useCallback(callback: any, next: any[]) { const slot = cursor++; if (!deps[slot] || next.some((value, i) => value !== deps[slot][i])) { deps[slot] = next; values[slot] = callback; } return values[slot]; },
    useEffect(effect: any, next: any[]) { const slot = cursor++; if (!deps[slot] || next.some((value, i) => value !== deps[slot][i])) { deps[slot] = next; effects.push(() => { cleanups[slot]?.(); cleanups[slot] = effect(); }); } },
  };
  const reader = load('src/linkedProviders.ts', { './api': { cachedRead: () => undefined, invalidateRead() {}, rememberRead() {}, request: (session: unknown, path: string, method = 'GET', body?: unknown) => new Promise((resolve, reject) => calls.push({ session, path, method, body, resolve, reject })) } });
  const hook = load('src/useLinkedProviders.ts', { react, 'react-native': { Platform: { OS: 'web' } }, './linkedProviders': reader }).useLinkedProviders;
  return { calls, render(session: any, enabled = true) { cursor = 0; const value = hook(session, enabled); for (const effect of effects.splice(0)) effect(); return value; }, close() { for (const cleanup of cleanups) cleanup?.(); } };
}
function appConnect(scope: Record<string, unknown>, name = 'finishGoogleSignIn') {
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let node: ts.FunctionDeclaration | undefined;
  function walk(value: ts.Node) { if (ts.isFunctionDeclaration(value) && value.name?.text === name) node = value; ts.forEachChild(value, walk); }
  walk(source);assert.ok(node, 'actual App auth completion owner');
  const code = ts.transpile(node.getText(source), { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(scope), code + ';return ' + name + ';')(...Object.values(scope));
}

test('real linked-provider reader/hook distinguishes loading, own memberships, errors and offline', async () => {
  const h = harness();try {
    assert.equal(h.render(a).status, 'loading');assert.equal(h.calls[0].path, '/me/sign-in-methods');
    h.calls[0].resolve(response(['google']));await tick();assert.equal(h.render(a).connected.google, true);assert.equal(h.render(a).connected.autoLink, true);
    h.render(a).refresh();assert.equal(h.render(a).status, 'loading');h.calls[1].reject(Error('offline'));await tick();
    assert.equal(h.render(a).status, 'error');assert.equal(h.render(a).connected.google, true);
    assert.equal(h.render(a, false).status, 'unknown');assert.equal(h.render(a, false).connected.google, true);
  } finally { h.close(); }
});
test('account switch suppresses pending old-account response before and after effect completion', async () => {
  const h = harness();try {
    h.render(a);assert.equal(h.render(b).connected, null);
    h.calls[0].resolve(response(['google']));await tick();assert.equal(h.render(b).status, 'loading');
    h.calls[1].resolve(response(['apple']));await tick();assert.equal(h.render(b).connected.apple, true);assert.equal(h.render(b).connected.google, false);
  } finally { h.close(); }
});
test('actual App connect completion refreshes actual hook; cancel/error/stale account never claim connection', async () => {
  const h = harness();try {
    h.render(a);h.calls[0].resolve(response([]));await tick();
    const notices: string[] = [], activeSessionRef = { current: a }, authEpoch = { current: 1 };
    const scope = { activeSessionRef, authEpoch, Platform: { OS: 'web' }, draftWrites: { current: Promise.resolve() }, providerConnections: h.render(a), setNotice: (value: string) => notices.push(value) };
    const complete = appConnect(scope);
    await complete('connect', async () => a);
    assert.equal(h.render(a).status, 'loading');assert.equal(h.calls.length, 2);
    h.calls[1].resolve(response(['google']));await tick();assert.equal(h.render(a).connected.google, true);
    const count = notices.length;await complete('connect', async () => null);assert.equal(notices.length, count);
    await assert.rejects(complete('connect', async () => { throw Error('cancelled by provider'); }));assert.equal(notices.length, count);
    let done: (value: unknown) => void = () => {};
    const pending = complete('connect', () => new Promise(resolve => { done = resolve; }));await tick();
    activeSessionRef.current = b;authEpoch.current++;done(a);await pending;
    assert.equal(notices.length, count);assert.equal(h.render(b).connected, null);
  } finally { h.close(); }
});

test('actual browser Google control submits a same-origin CSRF form on its first click', async () => {
  const globals = globalThis as any, oldWindow = globals.window, oldDocument = globals.document;
  const submitted: any[] = [];
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
  globals.window = { location: { origin: 'https://merosplit.com' } };
  globals.document = { cookie: 'csrftoken=synthetic-csrf', body: { appendChild() {} }, createElement(type: string) {
    return type === 'input' ? {} : { fields: [] as any[], appendChild(input: unknown) { this.fields.push(input); }, submit() { submitted.push({ method: this.method, action: this.action, fields: this.fields }); }, remove() {}, method: '', action: '' };
  } };
  try {
    const component = load('src/GoogleSignInButton.web.tsx', { react: React, 'react-native': { View: 'View' }, 'react-native-paper': { Text: 'Text' }, './ui': { useUI: () => ({ ui: {} }) }, './GoogleBrandButton': { default: 'Google', __esModule: true } }).default;
    let pending = Promise.resolve();
    const tree = component({ baseUrl: 'https://merosplit.com', process: 'login', busy: false, onAuthenticate: (action: any) => { pending = action(() => true); } });
    const button = tree.props.children.flat().find((node: any) => node?.type === 'Google');
    button.props.onPress();await pending;
    assert.equal(submitted.length, 1);assert.equal(submitted[0].method, 'POST');assert.equal(submitted[0].action, '/auth/google');
    assert.deepEqual(Object.fromEntries(submitted[0].fields.map((field: any) => [field.name, field.value])), { process: 'login', csrfmiddlewaretoken: 'synthetic-csrf' });
    const stale = component({ baseUrl: 'https://merosplit.com', process: 'connect', current: a, onAuthenticate: (action: any) => { pending = action(() => false); } });
    stale.props.children.flat().find((node: any) => node?.type === 'Google').props.onPress();await pending;assert.equal(submitted.length, 1);
  } finally { globals.window = oldWindow;globals.document = oldDocument; }
});

test('actual App callback adoption opens methods but only the authenticated hook can declare connected', async () => {
  const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const values: Record<string, unknown> = {}, googleReturn = { current: 'connect' };
  const scope: Record<string, unknown> = { scopeGeneration: { current: 0 }, session: null, googleReturn, initialScreen: { current: 'login' }, ownerRef: {}, activeSessionRef: {},
    publishedStorage: {current: {scope:'1',view:'old',changes:'old'}}, loadGeneration:{current:0},
    accountOwner: (session: any) => session.userId, activityOwner: {}, groupVersions: {}, load: async () => {},
    setNotice() {} };
  for (const name of new Set(source.match(/\bset[A-Z]\w+/g))) scope[name] = (value: unknown) => { values[name] = value; };
  appConnect(scope, 'changeScope')(a);
  assert.deepEqual((scope.publishedStorage as any).current,{scope:'',view:'',changes:''});assert.equal((scope.loadGeneration as any).current,1);assert.equal((scope.scopeGeneration as any).current,1);
  assert.equal((scope.initialScreen as any).current, 'signInMethods'); assert.equal(typeof values.setNavigationScope, 'function');
  assert.equal(googleReturn.current, null);assert.equal('setConnected' in values, false);
  const h = harness();try {
    assert.equal(h.render(a).connected, null);h.calls[0].resolve(response([]));await tick();
    assert.equal(h.render(a).connected.google, false);assert.equal(h.render(a).connected.apple, false);
  } finally { h.close(); }
});

test('actual App methods Back returns to Account and restores its settings-row focus', () => {
  let home = false, focus = 0;
  const back = appConnect({ screen: 'signInMethods', session: a, navigation: { back() { home = true; } }, methodsRow: { current: { focus() { focus++; } } }, requestAnimationFrame: (action: () => void) => action() }, 'back');
  back();assert.equal(home, true);assert.equal(focus, 1);
});

test('auto-link updates optimistically, rolls back failures and blocks duplicate writes', async () => {
  const h = harness(); try {
    h.render(a); h.calls[0].resolve(response(['google'])); await tick();
    const saving = h.render(a).setAutoLink(false);
    await h.render(a).setAutoLink(true);
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].path, '/me/sign-in-methods/preferences');
    assert.deepEqual(h.calls[1].body, { auto_link: false });
    assert.equal(h.render(a).working, true); assert.equal(h.render(a).connected.autoLink, false);
    h.calls[1].reject(Error('Could not save')); await saving;
    assert.equal(h.render(a).connected.autoLink, true); assert.equal(h.render(a).error, 'Could not save');
    const retry = h.render(a).setAutoLink(false); h.calls[2].resolve(response(['google'], false)); await retry;
    assert.equal(h.render(a).connected.autoLink, false); assert.equal(h.render(a).working, false);
  } finally { h.close(); }
});

test('disconnect removes only the selected identity and a late old-account write cannot replace the new account', async () => {
  const h = harness(); try {
    h.render(a); h.calls[0].resolve(response(['google', 'apple'])); await tick();
    const removing = h.render(a).disconnect('1');
    assert.equal(h.calls[1].method, 'DELETE'); assert.equal(h.calls[1].path, '/me/sign-in-methods/1');
    h.calls[1].resolve(response(['apple'])); await removing;
    assert.equal(h.render(a).connected.google, false); assert.equal(h.render(a).connected.apple, true);
    const late = h.render(a).setAutoLink(false);
    h.render(b); h.calls[2].resolve(response(['google'], false)); await late;
    assert.equal(h.render(b).connected, null);
    h.calls[3].resolve(response(['google'])); await tick();
    assert.equal(h.render(b).connected.autoLink, true);
  } finally { h.close(); }
});

test('methods screen identifies accounts, confirms exact disconnect and disables stale controls', () => {
  const alerts: any[] = [], changes: any[] = [];
  const React = { createElement: (type: any, props: any, ...children: any[]): any => typeof type === 'function' ? type({ ...props, children }) : ({ type, props: { ...props, children } }), Fragment: 'Fragment' };
  const screen = load('src/SignInMethods.tsx', { react: React,
    'react-native': { View: 'View', Image: 'Image', Platform: { OS: 'ios' } }, 'react-native-paper': { Text: 'Text' },
    './ui': { Button: 'Button', Icon: 'Icon', useUI: () => ({ ui: {}, dark: false }) },
    './alerts': { Alert: { alert: (...args: any[]) => alerts.push(args) } },
    './ListRow': { __esModule: true, default: (props: any) => React.createElement('Row', props, props.children, props.trailing) },
    './RowGroup': { __esModule: true, default: 'RowGroup' }, './NotificationSwitch': { __esModule: true, default: 'Switch' },
    './UIStates': { ErrorState: 'ErrorState' }, './AppleSignInButton': { __esModule: true, default: 'Apple' },
    './GoogleSignInButton': { __esModule: true, default: 'Google' }, '../assets/oauth/google-g-light.png': 'official-g' }).default;
  const all = (node: any): any[] => Array.isArray(node) ? node.flatMap(all) : !node || typeof node !== 'object' ? [] : [node, ...all(node.props.children)];
  const connections = { status: 'ready', connected: { ...response(['google', 'apple']), autoLink: true, google: true, apple: true }, working: false, error: '',
    refresh() {}, disconnect: (id: string) => changes.push(id), setAutoLink: (value: boolean) => changes.push(value) };
  const render = () => all(screen({ session: a, busy: false, connections, onGoogle() {}, onApple() {} }));
  const rows = render();
  assert.ok(rows.findIndex(node => node.type === 'Switch') < rows.findIndex(node => node.type === 'RowGroup'), 'Auto-link is above the connected accounts');
  assert.ok(rows.some(node => node.type === 'Text' && node.props.children.includes('google@example.invalid')));
  rows.find(node => node.props.accessibilityLabel === 'Disconnect Google: google@example.invalid').props.onPress();
  assert.equal(changes.length, 0); assert.equal(alerts[0][0], 'Disconnect Google?');
  alerts[0][2].find((action: any) => action.text === 'Disconnect').onPress(); assert.deepEqual(changes, ['1']);
  rows.find(node => node.type === 'Switch').props.onChange(false); assert.deepEqual(changes, ['1', false]);
  connections.status = 'loading';
  const refreshing = render(); assert.ok(refreshing.some(node => node.type === 'Text' && node.props.children.includes('google@example.invalid')));
  assert.equal(refreshing.find(node => node.props.title === 'Disconnect').props.disabled, true);
});
