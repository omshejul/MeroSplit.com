import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expenseBalanceChange, formatMoney } from '../src/accounting.ts';
import { paymentPresentation } from '../src/activityPresentation.ts';

type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }) };
const source = ts.createSourceFile('GroupScreen.tsx', readFileSync(new URL('../src/GroupScreen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function production(name: string) {
  const helpers = source.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ['billImpact', 'participantName', 'displayDate'].includes(d.name.getText(source)))).map(node => node.getText(source)).join('\n');
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name); assert.ok(node);
  const code = ts.transpile(`${helpers}\n${node.getText(source)}\nreturn ${name};`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  return new Function('env', `with(env) { ${code} }`)({ React, expenseBalanceChange, formatMoney, paymentPresentation, Text: 'Text', TransactionRow: 'TransactionRow', VisibleExpense: 'VisibleExpense', balanceColor: (amount: string) => BigInt(amount) < 0n ? 'negative' : 'positive', useUI: () => ({ ui: {}, palette: {} }) });
}
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('children' in tree)) return [];
  const node = tree as Element; return [node, ...node.children.flatMap(elements)];
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object' && 'children' in tree) return text((tree as Element).children);
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
}
const group = { id: 'g', participants: [{ id: 'self', name: 'Actual self name' }, { id: 'other', name: 'Noor' }] };

test('self-paid multipayer bill stays a bill and visibly shows exact paid/share amounts, not gross cashflow', () => {
  const bill = { id: 'bill', version: 1, description: 'Lunch', total: '1001', paid: { self: '401', other: '600' }, shares: { self: '667', other: '334' }, date: '2026-10-18', deleted: false };
  const opened: unknown[] = [], render = production('BillTimelineRow');
  const tree = render({ expense: bill, group, selfId: 'self', busy: false, onExpense: (value: unknown) => opened.push(value) });
  const row = elements(tree).find(node => node.type === 'TransactionRow')!;
  assert.equal(row.props.icon, 'bill'); assert.equal(row.props.amount, '1001'); assert.equal(row.props.cashflow, undefined);
  assert.ok(text(tree).includes(`You paid ${formatMoney('401')}, Noor paid ${formatMoney('600')}`));
  assert.ok(text(tree).includes(`Your share ${formatMoney('667')}`));
  assert.ok(text(tree).includes(`Balance −${formatMoney('266')}`));
  assert.ok(row.props.label.includes(`Your share ${formatMoney('667')}`));
  row.props.onPress(); assert.equal(opened[0], bill);
  const deleted = render({ expense: { ...bill, deleted: true }, group, selfId: 'self', busy: false });
  assert.ok(text(deleted).includes('No balance impact'));
});

test('only accepted payments render the explicit Payment cue; reversal and receipt uncertainty stay visible', () => {
  const render = production('PaymentRow');
  const payment = { id: 'record', sender: 'self', recipient: 'other', amount: '334', method: 'manual_record', date: null };
  const base = { group, selfId: 'self', busy: false, onPayment() {}, payment };
  assert.equal(render({ ...base, accepted: { settlements: [] } }), null);
  const tree = render({ ...base, accepted: { settlements: [payment] } });
  assert.equal(tree.props.icon, 'payment'); assert.equal(tree.props.title, 'You paid Noor'); assert.equal(tree.props.cashflow, '-334');
  assert.ok(text(tree).includes('Payment · Receipt unconfirmed')); assert.ok(text(tree).includes('Date unavailable'));
  const reversed = { ...payment, reversed: true };
  const history = render({ ...base, payment: reversed, accepted: { settlements: [], transactions: [{ kind: 'payment', payment: reversed }] } });
  assert.equal(history.props.cashflow, '0'); assert.ok(text(history).includes('Payment · Record reversed · No bank refund'));
});
