import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let secondary: ts.Expression | undefined, sendCode: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isJsxAttribute(node) && node.name.getText(source) === 'secondary' && node.initializer && ts.isJsxExpression(node.initializer)) secondary = node.initializer.expression;
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'sendSignInCode') sendCode = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(secondary && sendCode, 'Use the actual App secondary action and sendSignInCode');
const compile = (text: string) => ts.transpile(text, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
const React = { createElement: (type: string, props: Record<string, unknown>) => ({ type, props }) };
const fixtures = [
  ['empty', '', false, false], ['whitespace', ' \t ', false, false],
  ['malformed', 'not-email', false, false], ['missing domain dot', 'you@example', false, false],
  ['valid', 'you@example.com', false, true], ['trimmed valid', ' you@example.com ', false, true],
  ['busy valid', 'you@example.com', true, false], ['busy empty', '', true, false],
] as const;

test('actual web Use a code instead rejects invalid/busy email before launch or request', async t => {
  for (const [name, email, busy, allowed] of fixtures) await t.test(name, async () => {
    let launches = 0, requests = 0, banner = '', pending = Promise.resolve();
    const noop = () => {};
    const scope = { email, API_URL: 'https://example.invalid', setEmailRequested: noop, setChallenge: noop, setRetryAt: noop, setCode: noop, setClock: noop,
      requestEmailCode: async () => { requests++; if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('The code is incorrect or expired. Try again.'); return { challengeId: 'mock', retryAfter: 30 }; } };
    const sendSignInCode = new Function(...Object.keys(scope), `${compile(sendCode!.getText(source))};return sendSignInCode;`)(...Object.values(scope));
    const launch = (action: () => Promise<unknown>) => { launches++; pending = action().then(() => {}, (error: Error) => { banner = error.message; }); };
    const controls = { React, Button: 'button', Platform: { OS: 'web' }, email, busy, launch, sendSignInCode };
    const button = new Function(...Object.keys(controls), `${compile(`const secondary = ${secondary!.getText(source)};`)};return secondary;`)(...Object.values(controls));
    assert.equal(button.props.title, 'Use a code instead');
    // Invoke directly too: disabled presentation alone must not guard dispatch.
    button.props.onPress(); await pending;
    assert.deepEqual({ disabled: button.props.disabled, launches, requests, banner }, { disabled: !allowed, launches: allowed ? 1 : 0, requests: allowed ? 1 : 0, banner: '' });
  });
});
