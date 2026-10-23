import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { availableUPIApps, openUPIPayment } from '../src/upi.ts';

test('production UPI callbacks preserve the installed React Native Linking receiver before crossing the OS boundary', async () => {
  const source = readFileSync(new URL('../src/SettleForm.tsx', import.meta.url), 'utf8');
  const file = ts.createSourceFile('SettleForm.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks: { name: string; code: string }[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['availableUPIApps', 'openUPIPayment'].includes(node.expression.text)) callbacks.push({ name: node.expression.text, code: node.arguments.at(-1)!.getText(file) });
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(callbacks.filter(value => value.name === 'availableUPIApps').length, 1);
  assert.equal(callbacks.filter(value => value.name === 'openUPIPayment').length, 2, 'native and explicit browser handoff both covered');
  const rn = readFileSync(new URL('../node_modules/react-native/Libraries/Linking/Linking.js', import.meta.url), 'utf8');
  const calls = { query: 0, open: 0 };
  const native = { canOpenURL: async (url: string) => { calls.query++; return url.startsWith('gpay:'); }, openURL: async () => { calls.open++; } };
  function installedMethod(name: string) {
    const start = rn.indexOf(`  ${name}(`); assert.ok(start >= 0);
    const opening = rn.indexOf('{', start); let depth = 1, end = opening + 1;
    while (depth && end < rn.length) { if (rn[end] === '{') depth++; if (rn[end] === '}') depth--; end++; }
    assert.equal(depth, 0);
    return Function('Platform', 'nullthrows', 'NativeIntentAndroid', 'NativeLinkingManager', 'invariant', `"use strict"; return function(url) {${rn.slice(opening + 1, end - 1)}};`)(
      { OS: 'ios' }, (value: unknown) => { assert.ok(value); return value; }, native, native,
      (condition: boolean, message: string) => { if (!condition) throw new Error(message); });
  }
  const Linking = Object.fromEntries(['_validateURL', 'canOpenURL', 'openURL'].map(name => [name, installedMethod(name)]));
  // Control reproduces the reported symptom with the actual installed RN bodies.
  assert.deepEqual(await availableUPIApps('ios', Linking.canOpenURL), []);
  assert.equal(calls.query, 0, 'detached methods fail before querying the OS');
  const quote = { id: 'b7cc727a-992b-4d75-9f7b-a5accdb6c6ae', vpa: 'synthetic@invalid', amount: '334', currency: 'INR', recipient: 'Synthetic payee', note: 'Test only', bank_verified: false as const, direct_launch_supported: true, expires_at: '2099-01-01T00:00:00Z', group_version: 1 };
  for (const value of callbacks) {
    const callback = Function('Linking', `return (${value.code});`)(Linking);
    if (value.name === 'availableUPIApps') assert.ok((await availableUPIApps('ios', callback)).some(app => app.id === 'google-pay'));
    else await openUPIPayment(quote, 'google-pay', { amount: quote.amount, vpa: quote.vpa, name: quote.recipient }, callback);
  }
  assert.equal(calls.query, 7);
  assert.equal(calls.open, 2, 'only the fake native OS methods run; no bank app is opened');
});
