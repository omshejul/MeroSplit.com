import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { Fragment: 'Fragment', createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }) };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('children' in value)) return [];
  const node = value as Element;
  return [node, ...node.children.flatMap(elements)];
}

// Execute the production Me expression from AppContent's rendered ScrollView.
// Importing or testing MCPSettings alone cannot satisfy this host-level check.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'AppContent')!;
function appFrame(node: ts.Node): ts.JsxElement | undefined {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'AppFrame') return node;
  return ts.forEachChild(node, appFrame);
}
const main = appFrame(app)!;
function pageScroll(node: ts.Node): ts.JsxElement | undefined {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'ScrollView') return node;
  return ts.forEachChild(node, pageScroll);
}
const scroll = pageScroll(main)!;
const me = scroll.children.find((node): node is ts.JsxExpression => ts.isJsxExpression(node) && !!node.expression && node.expression.getText(source).startsWith("screen === 'home' && tab === 'Account' && session &&"))!;
assert.ok(me?.expression, 'exercise the actual Me host inside the rendered app');
const code = ts.transpile(`return (${me.expression.getText(source)});`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
const render = new Function('env', `with(env) { ${code} }`);

test('Me mounts Connect MCP on native and web, with current account key, session and shared busy lock', () => {
  const MCPSettings = Symbol('Connect MCP');
  const env: Record<string, any> = { React, MCPSettings, screen: 'home', tab: 'Account', owner: 'account-one',
    session: { email: 'one@example.invalid', token: 'synthetic-one' }, busy: false, lock: { current: false },
    myName: 'One', vpa: '', push: {}, unavailable: [], commands: [], groups: [], expired: false,
    legacy: [], legacySelf: {}, recoveries: [], ui: {}, saveName() {},
    AccountHeader: 'AccountHeader', View: 'View', ProfileSettings: 'ProfileSettings', AccountNotifications: 'AccountNotifications',
    DeleteAccount: 'DeleteAccount', ExportData: 'ExportData', SettingsRow: 'SettingsRow', Disclosure: 'Disclosure', Button: 'Button', Text: 'Text', SavedChanges: 'SavedChanges', LegacyRecords: 'LegacyRecords' };
  const busyChanges: boolean[] = [];
  env.setBusy = (value: boolean) => busyChanges.push(value);
  for (const os of ['ios', 'android', 'web']) {
    env.Platform = { OS: os };
    for (const busy of [false, true]) {
      env.busy = busy;
      const mounted = elements(render(env)).filter(node => node.type === MCPSettings);
      assert.equal(mounted.length, 1, `${os} Me must mount Connect MCP, not merely import it`);
      const exports = elements(render(env)).filter(node => node.type === 'ExportData');
      assert.equal(exports.length, 1); assert.equal(exports[0].props.key, env.owner); assert.equal(exports[0].props.busy, busy);
      const settings = mounted[0];
      assert.equal(settings.props.key, env.owner);
      assert.equal(settings.props.session, env.session);
      assert.equal(settings.props.busy, busy);
      for (const value of [true, false]) {
        settings.props.onBusyChange(value);
        assert.equal(env.lock.current, value);
        assert.equal(busyChanges.at(-1), value);
      }
    }
  }
  const next = { ...env, owner: 'account-two', session: { email: 'two@example.invalid', token: 'synthetic-two' } };
  const changed = elements(render(next)).find(node => node.type === MCPSettings)!;
  assert.equal(changed.props.key, next.owner);
  assert.equal(changed.props.session, next.session);
  for (const away of [{ screen: 'group' }, { tab: 'Groups' }, { session: null }]) {
    assert.equal(elements(render({ ...env, ...away })).some(node => node.type === MCPSettings || node.type === 'ExportData'), false);
  }
});

test('Activity discovers unread chats before a bill is opened and resolves the authorized exact conversation', async () => {
  const expression = scroll.children.find((node): node is ts.JsxExpression => ts.isJsxExpression(node) && !!node.expression && node.expression.getText(source).startsWith("screen === 'home' && tab === 'Activity' && session && <ChatInbox"));
  assert.ok(expression?.expression, 'Activity must mount the unread inbox');
  const evaluate = new Function('env', `with(env){${ts.transpile('return (' + expression.expression.getText(source) + ');', { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}}`);
  const selected: any[] = [];
  const tree = evaluate({ React, ChatInbox: 'ChatInbox', screen: 'home', tab: 'Activity', session: { token: 'current' }, owner: 'one', foreground: true, authHeld: false, expired: false, online: true, busy: false, openActivityTarget: async (...args: any[]) => { selected.push(args); } });
  const entry = elements(tree).find(node => node.type === 'ChatInbox')!;
  assert.equal(entry.props.key, 'one'); assert.equal(entry.props.active, true); assert.equal(selected.length, 0);
  entry.props.onOpen('g', 'b'); assert.deepEqual(selected, [[{ kind: 'bill', groupId: 'g', expenseId: 'b' }, true]]);
  const declaration = app.body!.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'openActivityTarget')!;
  const calls: string[] = [], active = { token: 'current' };
  const scope = { session: active, activeSessionRef: { current: active }, perform: async (fn: () => Promise<void>) => fn(), fetchGroup: async () => { calls.push('group-read'); return { id: 'g' }; }, withBill: async (_session: any, group: any, id: string) => { calls.push('bill-read-' + id); return group; }, getDatabase: async () => ({}), accountOwner: () => 'one', saveGroup: async () => {}, setGroupId() {}, setExpenseId() {}, setSettlementId() {}, setScreen: (screen: string) => calls.push(screen) };
  const open = new Function('env', `with(env){${ts.transpile(declaration.getText(source), { target: ts.ScriptTarget.ES2022 })};return openActivityTarget;}`)(scope);
  await open(selected[0][0], true); assert.deepEqual(calls, ['group-read', 'bill-read-b', 'billChat']);
});

