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
const main = app.body!.statements.filter(ts.isReturnStatement).map(node => node.expression).find((node): node is ts.JsxElement => !!node && ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'AppFrame')!;
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
    ExportData: 'ExportData', SettingsRow: 'SettingsRow', Disclosure: 'Disclosure', Button: 'Button', Text: 'Text', SavedChanges: 'SavedChanges', LegacyRecords: 'LegacyRecords' };
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
