import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { signInTopPadding } from '../src/authLayoutMetrics.ts';

test('whole intrinsic group centers at40% when it fits; short and enlarged content scroll normally', () => {
  assert.equal(signInTopPadding(1000, 500) + 250, 400);
  assert.equal(signInTopPadding(844, 480) + 240, 844 * 0.4);
  for (const [height, content] of [[320, 600], [600, 1100], [0, 0]]) assert.equal(signInTopPadding(height, content), 24);
});
type Node = { type: string; props: Record<string, any>; children: any[] };
const React = { createElement: (type: string, props: Record<string, any> | null, ...children: any[]): Node => ({ type, props: props ?? {}, children: children.flat() }) };
function form(name: string, props: object): Node {
  const source = ts.createSourceFile('form.tsx', readFileSync(new URL('../src/SignInForms.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const decl = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const deps = { React, Form: 'form', Text: 'text', View: 'view', EmailField: 'email', TextField: 'input', Button: 'button', useUI: () => ({ palette: { line: '#ddd' }, ui: { caption: {}, body: {} } }) };
  return new Function(...Object.keys(deps), `${ts.transpile(decl.getText(source).replace(/^export /, ''), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return ${name};`)(...Object.values(deps))(props);
}
function find(root: Node, type: string): Node[] { return [root, ...root.children.flatMap(child => child && typeof child === 'object' ? find(child, type) : [])].filter(node => node.type === type); }
test('actual provider-first form preserves email label and valid/busy submit guards', () => {
  for (const [email, busy, enabled] of [['', false, false], ['not-email', false, false], ['you@example.com', false, true], ['you@example.com', true, false]] as const) {
    let sent = 0; const root = form('EmailSignIn', { email, busy, onEmail() {}, onSend: () => sent++, children: 'providers', secondary: 'secondary', sendLabel: 'Email me a sign-in link' });
    assert.equal(root.children[0].children[0], 'providers'); assert.equal(find(root, 'text')[0].children[0], 'or');
    const field = find(root, 'email')[0], button = find(root, 'button')[0]; assert.equal(field.props.label, 'Email'); assert.equal(field.props.placeholder, 'you@example.com'); assert.equal(field.props.style.minHeight, 48); assert.equal(button.props.title, 'Email me a sign-in link'); assert.equal(button.props.disabled, !enabled); root.props.onSubmit(); assert.equal(sent, enabled ? 1 : 0);
  }
});
test('actual code form preserves four digits and resend limit', () => {
  let entered = '', confirmed = 0; const root = form('CodeSignIn', { email: 'you@example.com', code: '1234', busy: false, resendSeconds: 30, onCode: (value: string) => entered = value, onConfirm: () => confirmed++, onResend() {}, onChangeEmail() {} });
  find(root, 'input')[0].props.onChangeText('12a345'); assert.equal(entered, '1234'); root.props.onSubmit(); assert.equal(confirmed, 1); assert.equal(find(root, 'button')[1].props.disabled, true);
});
test('auth controllers and counter/dependency metadata are unchanged from accepted main', () => {
  const current = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), base = execFileSync('/usr/bin/git', ['show', '7b04ba49f14dc121a3bd80576a2efb375549ef2e:apps/mobile/App.tsx'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const functions = (text: string) => { const source = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), found = new Map<string, string>(); function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node.getText(source)); ts.forEachChild(node, visit); } visit(source); return found; }; const a = functions(base), b = functions(current);
  for (const name of ['sendSignInCode', 'sendSignInLink', 'finishSignIn', 'finishGoogleSignIn', 'deleteAccount']) { assert.ok(a.has(name), name); assert.equal(b.get(name), a.get(name), name); }
  assert.ok(current.includes("screen === 'login' ? loginContent")); assert.ok(!current.includes('<Mascot size="welcome"'));
  for (const name of ['app.json', 'package.json', 'pnpm-lock.yaml']) assert.deepEqual(readFileSync(new URL('../'+name, import.meta.url)), execFileSync('/usr/bin/git', ['show', `7b04ba49f14dc121a3bd80576a2efb375549ef2e:apps/mobile/${name}`], { cwd: new URL('..', import.meta.url) }));
});
