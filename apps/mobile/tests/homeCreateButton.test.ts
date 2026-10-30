import { withSharedUI } from './componentHarness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const React = { createElement: (type: any, props: any, ...children: any[]) => typeof type === 'function' ? type(props) : ({ type, props: props ?? {}, children }) };
const actionSource = readFileSync(new URL('../src/AddActionButton.tsx', import.meta.url), 'utf8').replace(/^import .*$/mg, '').replace('export default ', '');
const actionCode = ts.transpile(actionSource, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
const source = ts.createSourceFile('HomeCreateButton.tsx', readFileSync(new URL('../src/HomeCreateButton.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = source.statements.find(node => ts.isFunctionDeclaration(node))!;
const insetFn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'HomeCreateInset')!;
const insetCode = ts.transpile(insetFn.getText(source).replace('export ', ''), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
const code = ts.transpile(fn.getText(source).replace('export default ', ''), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });

test('Create capsule anchors above custom/native navigation and keeps margins transparent to touches', () => {
  for (const OS of ['ios', 'android', 'web']) for (const Version of [25, 26, 27]) for (const direct of [false, true]) {
    let loaded = 0, clicked = 0;
    const env = { React, View: 'View', Button: 'Button', Icon: 'Icon', GlassSurface: 'GlassSurface', useUI: () => ({ palette: { accent: 'accent', muted: 'muted' } }), Platform: { OS, Version }, pageWidthStyle: OS === 'web' ? { maxWidth: 760, alignSelf: 'center' } : {},
      require: (name: string) => { assert.equal(name, 'react-native-screens/experimental'); loaded++; return { SafeAreaView: 'NativeSafeAreaView' }; } };
    const render = new Function('env', `with(env){${actionCode};${code};return HomeCreateButton;}`)(withSharedUI(env));
    const tree = render({ direct, disabled: false, onPress: () => clicked++ });
    const native = OS === 'ios' && Version >= 26;
    assert.equal(tree.type, native ? 'NativeSafeAreaView' : 'View');
    assert.equal(loaded, native ? 1 : 0, 'Only native iOS tabs need the experimental inset component');
    const inset = new Function('env', `with(env){${insetCode};return HomeCreateInset;}`)(withSharedUI(env))();
    if (native) { assert.equal(inset.type, 'NativeSafeAreaView'); assert.deepEqual(inset.props.edges, { bottom: true }); assert.equal(inset.props.pointerEvents, 'none'); } else assert.equal(inset, null);
    assert.deepEqual(tree.props.edges, native ? { bottom: true } : undefined);
    assert.deepEqual(tree.props.style, { position: 'absolute', left: 0, right: 0, bottom: 0, flex: 0, zIndex: 1 });
    assert.equal(tree.props.pointerEvents, 'box-none');
    assert.equal(tree.props.collapsable, false);
    const content = tree.children[0], glass = content.children[0], button = OS === 'ios' ? glass.children[0] : glass;
    if (OS === 'ios') { assert.equal(glass.type, 'GlassSurface'); assert.equal(glass.props.interactive, true); assert.equal(glass.props.tintColor, 'accent'); }
    assert.equal(button.props.kind, 'primary');
    assert.equal(button.props.style.backgroundColor, OS === 'ios' ? 'transparent' : 'accent', 'iOS pressable must not paint over native glass');
    let measured = 0;
    const measuredTree = render({ direct, disabled: false, onPress() {}, onHeight: (height: number) => { measured = height; } });
    measuredTree.children[0].props.onLayout({ nativeEvent: { layout: { height: 164 } } });
    assert.equal(measured, 164);
    assert.equal(content.props.pointerEvents, 'box-none');
    assert.equal(content.props.style[1].paddingBottom, 16);
    assert.equal(content.props.style[1].alignItems, 'flex-end');
    assert.equal(button.props.title, direct ? 'Add person' : 'Add group');
    assert.equal(button.props.style.minHeight, 48);
    assert.equal(button.props.style.borderRadius, 999);
    button.props.onPress(); assert.equal(clicked, 1);
    const disabled = render({ direct, disabled: true, onPress() {} }).children[0].children[0];
    assert.equal((OS === 'ios' ? disabled.children[0] : disabled).props.disabled, true);
    if (OS === 'ios') assert.equal(disabled.props.interactive, false);
  }
});

const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean) {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); }
  visit(app); assert.ok(found); return found!;
}

test('Create capsule keeps the existing create route, appears on Groups/People only, and clears the last row', () => {
  const declaration = find(node => ts.isVariableDeclaration(node) && node.name.getText(app) === 'showCreate') as ts.VariableDeclaration;
  const show = new Function('screen', 'tab', 'direct', 'showArchived', 'showHidden', `return ${declaration.initializer!.getText(app)}`);
  for (const screen of ['home', 'group', 'create', 'members', 'billChat', 'login']) for (const tab of ['Groups', 'Friends', 'Activity', 'Account']) for (const archived of [false, true]) for (const hidden of [false, true]) {
    assert.equal(show(screen, tab, tab === 'Friends', archived, hidden), screen === 'home' && (tab === 'Friends' || tab === 'Groups' && !archived && !hidden));
  }
  const capsule = find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'HomeCreateButton') as ts.JsxSelfClosingElement;
  for (let parent: ts.Node | undefined = capsule.parent; parent; parent = parent.parent) {
    assert.ok(!ts.isJsxElement(parent) || parent.openingElement.tagName.getText(app) !== 'ScrollView', 'Create must remain reachable without scrolling');
  }
  const press = capsule.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(app) === 'onPress') as ts.JsxAttribute;
  const calls: string[] = [];
  new Function('navigate', `return ${((press.initializer as ts.JsxExpression).expression!).getText(app)}`)((name: string) => calls.push(name))();
  assert.deepEqual(calls, ['create']);
  const padding = find(node => ts.isJsxAttribute(node) && node.name.getText(app) === 'contentContainerStyle' && node.getText(app).includes('showCreate')) as ts.JsxAttribute;
  const styles = new Function('showCreate', 'showAddExpense', 'pageContentStyle', 'createClearance=104', "screen='home'", "tab='Groups'", 'usesNativeHomeTabs=false', `return ${(padding.initializer as ts.JsxExpression).expression!.getText(app)}`);
  assert.equal(styles(true, false, {})[1].paddingBottom, 104);
  assert.equal(styles(false, true, {})[1].paddingBottom, 120);
  assert.equal(styles(false, false, {})[1], false);
  assert.equal(styles(true, false, {}, 180)[1].paddingBottom, 180, 'Larger accessibility text gets measured clearance');
});
