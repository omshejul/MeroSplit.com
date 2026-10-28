import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { signInTopPadding } from '../src/authLayoutMetrics.ts';

test('whole intrinsic group centers at40% when it fits; short and enlarged content scroll normally', () => {
  assert.equal(signInTopPadding(1000, 500) + 250, 400);
  assert.equal(signInTopPadding(844, 480) + 240, 844 * 0.4);
  for (const [height, content] of [[320, 600], [600, 1100], [0, 0]]) assert.equal(signInTopPadding(height, content), 24);
});
type Node = { type: string; props: Record<string, any>; children: any[] };
const React = { createElement: (type: string, props: Record<string, any> | null, ...children: any[]): Node => ({ type, props: props ?? {}, children: children.flat() }) };
function form(name: string, props: object, state: any[] = []): Node {
  let cursor = 0;
  const source = ts.createSourceFile('form.tsx', readFileSync(new URL('../src/SignInForms.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const decl = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const deps = { React, useState: (initial: unknown) => { const id = cursor++; if (!(id in state)) state[id] = initial; return [state[id], (value: unknown) => state[id] = value]; }, useEffect(effect: () => void) { effect(); }, Form: 'form', Text: 'text', View: 'view', EmailField: 'email', TextField: 'input', Button: 'button', useUI: () => ({ palette: { line: '#ddd' }, ui: { caption: {}, body: {} } }) };
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
test('presentation changes preserve the reviewed auth controllers without requiring Git history', () => {
  const current = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  // Exact controller fixtures from reviewed source22112aa. Release counters and dependencies are audited separately.
  const reviewed: Record<string,string> = {
  "sendSignInCode": "57fa019df0c132a05404c1989b0c4c9872d6296018d924159150ad984835cb36",
  "sendSignInLink": "e9972d6e7eece6ff6bd8ca0714bd510040e8f763e35e0f4aaa28d961e47d2d8b",
  "finishSignIn": "73b3a6bed68244e0faed2a760a322321fba2d6af88e03dc3c5d6651db992c478",
  "finishGoogleSignIn": "0c5723ea66bce492fd89a3fbd2fa821cc925cc2285ba11355055b8458dd5ff0f",
  "deleteAccount": "7ac840def4666b3e5d98d1c499a225708241b765f662cb586f0a9a164809ad90"
};
  const source = ts.createSourceFile('App.tsx', current, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), functions = new Map<string,string>();
  function visit(node:ts.Node) { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text,node.getText(source)); ts.forEachChild(node,visit); } visit(source);
  for (const [name,hash] of Object.entries(reviewed)) { assert.ok(functions.has(name),name); assert.equal(createHash('sha256').update(functions.get(name)!).digest('hex'),hash,name); }
  assert.ok(current.includes("screen === 'login' ? loginContent")); assert.ok(!current.includes('<Mascot size="welcome"'));
});


test('email progress belongs only to the pressed email action',()=>{
 const state:any[]=[];let sends=0;const props={email:'fixture@example.invalid',busy:false,onEmail(){},onSend(){sends++;}};
 find(form('EmailSignIn',props,state),'button')[0].props.onPress();
 const button=find(form('EmailSignIn',{...props,busy:true},state),'button')[0];
 assert.equal(button.props.title,'Sending…');assert.equal(button.props.disabled,true);button.props.onPress();assert.equal(sends,1);
 assert.equal(find(form('EmailSignIn',{...props,busy:true}),'button')[0].props.title,'Send sign-in code','another provider being busy does not claim email is sending');
 assert.equal(find(form('EmailSignIn',props,state),'button')[0].props.title,'Send sign-in code');
});

test('code verification and resend show progress on their own buttons',()=>{
 for(const action of ['confirm','resend']){const state:any[]=[];let calls=0;const props={email:'fixture@example.invalid',code:'1234',busy:false,resendSeconds:0,onCode(){},onConfirm(){calls++;},onResend(){calls++;},onChangeEmail(){}};
  const index=action==='confirm'?0:1;find(form('CodeSignIn',props,state),'button')[index].props.onPress();
  const buttons=find(form('CodeSignIn',{...props,busy:true},state),'button');assert.equal(buttons[index].props.title,action==='confirm'?'Signing in…':'Sending…');assert.equal(buttons[1-index].props.title,action==='confirm'?'Resend code':'Sign in');buttons[index].props.onPress();assert.equal(calls,1);
 }
});
