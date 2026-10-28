import { currencySymbol } from '../src/currency.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as accounting from '../src/accounting.ts';

const source = ts.createSourceFile('ExpenseForm.tsx', readFileSync(new URL('../src/ExpenseForm.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const body = source.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(source).replace(/^export (?:default )?/, '')).join('\n');
const env: any = { animateLayout() {}, currencySymbol, ...accounting, React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) },
  StyleSheet: { create: (value: any) => value, hairlineWidth: 1 }, View: 'View', Text: 'Text', Button: 'Button', Avatar: 'Avatar', Icon: 'Icon', TextField: 'TextField',
  useUI: () => ({ ui: {}, motion: { enabled: false }, palette: { line: '#ddd', accent: '#639', outline: '#888' }, dark: false }) };
const { PersonChoice, SplitFields, PayerFields } = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return {PersonChoice, SplitFields, PayerFields};}`)(env);
function nodes(tree: any, type: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(n => nodes(n, type));
  if (!tree) return [];
  return [...(tree.type === type ? [tree] : []), ...(tree.children ?? []).flatMap((n: any) => nodes(n, type))];
}
const participants = [{ id: 'a', name: 'Asha' }, { id: 'b', name: 'Dev' }, { id: 'c', name: 'Removed', removed: true }];
const draft = { amount: '10.01', mode: 'equal', participantIds: ['a', 'b'], payerIds: ['a'], payerAmounts: {}, splitValues: {} };
const props = { participants, draft, disabled: false, preserveRemoved: false, label: (id: string) => id, onChange: () => {}, status: '' };

test('split rows preserve rounding and selection when the whole row is tapped', () => {
  let change: any;
  const rows = nodes(SplitFields({ ...props, onChange: (patch: any) => change = patch }), PersonChoice);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.props.amount), ['₹5.01', '₹5.00']);
  rows[0].props.onPress();
  assert.deepEqual(change, { participantIds: ['b'] });
  const unselected = nodes(SplitFields({ ...props, draft: { ...draft, participantIds: ['b'] } }), PersonChoice)[0];
  assert.equal(unselected.props.amount, 'Not included');
});

test('payer rows keep multiple payer fields and removed participant protection', () => {
  let toggled: string | undefined;
  const tree = PayerFields({ ...props, preserveRemoved: true, draft: { ...draft, payerIds: ['a', 'c'], payerAmounts: { a: '5', c: '5.01' } }, onToggle: (id: string) => toggled = id, onAdjust: () => {} });
  const rows = nodes(tree, PersonChoice);
  assert.equal(rows.find(row => row.props.person.id === 'c').props.disabled, true);
  rows[0].props.onPress(); assert.equal(toggled, 'a');
  assert.equal(nodes(tree, 'TextField').length, 2);
});

test('person row exposes checkbox semantics and respects disabled state', () => {
  const row = PersonChoice({ person: participants[0], title: 'Asha', selected: true, disabled: true, amount: '₹5.01', onPress: () => {} });
  assert.equal(row.props.accessibilityRole, 'checkbox');
  assert.deepEqual(row.props.accessibilityState, { checked: true, disabled: true });
  assert.equal(row.props.disabled, true);
  assert.match(row.props.accessibilityLabel, /Asha.*₹5.01/);
});

test('exact split previews retain zero shares and hide incomplete allocations', () => {
  const exact = { ...draft, mode: 'exact', splitValues: { a: '0', b: '10.01' } };
  assert.deepEqual(nodes(SplitFields({ ...props, draft: exact }), PersonChoice).map(row => row.props.amount), ['₹0.00', '₹10.01']);
  assert.ok(nodes(SplitFields({ ...props, draft: { ...exact, splitValues: { a: '', b: '10.01' } } }), PersonChoice).every(row => row.props.amount === undefined));
});
