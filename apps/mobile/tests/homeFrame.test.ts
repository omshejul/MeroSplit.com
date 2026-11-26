import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const React = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  isValidElement: (value: any) => !!value && typeof value === 'object' && 'type' in value,
};
const source = (path: string) => ts.createSourceFile(path, readFileSync(new URL('../' + path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function fn(file: ts.SourceFile, name: string) {
  let result: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node; ts.forEachChild(node, visit); }
  visit(file); assert.ok(result); return result.getText(file).replace(/^export /, '');
}
function compile(body: string, name: string, env: object) {
  return new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return ${name};}`)({ React, ...env });
}

test('native tabs own the full window while ordinary and fallback screens retain safe-area framing', () => {
  const file = source('App.tsx');
  const body = fn(file, 'renderFramedScreen');
  for (const native of [true, false]) for (const type of ['HomeTabs', 'Login', 'Bill', 'Error']) {
    const content = { type, props: {}, children: [] };
    const render = compile(body, 'renderFramedScreen', { usesNativeHomeTabs: native, HomeTabs: 'HomeTabs', AppFrame: 'AppFrame', renderScreen: () => content });
    const tree = render({ name: 'home' }, true, () => {});
    if (native && type === 'HomeTabs') assert.equal(tree, content, 'UIKit host cannot inherit content-safe-area padding');
    else { assert.equal(tree.type, 'AppFrame'); assert.equal(tree.children[0], content); }
  }
});

test('window-only frame leaves native controllers unpadded, while screen frames own safe areas and keyboard avoidance', () => {
  const file = source('src/AppNavigation.tsx');
  const render = compile(fn(file, 'AppFrame'), 'AppFrame', { View: 'View', StatusBar: 'StatusBar', SafeAreaView: 'SafeAreaView', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'ios' }, useUI: () => ({ palette: { background: '#fff' }, dark: false }) });
  const host = { type: 'NativeTabs' };
  const full = render({ children: host, windowOnly: true });
  assert.equal(full.children[1], host);
  const screen = render({ children: 'screen' });
  assert.equal(screen.children[1].type, 'SafeAreaView');
  assert.deepEqual(screen.children[1].props.edges, { top: 'maximum', left: 'additive', right: 'additive', bottom: 'off' });
  assert.equal(screen.children[1].children[0].type, 'KeyboardAvoidingView');
});

test('app stack is mounted inside the unpadded window frame', () => {
  const file = source('App.tsx'); let frame: ts.JsxOpeningElement | undefined;
  function visit(node: ts.Node) { if (ts.isJsxOpeningElement(node) && node.tagName.getText(file) === 'AppFrame' && node.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(file) === 'onTouchStart')) frame = node; ts.forEachChild(node, visit); }
  visit(file); assert.ok(frame);
  assert.ok(frame.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(file) === 'windowOnly' && !p.initializer));
});
