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
const response = (providers: string[]) => new Response(JSON.stringify({ data: providers.map(id => ({ provider: { id } })) }), { headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let cursor = 0;
  const values: any[] = [], deps: any[] = [], cleanups: any[] = [], effects: any[] = [], calls: any[] = [];
  const react = {
    useState(initial: any) { const slot = cursor++; if (!(slot in values)) values[slot] = initial; return [values[slot], (next: any) => { values[slot] = typeof next === 'function' ? next(values[slot]) : next; }]; },
    useCallback(callback: any) { const slot = cursor++; return values[slot] ??= callback; },
    useEffect(effect: any, next: any[]) { const slot = cursor++; if (!deps[slot] || next.some((value, i) => value !== deps[slot][i])) { deps[slot] = next; effects.push(() => { cleanups[slot]?.(); cleanups[slot] = effect(); }); } },
  };
  const reader = load('src/linkedProviders.ts', { './transport.ts': { sessionRequest: (session: unknown, path: string) => new Promise((resolve, reject) => calls.push({ session, path, resolve, reject })) } });
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
    assert.equal(h.render(a).status, 'loading');assert.equal(h.calls[0].path, '/_allauth/browser/v1/account/providers');
    h.calls[0].resolve(response(['google']));await tick();assert.deepEqual(h.render(a).connected, { google: true, apple: false });
    h.render(a).refresh();assert.equal(h.render(a).status, 'loading');h.calls[1].reject(Error('offline'));await tick();
    assert.equal(h.render(a).status, 'error');assert.equal(h.render(a).connected, null);
    assert.equal(h.render(a, false).status, 'unknown');assert.equal(h.render(a, false).connected, null);
  } finally { h.close(); }
});
test('account switch suppresses pending old-account response before and after effect completion', async () => {
  const h = harness();try {
    h.render(a);assert.equal(h.render(b).connected, null);
    h.calls[0].resolve(response(['google']));await tick();assert.equal(h.render(b).status, 'loading');
    h.calls[1].resolve(response(['apple']));await tick();assert.deepEqual(h.render(b).connected, { google: false, apple: true });
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
  const scope: Record<string, unknown> = { session: null, googleReturn, ownerRef: {}, activeSessionRef: {},
    accountOwner: (session: any) => session.userId, activityOwner: {}, groupVersions: {}, load: async () => {},
    setNotice() {} };
  for (const name of new Set(source.match(/\bset[A-Z]\w+/g))) scope[name] = (value: unknown) => { values[name] = value; };
  appConnect(scope, 'changeScope')(a);
  assert.equal(values.setScreen, 'signInMethods');assert.equal(values.setTab, 'Account');
  assert.equal(googleReturn.current, null);assert.equal('setConnected' in values, false);
  const h = harness();try {
    assert.equal(h.render(a).connected, null);h.calls[0].resolve(response([]));await tick();
    assert.deepEqual(h.render(a).connected, { google: false, apple: false });
  } finally { h.close(); }
});

test('actual methods screen hides actions for linked/unknown accounts and keeps supported actions disabled when busy', () => {
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }), Fragment: 'Fragment' };
  const screen = load('src/SignInMethods.tsx', { react: React, 'react-native': { View: 'View', Image: 'Image', Platform: { OS: 'web' }, StyleSheet: { hairlineWidth: 1 } },
    'react-native-paper': { Text: 'Text' }, './ui': { Button: 'Button', Icon: 'Icon', useUI: () => ({ palette: {}, ui: {}, dark: false }) },
    './AppleSignInButton': { __esModule: true, default: 'Apple' }, './GoogleSignInButton': { __esModule: true, default: 'Google' },
    '../assets/oauth/google-g-light.png': 'official-g' }).default;
  const all = (node: any): any[] => !node || typeof node !== 'object' ? [] : [node, ...node.props.children.flat(Infinity).flatMap(all)];
  const render = (status: string, connected: any, busy = false) => all(screen({ session: a, busy, connections: { status, connected, refresh() {} }, onGoogle() {}, onApple() {} }));
  for (const status of ['loading', 'unknown', 'error']) assert.equal(render(status, { google: true }).some(node => ['Google', 'Apple'].includes(node.type)), false);
  const linked = render('ready', { google: true, apple: true });
  assert.equal(linked.some(node => ['Google', 'Apple', 'Button'].includes(node.type)), false);
  assert.equal(linked.filter(node => node.type === 'Text' && node.props.children[0] === 'Connected').length, 2);
  const unlinked = render('ready', { google: false, apple: false }, true);
  assert.equal(unlinked.find(node => node.type === 'Google').props.busy, true);
  assert.equal(unlinked.some(node => node.type === 'Apple'), false);
});

test('actual App methods Back returns to Account and restores its settings-row focus', () => {
  let home = false, focus = 0;
  const back = appConnect({ screen: 'signInMethods', openMe() { home = true; }, methodsRow: { current: { focus() { focus++; } } }, requestAnimationFrame: (action: () => void) => action() }, 'back');
  back();assert.equal(home, true);assert.equal(focus, 1);
});