test('Leaving chat keeps the existing account-wide temporary-tab guard honest about all saved work', async () => {
  let callback: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'BillChatScreen') {
      const attr = node.attributes.properties.find(row => ts.isJsxAttribute(row) && row.name.getText(source) === 'onUnsentChange') as ts.JsxAttribute;
      callback = (attr.initializer as ts.JsxExpression).expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(main); assert.ok(callback);
  let pending = 2, flag = false;
  const ownerRef = { current: 'one' };
  const handler = new Function('env', `with(env){${ts.transpile('const handler=' + callback.getText(source) + ';return handler;', { target: ts.ScriptTarget.ES2022 })}}`)({ owner: 'one', ownerRef, setHasDrafts: (value: boolean) => { flag = value; }, flushChatWrites: async () => {}, getDatabase: async () => ({ getFirstAsync: async () => ({ n: pending }) }) });
  handler(true); assert.equal(flag, true);
  handler(false); for (let i = 0; i < 20; i++) await Promise.resolve(); assert.equal(flag, true, 'another saved draft keeps the host guard after leaving chat');
  pending = 0; handler(false); for (let i = 0; i < 20; i++) await Promise.resolve(); assert.equal(flag, false);
  ownerRef.current = 'two'; handler(true); assert.equal(flag, false, 'old account cannot change the new account guard');
});


test('Chat empty verification is scoped to the current account and session and cannot be restored by an old response', () => {
  const declaration = app.body!.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'chatInboxEmptyChanged')!;
  let verified = '';
  const ownerRef = { current: 'one' }, activeSessionRef = { current: { token: 'fresh' } };
  const change = new Function('env', `with(env){${ts.transpile(declaration.getText(source), { target: ts.ScriptTarget.ES2022 })};return chatInboxEmptyChanged;}`)({ ownerRef, activeSessionRef, accountOwner: (active: any) => active.owner, setEmptyChatScope: (value: any) => { verified = typeof value === 'function' ? value(verified) : value; } });
  change({ owner: 'one', token: 'fresh' }, true); assert.equal(verified, 'one|fresh');
  change({ owner: 'one', token: 'old' }, false); assert.equal(verified, 'one|fresh');
  change({ owner: 'one', token: 'old' }, true); assert.equal(verified, 'one|fresh');
  change({ owner: 'two', token: 'fresh' }, true); assert.equal(verified, 'one|fresh');
  change({ owner: 'one', token: 'fresh' }, false); assert.equal(verified, '');
});
