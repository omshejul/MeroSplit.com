import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { pushOpportunityReady } from '../src/pushInvitationRules.ts';
const opportunity = { owner: 'server|one', token: 'session', groupId: 'g', expenseId: 'bill' };
const value: any = { kind: 'shared', group: { id: 'g', version: 1, expenses: [{ id: 'bill', deleted: false }], transactions: [] } };
test('only a confirmed shared bill or joined group with bills on the current account is eligible', () => {
  const ready = (event: any = opportunity, row: any = value, commands: any[] = []) => pushOpportunityReady(event, 'server|one', 'session', row, commands);
  assert.equal(ready(), true); assert.equal(ready({ ...opportunity, expenseId: undefined }), true);
  assert.equal(ready(opportunity, { ...value, group: { ...value.group, expenses: [], transactions: [{ kind: 'bill', bill: { id: 'bill', deleted: false } }] } }), true);
  for (const event of [null, { ...opportunity, owner: 'other' }, { ...opportunity, token: 'old' }, { ...opportunity, groupId: 'other' }, { ...opportunity, expenseId: 'missing' }]) assert.equal(ready(event), false);
  for (const row of [null, { ...value, kind: 'private' }, { ...value, group: { ...value.group, archived: true } }, { ...value, group: { ...value.group, version: 0 } }, { ...value, group: { ...value.group, expenses: [] } }, { ...value, group: { ...value.group, expenses: [{ id: 'bill', deleted: true }] } }]) assert.equal(ready(opportunity, row), false);
  for (const state of ['pending', 'conflict']) assert.equal(ready(opportunity, value, [{ group_id: 'g', state }]), false);
  assert.equal(ready(opportunity, value, [{ group_id: 'unrelated' }]), true);
});
function harness(options: { os?: string; first?: boolean; failure?: boolean; keyboard?: boolean; deferred?: Promise<boolean>; updates?: boolean; readFailure?: boolean } = {}) {
  let cursor = 0, dirty = false, keyboard = options.keyboard ?? false, focused = false, timerId = 0, claims = 0, enables = 0;
  const slots: any[] = [], effects: any[] = [], timers = new Map<number, () => void>(), listeners: Record<string, () => void> = {}, notices: string[] = [];
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) };
  const source = readFileSync(new URL('../src/PushInvitation.tsx', import.meta.url), 'utf8');
  const code = ts.transpile(source.replace(/^import .*;\n/gm, ''), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS });
  const exports: any = {}, env = { React,
    useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v: any) => { const next = typeof v === 'function' ? v(slots[i]) : v; if (next !== slots[i]) { slots[i] = next; dirty = true; } }]; },
    useRef: (initial: any) => slots[cursor++] ??= { current: initial },
    useEffect: (effect: any, deps: any[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((x, n) => x !== old.deps[n])) { slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect(); }); } },
    Platform: { OS: options.os ?? 'ios' }, Keyboard: { isVisible: () => keyboard, addListener: (key: string, fn: () => void) => { listeners[key] = fn; return { remove() { delete listeners[key]; } }; } }, TextInput: { State: { currentlyFocusedInput: () => focused ? {} : null } },
    request: async (_session: any, path: string) => { assert.equal(path, '/me/notifications/preferences'); if (options.readFailure) throw Error('Offline'); return { expense_updates: options.updates !== false }; },
    claimPushInvitation: async () => { claims++; return options.deferred ?? options.first !== false; },
    setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 400); timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
    useUI: () => ({ ui: { body: {} } }), useToast: () => (message: string) => notices.push(message),
    KeyboardDialog: 'KeyboardDialog', Dialog: { Title: 'Title', Content: 'Content', Actions: 'Actions' }, Text: 'Text', Button: 'Button',
  };
  new Function('env', 'exports', `with(env){ const useLoading = env.useLoading ?? (() => {}), LoadingOverlay = env.LoadingOverlay ?? 'LoadingOverlay';${code}}`)(env, exports);
  const props: any = { owner: 'server|one', session: { token: 'session', baseUrl: 'https://server.invalid' }, eligible: true, onVisibility() {}, push: { state: { ready: true, enabled: false, optedIn: false, pendingOff: false, working: false, permission: 'ask' }, enable: async () => { enables++; if (options.failure) throw Error('Offline'); return true; } } };
  let tree: any;
  function render() { do { dirty = false; cursor = 0; tree = exports.default(props); effects.splice(0).forEach(fn => fn()); } while (dirty); return tree; }
  render();
  return { props, render, get claims() { return claims; }, get enables() { return enables; }, notices,
    async advance() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); return render(); },
    keyboard(value: boolean) { keyboard = value; listeners[value ? 'keyboardDidShow' : 'keyboardDidHide']?.(); render(); }, focus(value: boolean) { focused = value; },
    buttons() { return tree.children.flatMap((n: any) => n?.type === 'Actions' ? n.children : []); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('education waits for context and only an explicit Turn on tap requests system permission', async () => {
  const h = harness(); assert.equal(h.render().props.visible, false); assert.equal(h.enables, 0);
  await h.advance(); assert.equal(h.render().props.visible, true); assert.equal(h.claims, 1); assert.equal(h.enables, 0);
  h.buttons().find((b: any) => b.props.title === 'Turn on notifications').props.onPress(); await tick();
  assert.equal(h.enables, 1); assert.equal(h.render().props.visible, false); h.unmount();
});
test('Not now, dismissal and remembered choices never request permission', async () => {
  const h = harness(); await h.advance(); h.buttons().find((b: any) => b.props.title === 'Not now').props.onPress(); assert.equal(h.render().props.visible, false); assert.equal(h.enables, 0); h.unmount();
  const remount = harness({ first: false }); await remount.advance(); assert.equal(remount.render().props.visible, false); assert.equal(remount.enables, 0); remount.unmount();
  const dismiss = harness(); await dismiss.advance(); dismiss.render().props.onDismiss(); assert.equal(dismiss.render().props.visible, false); assert.equal(dismiss.enables, 0); dismiss.unmount();
});
test('web, OS denial, prior opt-in and push loading state cannot show an invitation', async () => {
  for (const state of [{ ready: false }, { enabled: true }, { optedIn: true }, { pendingOff: true }, { working: true }, { permission: 'denied' }]) { const h = harness(); Object.assign(h.props.push.state, state); h.render(); await h.advance(); assert.equal(h.claims, 0); assert.equal(h.enables, 0); assert.equal(h.render().props.visible, false); h.unmount(); }
  const web = harness({ os: 'web' }); await web.advance(); assert.equal(web.claims, 0); web.unmount();
});
test('keyboard and focused fields prevent interruption; leaving a route dismisses the prompt', async () => {
  const h = harness({ keyboard: true }); await h.advance(); assert.equal(h.claims, 0); h.keyboard(false); await h.advance(); assert.equal(h.render().props.visible, true);
  h.props.eligible = false; assert.equal(h.render().props.visible, false); h.props.eligible = true; assert.equal(h.render().props.visible, false); h.unmount();
  const focused = harness(); focused.focus(true); await focused.advance(); assert.equal(focused.claims, 0); focused.unmount();
});
test('late storage results and queued Yes after account unmount cannot present or request permission', async () => {
  let finish!: (result: boolean) => void;
  const h = harness({ deferred: new Promise(resolve => { finish = resolve; }) }); const pending = h.advance(); h.unmount(); finish(true); await pending; assert.equal(h.render().props.visible, false); assert.equal(h.enables, 0);
  const shown = harness(); await shown.advance(); const yes = shown.buttons().find((b: any) => b.props.title === 'Turn on notifications').props.onPress; shown.unmount(); yes(); await tick(); assert.equal(shown.enables, 0);
});
test('registration failures close the invitation and explain retry from Settings', async () => {
  const h = harness({ failure: true }); await h.advance(); h.buttons().find((b: any) => b.props.title === 'Turn on notifications').props.onPress(); await tick(); assert.equal(h.render().props.visible, false); assert.match(h.notices[0], /Me → Notifications/); h.unmount();
});
test('native invitation choice is durable and isolated per account and backend', async () => {
  const source = ts.createSourceFile('native.ts', readFileSync(new URL('../src/native.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'claimPushInvitation')!;
  const store = new Map<string, string>();
  const run = new Function('env', `with(env){ const useLoading = env.useLoading ?? (() => {}), LoadingOverlay = env.LoadingOverlay ?? 'LoadingOverlay';${ts.transpile(fn.getText(source).replace(/^export /, ''), { target: ts.ScriptTarget.ES2022 })};return claimPushInvitation;}`)({ SecureStore: { getItemAsync: async (key: string) => store.get(key), setItemAsync: async (key: string, value: string) => store.set(key, value) }, digestStringAsync: async (_: any, owner: string) => createHash('sha256').update(owner).digest('hex'), CryptoDigestAlgorithm: { SHA256: 'sha256' } });
  for (const owner of ['server|1', 'server|2', 'other-server|1']) { assert.equal(await run(owner), true); assert.equal(await run(owner), false); }
  assert.equal(store.size, 3);
});

test('the production save handler offers push only after a new shared bill and after existing UPI setup', async () => {
  const file = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration!: ts.FunctionDeclaration;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'saveExpense') declaration = node; ts.forEachChild(node, visit); } visit(file); assert.ok(declaration);
  function setup(overrides: Record<string, any> = {}) {
    const events: string[] = [], active = { token: 'current' };
    const env: any = { session: active, expenseId: null, selected: value, vpa: '', selfId: 'me', owner: 'server|one', groupId: 'g', draftWrites: { current: Promise.resolve() },
      perform: async (work: any) => work(), queue: async () => { events.push('saved'); }, command() {}, expensePayload() {}, reviewCommand: null, setReviewCommand() {}, setReviewInput() {}, navigation: { complete: () => events.push('group') }, isOnline: () => false,
      upiPrompts: { current: new Set() }, claimFirstSplitUPIPrompt: async () => true, ownerRef: { current: 'server|one' }, activeSessionRef: { current: active }, setUpiAfterSplit() {}, setUpiSetup: () => events.push('upi'),
      setPushOpportunity: (candidate: any) => { assert.equal(candidate.expenseId, 'new'); assert.equal(candidate.owner, 'server|one'); events.push('push'); }, ...overrides };
    return { env, events, save: new Function('env', `with(env){ const useLoading = env.useLoading ?? (() => {}), LoadingOverlay = env.LoadingOverlay ?? 'LoadingOverlay';${ts.transpile(declaration.getText(file), { target: ts.ScriptTarget.ES2022 })};return saveExpense;}`)(env) };
  }
  const bill = { id: 'new', deleted: false, paid: { me: '200' }, shares: { me: '100' } };
  const good = setup(); await good.save(bill); assert.deepEqual(good.events, ['saved', 'group', 'upi', 'push']);
  for (const changes of [{ selected: { ...value, kind: 'private' } }, { expenseId: 'existing' }, { session: null }, { activeSessionRef: { current: { token: 'other' } } }]) { const h = setup(changes); await h.save(bill); assert.ok(!h.events.includes('push')); }
  const removed = setup(); await removed.save({ ...bill, deleted: true }); assert.ok(!removed.events.includes('push'));
  const failed = setup({ queue: async () => { throw Error('Not saved'); } }); await assert.rejects(failed.save(bill)); assert.ok(!failed.events.includes('push'));
});
test('the production invitation stays out of forms, loading, auth and other dialogs', () => {
  const file = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression!: ts.Expression;
  function visit(node: ts.Node) { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'PushInvitation') { const attr = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(file) === 'eligible') as ts.JsxAttribute; expression = (attr.initializer as ts.JsxExpression).expression!; } ts.forEachChild(node, visit); } visit(file); assert.ok(expression);
  const check = new Function('env', `with(env){ const useLoading = env.useLoading ?? (() => {}), LoadingOverlay = env.LoadingOverlay ?? 'LoadingOverlay';return ${expression.getText(file)};}`);
  const env = { ready: true, foreground: true, online: true, expired: false, authHeld: false, busy: false, reading: 0, syncing: false, storageError: '', appLink: null, emailEntry: null, feedbackOpen: false, alertOpen: false, upiSetup: false, newPersonInvite: null, reviewCommand: null, returnAttemptId: null, screen: 'group', pushOpportunityReady, pushOpportunity: opportunity, owner: 'server|one', session: { token: 'session' }, selected: value, commands: [] };
  assert.equal(check(env), true);
  for (const changes of [{ ready: false }, { foreground: false }, { online: false }, { expired: true }, { authHeld: true }, { busy: true }, { reading: 1 }, { syncing: true }, { storageError: 'broken' }, { appLink: {} }, { emailEntry: {} }, { feedbackOpen: true }, { alertOpen: true }, { upiSetup: true }, { newPersonInvite: {} }, { reviewCommand: {} }, { returnAttemptId: 'pending' }, { screen: 'expense' }, { screen: 'login' }]) assert.equal(check({ ...env, ...changes }), false, JSON.stringify(changes));
});

test('account-level notification opt-out and unavailable preferences prevent education without changing consent', async () => {
  for (const options of [{ updates: false }, { readFailure: true }]) { const h = harness(options); await h.advance(); assert.equal(h.render().props.visible, false); assert.equal(h.claims, 0); assert.equal(h.enables, 0); h.unmount(); }
});
