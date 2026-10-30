import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let contentStyle: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'ScrollView') {
    const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
    if (attributes.some(item => item.name.getText(source) === 'role' && item.initializer?.getText(source) === '"main"')) {
      const value = attributes.find(item => item.name.getText(source) === 'contentContainerStyle')?.initializer;
      if (value && ts.isJsxExpression(value)) contentStyle = value.expression;
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(contentStyle, 'exercise the production main ScrollView');
const layout = readFileSync(new URL('../src/AppNavigation.tsx', import.meta.url), 'utf8');
const expression = layout.match(/export const pageContentStyle = (.*);/)![1];
const pageContentStyle = new Function('pageWidthStyle', `return (${expression});`)({});
const names = ['pageContentStyle', 'showAddExpense', 'showCreate', 'createClearance', 'screen', 'tab', 'usesNativeHomeTabs'];
const render = new Function(...names, `return (${contentStyle.getText(source)});`);
function padding(options: { native?: boolean; screen?: string; tab?: string; create?: boolean; add?: boolean } = {}) {
  const styles = render(pageContentStyle, !!options.add, !!options.create, 177, options.screen ?? 'home', options.tab ?? 'Account', options.native ?? true);
  return Object.assign({}, ...styles.filter(Boolean)).paddingBottom;
}

test('Me footer can scroll above the native tab bar and home indicator', () => {
  assert.ok(padding() >= 64 + 34 + 16, 'the last update action needs native-bar clearance, not just normal page spacing');
});

test('Me clearance is limited to native home tabs and preserves other content spacing', () => {
  assert.equal(padding({ native: false }), pageContentStyle.paddingBottom);
  assert.equal(padding({ tab: 'Groups' }), pageContentStyle.paddingBottom);
  assert.equal(padding({ tab: 'Friends' }), pageContentStyle.paddingBottom);
  assert.equal(padding({ screen: 'signInMethods' }), pageContentStyle.paddingBottom);
  assert.equal(padding({ create: true, tab: 'Groups' }), 177);
  assert.equal(padding({ add: true, screen: 'group' }), 120);
});
