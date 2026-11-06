import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function program(file: string, names: string[], env: any) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  return new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return {${names.join(',')}};}`)(env);
}
const { RowGroup, groupRows } = program('RowGroup.tsx', ['RowGroup', 'groupRows'], { React, View: 'View', RowDividerContext: { Provider: 'DividerProvider' } });
const row = (key: string) => React.createElement('Row', { key, id: key });

test('row groups have no trailing divider for zero, one or multiple rows', () => {
  for (const count of [0, 1, 2, 20]) {
    const tree = RowGroup({ children: Array.from({ length: count }, (_, i) => row(String(i))) });
    assert.equal(tree.props.children.length, count);
    assert.deepEqual(tree.props.children.map((p: any) => p.props.value), Array.from({ length: count }, (_, i) => i < count - 1));
  }
});

test('fragments, arrays and conditional rows cannot create empty separators', () => {
  const children = [false, null, row('a'), [undefined, React.createElement(React.Fragment, {}, row('b'), false)], null];
  const tree = RowGroup({ children });
  assert.deepEqual(tree.props.children.map((p: any) => [p.props.children.props.id, p.props.value]), [['a', true], ['b', false]]);
  const single = RowGroup({ children: [row('a'), false, null] }); assert.equal(single.props.children[0].props.value, false);
});

test('removing or adding another person preserves existing editable row keys', () => {
  const before = groupRows([row('a'), row('b'), row('c')]);
  const after = groupRows([row('a'), row('c')]);
  assert.equal(after[0].key, before[0].key); assert.equal(after[1].key, before[2].key);
});

test('nested groups own their own separators rather than inheriting a trailing border', () => {
  const inner = RowGroup({ children: [row('a'), row('b')] });
  const outer = RowGroup({ children: [inner, row('other-section')] });
  assert.equal(outer.props.children[0].props.value, true);
  assert.equal(inner.props.children.at(-1).props.value, false);
});

test('standalone rows retain a separator; groups and explicit overrides control each edge', () => {
  let grouped: boolean | undefined;
  const { useRowDivider } = program('rowDividers.ts', ['useRowDivider'], { createContext: () => ({}), useContext: () => grouped });
  assert.equal(useRowDivider(), true);
  grouped = false; assert.equal(useRowDivider(), false); assert.equal(useRowDivider(true), true);
  grouped = true; assert.equal(useRowDivider(), true); assert.equal(useRowDivider(false), false);
});
