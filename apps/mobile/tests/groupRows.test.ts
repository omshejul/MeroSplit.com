import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expenseBalanceChange, formatMoney } from '../src/accounting.ts';
import { paymentPresentation } from '../src/activityPresentation.ts';
import { personalSettlements, personalTransfers } from '../src/personalBalances.ts';

type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }) };
const source = ts.createSourceFile('GroupScreen.tsx', readFileSync(new URL('../src/GroupScreen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function production(name: string) {
  const helpers = source.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ['billImpact', 'participantName', 'displayDate', 's'].includes(d.name.getText(source)))).map(node => node.getText(source)).join('\n');
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name); assert.ok(node);
  const code = ts.transpile(`${helpers}\n${node.getText(source).replace(/^export (?:default )?/, '')}\nreturn ${name};`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  return new Function('env', `with(env) { ${code} }`)({ React, expenseBalanceChange, formatMoney, paymentPresentation, personalSettlements, personalTransfers, useState: (initial: unknown) => [initial, () => {}], Text: 'Text', View: 'View', Pressable: 'Pressable', Icon: 'Icon', Button: 'Button', RecordSummary: 'RecordSummary', ParticipantAmountRow: 'ParticipantAmountRow', TransactionRow: 'TransactionRow', VisibleExpense: 'VisibleExpense', HistoryPages: 'HistoryPages', BillSearch: 'BillSearch', PaymentRow: 'PaymentRow', BillTimelineRow: 'BillTimelineRow', Disclosure: 'Disclosure', StyleSheet: { create: (styles: unknown) => styles }, radii: { surface: 16 }, balanceColor: (amount: string) => BigInt(amount) < 0n ? 'negative' : 'positive', useUI: () => ({ ui: {}, palette: {} }) });
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

test('accepted payment is a compact, wrapping sentence with an unboxed icon and the same details action', () => {
  const render = production('PaymentRow');
  const payment = { id: 'record', sender: 'self', recipient: 'other', amount: '334', method: 'manual_record', date: null };
  const opened: unknown[] = [];
  const base = { group, selfId: 'self', busy: false, onPayment: (value: unknown) => opened.push(value), payment };
  assert.equal(render({ ...base, accepted: { settlements: [] } }), null);
  const tree = render({ ...base, accepted: { settlements: [payment] } });
  assert.equal(tree.type, 'Pressable'); assert.equal(tree.props.accessibilityRole, 'button');
  assert.equal(tree.props.accessibilityLabel, `Payment, You paid Noor, ${formatMoney('334')}, Receipt unconfirmed, Date unavailable`);
  const nodes = elements(tree), sentence = nodes.find(node => node.type === 'Text')!;
  assert.ok(text(sentence).startsWith(`You paid Noor ${formatMoney('334')}`));
  assert.ok(!text(sentence).includes('Receipt unconfirmed')); assert.ok(text(sentence).includes('Date unavailable'));
  assert.ok(nodes.some(node => node.type === 'Icon' && node.props.name === 'payment' && node.props.size === 18));
  assert.ok(!nodes.some(node => ['TransactionRow', 'IconBadge', 'AmountText'].includes(String(node.type))));
  assert.ok(nodes.filter(node => node.type === 'Text').every(node => !node.props.numberOfLines && !node.props.ellipsizeMode));
  const styles = Object.assign({}, ...tree.props.style({ pressed: false }).filter(Boolean));
  assert.ok(styles.minHeight >= 44); assert.ok(styles.paddingVertical > 0);
  assert.equal(styles.paddingTop, undefined); assert.equal(styles.paddingBottom, undefined);
  tree.props.onPress(); assert.equal(opened[0], payment);
  assert.equal(render({ ...base, busy: true, accepted: { settlements: [payment] } }).props.disabled, true);
});

test('compact payments retain exact confirmation and reversal truth in text and their accessible label', () => {
  const render = production('PaymentRow');
  for (const [method, reversed, status] of [
    ['manual_record', false, 'Receipt unconfirmed'],
    ['recipient_confirmed', false, 'Recipient confirmed'],
    ['manual_then_confirmed', false, 'Recipient confirmed'],
    ['recipient_confirmed', true, 'Record reversed · No bank refund'],
  ] as const) {
    const payment = { id: 'record', sender: 'other', recipient: 'self', amount: '334', method, reversed, date: '2026-10-18' };
    const tree = render({ group, selfId: 'self', busy: false, payment, accepted: { settlements: [], transactions: [{ kind: 'payment', payment }] } });
    assert.ok(text(tree).includes(`Noor paid you ${formatMoney('334')}`));
    assert.equal(text(tree).includes(status), status !== 'Receipt unconfirmed'); assert.ok(tree.props.accessibilityLabel.includes(status));
    assert.ok(tree.props.accessibilityLabel.includes('18 Oct 2026'));
    assert.ok(!/bank verified|bank confirmed|refunded/i.test(text(tree)));
  }
});

test('long names and exact large payment amounts remain in the same unconstrained text flow', () => {
  const render = production('PaymentRow');
  const name = 'Alexandra Examplewithaverylongfamilyname', amount = '1234567890123456789012345678901234567890';
  const payment = { id: 'long-record', sender: 'other', recipient: 'self', amount, date: null };
  const tree = render({ group: { ...group, participants: [{ id: 'other', name }] }, selfId: 'self', busy: false, payment, accepted: { settlements: [payment] } });
  const sentence = elements(tree).find(node => node.type === 'Text')!;
  assert.ok(text(sentence).includes(`${name} paid you ${formatMoney(amount)}`));
  assert.ok(tree.props.accessibilityLabel.includes(formatMoney(amount)));
  const styles = Object.assign({}, ...sentence.props.style.filter(Boolean));
  assert.equal(styles.flex, 1); assert.equal(styles.minWidth, 0); assert.equal(styles.fontWeight, '400');
  assert.equal(sentence.props.allowFontScaling, undefined);
});

test('timeline and fallback rows share contiguous list parents, preserve order and leave pagination outside', () => {
  const render = production('GroupScreen');
  const bill = { id: 'bill', description: 'Lunch', date: '2026-10-18' };
  const first = { id: 'first', sender: 'self', recipient: 'other', amount: '334' };
  const second = { ...first, id: 'second', reversed: true };
  const value = { ...group, expenses: [bill], settlements: [first, second], transfers: [], transactions: [{ kind: 'bill', bill }, { kind: 'payment', payment: first }, { kind: 'payment', payment: second }] };
  const props = { group: value, accepted: value, selfId: 'self', pending: [], busy: true, onPayment() {}, onExpense() {} };
  const children = (node: Element) => node.children.flat(Infinity).filter((child): child is Element => !!child && typeof child === 'object' && 'type' in child);
  const rowParent = (tree: Element) => elements(tree).find(node => node.type === 'View' && children(node).some(child => ['PaymentRow', 'BillTimelineRow'].includes(String(child.type))));
  const tree = render(props), list = rowParent(tree)!;
  assert.ok(list); assert.equal(list.props.style, undefined);
  assert.deepEqual(children(list).map(node => node.props.expense?.id ?? node.props.payment.id), ['bill', 'first', 'second']);
  assert.ok(children(list).every(node => node.props.busy === true));
  assert.ok(children(list).filter(node => node.type === 'PaymentRow').every(node => node.props.accepted === value && node.props.onPayment === props.onPayment));
  assert.ok(!elements(list).some(node => node.type === 'HistoryPages'));
  const fallback = { ...value, transactions: undefined };
  const history = render({ ...props, group: fallback, accepted: fallback });
  const disclosure = elements(history).find(node => node.type === 'Disclosure' && node.props.title === 'Payment records')!;
  const payments = rowParent(disclosure)!;
  assert.deepEqual(children(payments).map(node => node.props.payment.id), ['first', 'second']);
  assert.equal(payments.props.style, undefined);
  assert.ok(children(disclosure).some(node => node.type === 'HistoryPages'));
  const empty = render({ ...props, group: { ...fallback, expenses: [], settlements: [], history: { settlements: { next_cursor: 'older' } } } });
  assert.equal(rowParent(empty), undefined);
  const olderPayments = elements(empty).find(node => node.type === 'Disclosure' && node.props.title === 'Payment records')!;
  assert.deepEqual(children(olderPayments).map(node => node.type), ['HistoryPages']);
});

test('saved bill details expose one guarded reversal action and retain reversed originals', () => {
  const render = production('ExpenseDetail'), reversed: string[] = [];
  const expense = { id: 'bill', version: 1, description: 'Lunch', total: '1001', paid: { self: '1001' }, shares: { self: '501', other: '500' }, split: { mode: 'equal', values: { self: '1', other: '1' } }, date: '2026-10-18', deleted: false };
  const base = { expense, group: { ...group, expenses: [expense] }, selfId: 'self', busy: false, canEdit: true, onEdit() {}, onReverse: () => reversed.push(expense.id) };
  const buttons = (tree: Element) => elements(tree).filter(node => node.type === 'Button');
  const tree = render(base), actions = buttons(tree);
  assert.deepEqual(actions.map(node => node.props.title), ['Edit bill', 'Reverse record']);
  actions.find(node => node.props.title === 'Reverse record')!.props.onPress();
  assert.deepEqual(reversed, ['bill']);
  for (const guard of [{ busy: true }, { canEdit: false }]) {
    assert.ok(buttons(render({ ...base, ...guard })).every(node => node.props.disabled));
  }
  const retained = render({ ...base, expense: { ...expense, deleted: true } });
  assert.equal(buttons(retained).length, 0);
  assert.ok(text(retained).includes('The original and its reversal are kept in history.'));
  assert.equal(elements(retained).find(node => node.type === 'RecordSummary')!.props.amount, '1001');
  assert.ok(elements(retained).some(node => node.type === 'ParticipantAmountRow' && node.props.amount === '1001'));
});
