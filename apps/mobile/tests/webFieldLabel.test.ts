import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('HTML field labels retain a sans-serif fallback before custom fonts load and preserve their input association', () => {
  const source = ts.createSourceFile('FieldLabel.web.tsx', readFileSync(new URL('../src/FieldLabel.web.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export default /, '')).join('\n');
  const React = { createElement: (type: string, props: any, ...children: any[]) => ({ type, props, children }) };
  const shared = '"Stack Sans Text", system-ui, sans-serif';
  const component = new Function('React', 'StyleSheet', 'appFontFamily', ts.transpile(body, { jsx: ts.JsxEmit.React }) + ';return FieldLabel;')(React, { flatten: (value: any) => value }, shared);
  const label = component({ nativeID: 'description', style: { fontSize: 14, lineHeight: 20 }, children: 'Description' });
  assert.equal(label.type, 'label'); assert.equal(label.props.htmlFor, 'description'); assert.equal(label.props.style.fontFamily, shared); assert.equal(label.props.style.lineHeight, '20px');
  assert.equal(component({ style: { fontFamily: 'Custom label font' } }).props.style.fontFamily, 'Custom label font');
});
