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
const code = ts.transpile(fn.getText(source).replace('export default ', ''), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });

test('Create footer stays in normal layout above custom/native navigation', () => {
  for (const OS of ['ios', 'android', 'web']) for (const Version of [25, 26, 27]) for (const direct of [false, true]) {
    let loaded = 0, clicked = 0;
    const env = { React, View: 'View', Button: 'Button', Icon: 'Icon', GlassSurface: 'GlassSurface', useUI: () => ({ palette: { accent: 'accent', muted: 'muted' } }), Platform: { OS, Version }, pageWidthStyle: OS === 'web' ? { maxWidth: 760, alignSelf: 'center' } : {},
      require: (name: string) => { assert.equal(name, 'react-native-screens/experimental'); loaded++; return { SafeAreaView: 'NativeSafeAreaView' }; } };
    const render = new Function('env', `with(env){${actionCode};${code};return HomeCreateButton;}`)(withSharedUI(env));
    const tree = render({ direct, disabled: false, onPress: () => clicked++ });
    const native = OS === 'ios' && Version >= 26;
    assert.equal(tree.type, native ? 'NativeSafeAreaView' : 'View');
    assert.equal(loaded, native ? 1 : 0, 'Only native iOS tabs need the experimental inset component');
    assert.deepEqual(tree.props.edges, native ? { bottom: true } : undefined);
    assert.deepEqual(tree.props.style, { flex: 0 });
    assert.equal(tree.props.pointerEvents, 'box-none');
    assert.equal(tree.props.collapsable, false);
    const content = tree.children[0], glass = content.children[0], button = OS === 'ios' ? glass.children[0] : glass;
    if (OS === 'ios') { assert.equal(glass.type, 'GlassSurface'); assert.equal(glass.props.interactive, true); assert.equal(glass.props.tintColor, 'accent'); }
    assert.equal(button.props.kind, 'primary');
    assert.equal(button.props.style.backgroundColor, OS === 'ios' ? 'transparent' : 'accent', 'iOS pressable must not paint over native glass');
    assert.equal(tree.props.style.position, undefined, 'home actions reserve space instead of overlaying the tabs');
    assert.equal(content.props.pointerEvents, 'box-none');
    assert.equal(content.props.style[1].paddingBottom, 16);
    assert.equal(content.props.style[1].alignItems, 'flex-end');
    assert.equal(button.props.title, direct ? 'Add person' : 'Add group');
    assert.equal(button.props.style.minHeight, 48);
    assert.equal(button.props.style.borderRadius, 999);
    button.props.onPress(); assert.equal(clicked, 1);
    const disabled=render({ direct, disabled: true, onPress() {} }).children[0].children[0];
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

test('Create footer keeps the existing route, appears on Groups/People only, and removes obsolete overlay padding', () => {
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
  const padding = find(node => ts.isJsxAttribute(node) && node.name.getText(app) === 'contentContainerStyle' && node.getText(app).includes('showAddExpense')) as ts.JsxAttribute;
  const styles = new Function('showCreate', 'showAddExpense', 'pageContentStyle', 'createClearance=104', "screen='home'", "tab='Groups'", 'usesNativeHomeTabs=false', `return ${(padding.initializer as ts.JsxExpression).expression!.getText(app)}`);
  assert.equal(styles(true, false, {})[1], false);
  assert.equal(styles(false, true, {})[1].paddingBottom, 120);
  assert.equal(styles(false, false, {})[1], false);
  assert.equal(styles(true, false, {}, 180)[1], false, 'Normal-flow footer grows naturally with text');
});

test('stack floating actions report their entire overlay including bottom safe area',()=>{
 const source=readFileSync(new URL('../src/FloatingActionContainer.tsx',import.meta.url),'utf8').replace(/^import .*$/mg,'').replace('export default ','');
 const code=ts.transpile(source,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
 const render=new Function('env',`with(env){${code};return FloatingActionContainer;}`)({React,Platform:{OS:'ios',Version:27},BottomSafeArea:'BottomSafeArea',View:'View',pageWidthStyle:{}});
 let height=0;const tree=render({home:false,children:'Add expense',onHeight:(value:number)=>{height=value;}});
 assert.equal(tree.type,'BottomSafeArea');assert.equal(tree.children[0].props.onLayout,undefined);
 tree.props.onLayout({nativeEvent:{layout:{height:196}}});assert.equal(height,196);
});
