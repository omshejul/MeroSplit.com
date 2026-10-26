import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { categoryIcon, categoryMeaning, expenseCategory } from '../src/categoryIcons.ts';
import { expenseBalanceChange, formatMoney } from '../src/accounting.ts';
import { paymentPresentation } from '../src/activityPresentation.ts';
import { personalSettlements, personalTransfers } from '../src/personalBalances.ts';
import { previewPending } from '../src/ledger.ts';
import type { Command, Group } from '../src/types.ts';

type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }) };
const Animated = { View: 'Animated.View', Value: class { value: number; constructor(value: number) { this.value = value; } stopAnimation() {} setValue(value: number) { this.value = value; } }, timing: () => ({ start() {} }) };
const source = ts.createSourceFile('GroupScreen.tsx', readFileSync(new URL('../src/GroupScreen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function production(name: string, overrides: Record<string, any> = {}) {
  const helpers = source.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ['billImpact', 'participantName', 'displayDate', 's'].includes(d.name.getText(source)))).map(node => node.getText(source)).join('\n');
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name); assert.ok(node);
  const code = ts.transpile(`${helpers}\n${node.getText(source).replace(/^export (?:default )?/, '')}\nreturn ${name};`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  return new Function('env', `with(env) { ${code} }`)({ React, Animated, Platform: { OS: 'web' }, useLayoutEffect: () => {}, useEffect: () => {}, categoryIcon, categoryMeaning, expenseCategory, TransactionIcon: 'TransactionIcon', PagingFooter: 'PagingFooter', LegacyPayments: 'LegacyPayments', FlatList: 'FlatList', ScrollView: 'ScrollView', pageContentStyle: {}, LoadingSpinner: 'LoadingSpinner', useScrollPagination: () => ({ events: {}, loading: false, failed: false }), expenseBalanceChange, formatMoney, paymentPresentation, personalSettlements, personalTransfers, BalanceExplanation: 'BalanceExplanation', balanceKey: () => '', useRef: () => ({ current: null }), useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}], Avatar: 'Avatar', AmountText: 'AmountText', Text: 'Text', SectionHeading: 'SectionHeading', View: 'View', Pressable: 'Pressable', Icon: 'Icon', Button: 'Button', RecordSummary: 'RecordSummary', ParticipantAmountRow: 'ParticipantAmountRow', LogRow: 'LogRow', LogDate: 'LogDate', BillEffect: 'BillEffect', VisibleExpense: 'VisibleExpense', HistoryPages: 'HistoryPages', BillSearch: 'BillSearch', PaymentRow: 'PaymentRow', BillTimelineRow: 'BillTimelineRow', Disclosure: 'Disclosure', BillPeople: 'BillPeople', RecordAttribution: 'RecordAttribution', PersonalTransferRow: 'PersonalTransferRow', PendingChangeRow: 'PendingChangeRow', StyleSheet: { create: (styles: unknown) => styles }, radii: { surface: 16 }, balanceColor: (amount: string) => BigInt(amount) < 0n ? 'negative' : 'positive', useUI: () => ({ motion: { enabled: false }, ui: { numeric: { fontSize: 32, fontWeight: '600' }, caption: { fontSize: 14 }, row: { minHeight: 52, paddingVertical: 6 } }, palette: { muted: 'muted', line: '#334455', surface: 'surface', text: 'text' } }), ...overrides });
}
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('children' in tree)) return [];
  const node = tree as Element; return [node, ...node.children.flatMap(elements), ...elements(node.props.ListHeaderComponent), ...elements(node.props.ListFooterComponent), ...(node.props.data && node.props.renderItem ? node.props.data.flatMap((item: any, index: number) => elements(node.props.renderItem({ item, index }))) : [])];
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object' && 'children' in tree) { const node = tree as Element; return text(node.children) + text(node.props.ListHeaderComponent) + text(node.props.ListFooterComponent); }
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
}
const group = { id: 'g', participants: [{ id: 'self', name: 'Actual self name' }, { id: 'other', name: 'Noor' }] };

const billRow = (overrides: Record<string, unknown> = {}) => ({ id: 'bill', version: 1, description: 'Lunch', total: '1001', paid: { self: '401', other: '600' }, shares: { self: '667', other: '334' }, date: '2026-10-18', deleted: false, ...overrides });
const effectOf = (tree: unknown) => elements(tree).find(node => node.type === 'LogRow')!.props.trailing as Element;

test('compact bill row: title, who paid the gross total, and only your balance effect on the right', () => {
  const bill = billRow(), opened: unknown[] = [], render = production('BillTimelineRow');
  const tree = render({ expense: bill, group, selfId: 'self', busy: false, onExpense: (value: unknown) => opened.push(value) });
  assert.equal(tree.type, 'VisibleExpense'); assert.equal(tree.props.expense, bill); assert.equal(tree.props.groupId, 'g');
  const row = elements(tree).find(node => node.type === 'LogRow')!;
  assert.equal(row.props.date, '2026-10-18'); assert.equal(row.props.busy, false);
  const lines = row.children.flat().filter(Boolean) as Element[];
  assert.deepEqual(lines.map(text), ['Lunch', `You and Noor paid ${formatMoney('1001')}`], 'two visible lines; share and per-payer amounts live in details and the label');
  assert.equal(lines[0].props.numberOfLines, 2);
  assert.deepEqual(effectOf(tree).props, { change: '-266', involved: true, reversed: false });
  for (const fact of [`total ${formatMoney('1001')}`, `Balance −${formatMoney('266')}`, `You paid ${formatMoney('401')}, Noor paid ${formatMoney('600')}`, `Your share ${formatMoney('667')}`, '18 Oct 2026']) assert.ok(row.props.label.includes(fact), fact);
  row.props.onPress(); assert.equal(opened[0], bill);
  assert.equal(elements(render({ expense: bill, group, selfId: 'self', busy: true })).find(node => node.type === 'LogRow')!.props.busy, true);
});

test('bill effect stays truthful for lent, borrowed, zero, uninvolved, payer-only and reversed bills', () => {
  const render = production('BillTimelineRow');
  const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
    [{ paid: { self: '1001' }, shares: { self: '501', other: '500' } }, { change: '500', involved: true, reversed: false }, 'You paid'],
    [{ paid: { other: '1001' }, shares: { self: '501', other: '500' } }, { change: '-501', involved: true, reversed: false }, 'Noor paid'],
    [{ paid: { self: '500', other: '501' }, shares: { self: '500', other: '501' } }, { change: '0', involved: true, reversed: false }, 'You and Noor paid'],
    [{ paid: { other: '1001' }, shares: { other: '1001' } }, { change: '0', involved: false, reversed: false }, 'Noor paid'],
    [{ paid: { self: '1001' }, shares: { other: '1001' } }, { change: '1001', involved: true, reversed: false }, 'You paid'],
    [{ deleted: true }, { change: '0', involved: true, reversed: true }, 'You and Noor paid'],
  ];
  for (const [overrides, effect, sub] of cases) {
    const tree = render({ expense: billRow(overrides), group, selfId: 'self', busy: false });
    assert.deepEqual(effectOf(tree).props, effect); assert.ok(text(tree).includes(`${sub} ${formatMoney('1001')}`));
  }
  const reversed = elements(render({ expense: billRow({ deleted: true }), group, selfId: 'self', busy: false })).find(node => node.type === 'LogRow')!;
  assert.ok(reversed.props.label.includes('reversed, no balance impact'));
  const three = render({ expense: billRow({ paid: { self: '1', other: '1', third: '999' } }), group: { ...group, participants: [...group.participants, { id: 'third', name: 'Kai' }] }, selfId: 'self', busy: false });
  assert.ok(text(three).includes(`3 people paid ${formatMoney('1001')}`));
  const big = '1234567890123456789012345678901234567890';
  const large = elements(render({ expense: billRow({ total: big, paid: { other: big }, shares: { self: big } }), group, selfId: 'self', busy: false })).find(node => node.type === 'LogRow')!;
  assert.ok(large.props.label.includes(formatMoney(big))); assert.equal(large.props.trailing.props.change, `-${big}`);
});

test('BillEffect labels direction in words and shows the exact unsigned amount in balance color', () => {
  const render = production('BillEffect');
  const view = (props: Record<string, unknown>) => { const tree = render(props); return { label: text(tree.children[0]), amount: (tree.children.flat().find((node: any) => node?.type === 'AmountText') as Element | undefined)?.props.amount }; };
  assert.deepEqual(view({ change: '266', involved: true, reversed: false }), { label: 'You lent', amount: '266' });
  assert.deepEqual(view({ change: '-266', involved: true, reversed: false }), { label: 'You borrowed', amount: '266' });
  assert.deepEqual(view({ change: '0', involved: true, reversed: false }), { label: 'No balance change', amount: undefined });
  assert.deepEqual(view({ change: '0', involved: false, reversed: false }), { label: 'Not involved', amount: undefined });
  assert.deepEqual(view({ change: '0', involved: true, reversed: true }), { label: 'Reversed', amount: undefined });
  assert.equal(render({ change: '1', involved: true, reversed: false }).props.style.maxWidth, '45%');
});

test('log row keeps a 44px+ button target with a date column and the full spoken label', () => {
  const tree = production('LogRow')({ date: '2026-10-18', label: 'Bill, Lunch', busy: false, onPress() {}, trailing: 'Effect', children: 'Body' });
  assert.equal(tree.type, 'Pressable'); assert.equal(tree.props.accessibilityRole, 'button'); assert.equal(tree.props.accessibilityLabel, 'Bill, Lunch');
  const styles = Object.assign({}, ...tree.props.style({ pressed: false }).filter(Boolean));
  assert.ok(styles.minHeight >= 44);
  assert.deepEqual(tree.children.flat().filter((node: any) => node != null).map((node: any) => node?.type ?? node), ['LogDate', 'View', 'Effect']);
  const date = production('LogDate');
  const current = date({ date: `${new Date().getFullYear()}-10-18` });
  assert.equal(current.props['aria-hidden'], true); assert.equal(current.props.importantForAccessibility, 'no-hide-descendants');
  assert.deepEqual(elements(current).filter(node => node.type === 'Text').map(text), ['Oct', '18']);
  assert.deepEqual(elements(date({ date: '2019-03-05' })).filter(node => node.type === 'Text').map(text), ['Mar', '5', '2019'], 'other years show the year');
  assert.deepEqual(elements(date({ date: null })).filter(node => node.type === 'Text').map(text), ['–']);
});

test('accepted payment is a compact, wrapping sentence with an unboxed icon and the same details action', () => {
  const render = production('PaymentRow');
  const payment = { id: 'record', sender: 'self', recipient: 'other', amount: '334', method: 'manual_record', date: null };
  const opened: unknown[] = [];
  const base = { group, selfId: 'self', busy: false, onPayment: (value: unknown) => opened.push(value), payment };
  assert.equal(render({ ...base, accepted: { settlements: [] } }), null);
  const tree = render({ ...base, accepted: { settlements: [payment] } });
  assert.equal(tree.type, 'LogRow'); assert.equal(tree.props.date, null); assert.equal(tree.props.trailing, undefined);
  assert.equal(tree.props.label, `Payment, You paid Noor, ${formatMoney('334')}, Date unavailable`);
  const nodes = elements(tree), sentence = nodes.find(node => node.type === 'Text')!;
  assert.equal(text(sentence), `You paid Noor ${formatMoney('334')}`);
  assert.equal(tree.props.leading.type, 'TransactionIcon'); assert.equal(tree.props.leading.props.name, 'payment');
  assert.ok(!nodes.some(node => ['IconBadge', 'AmountText'].includes(String(node.type))));
  assert.ok(nodes.filter(node => node.type === 'Text').every(node => !node.props.numberOfLines && !node.props.ellipsizeMode));
  tree.props.onPress(); assert.equal(opened[0], payment);
  assert.equal(render({ ...base, busy: true, accepted: { settlements: [payment] } }).props.busy, true);
});

test('compact payments retain exact confirmation and reversal truth in text and their accessible label', () => {
  const render = production('PaymentRow');
  for (const [method, reversed, status] of [
    ['manual_record', false, ''],
    ['recipient_confirmed', false, 'Recipient confirmed'],
    ['manual_then_confirmed', false, 'Recipient confirmed'],
    ['recipient_confirmed', true, 'Record reversed'],
  ] as const) {
    const payment = { id: 'record', sender: 'other', recipient: 'self', amount: '334', method, reversed, date: '2026-10-18' };
    const tree = render({ group, selfId: 'self', busy: false, payment, accepted: { settlements: [], transactions: [{ kind: 'payment', payment }] } });
    assert.ok(text(tree).includes(`Noor paid you ${formatMoney('334')}`));
    if (status) { assert.ok(text(tree).includes(status)); assert.ok(tree.props.label.includes(status)); }
    assert.ok(!`${text(tree)} ${tree.props.label}`.includes('Receipt unconfirmed'));
    assert.ok(tree.props.label.includes('18 Oct 2026')); assert.equal(tree.props.date, '2026-10-18');
    assert.equal(tree.props.leading.type, 'TransactionIcon'); assert.equal(tree.props.leading.props.name, reversed ? 'refresh' : 'payment');
    assert.ok(!elements(tree).some(node => node.type === 'RecordAttribution'));
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
  assert.ok(tree.props.label.includes(formatMoney(amount)));
  const styles = Object.assign({}, ...sentence.props.style.filter(Boolean));
  assert.equal(styles.flex, 1); assert.equal(styles.minWidth, 0); assert.equal(styles.fontWeight, '400');
  assert.equal(sentence.props.allowFontScaling, undefined);
});

test('virtualized timeline and legacy bill/payment lists preserve server order', () => {
  const render = production('GroupScreen');
  const bill = { id: 'bill', description: 'Lunch', date: '2026-10-18' };
  const first = { id: 'first', sender: 'self', recipient: 'other', amount: '334' };
  const second = { ...first, id: 'second', reversed: true };
  const value = { ...group, expenses: [bill], settlements: [first, second], transfers: [], transactions: [{ kind: 'bill', bill }, { kind: 'payment', payment: first }, { kind: 'payment', payment: second }] };
  const props = { group: value, accepted: value, selfId: 'self', pending: [], busy: true, onPayment() {}, onExpense() {} };
  const list = elements(render(props)).find(node => node.type === 'FlatList')!;
  assert.deepEqual(list.props.data.map((row: any) => row.bill?.id ?? row.payment.id), ['bill', 'first', 'second']);
  const rows = list.props.data.map((item: any) => list.props.renderItem({ item }));
  assert.ok(rows.every((row: any) => row.props.busy));
  assert.ok(rows.filter((row: any) => row.type === 'PaymentRow').every((row: any) => row.props.accepted === value && row.props.onPayment === props.onPayment));
  const fallback = { ...value, transactions: undefined };
  const history = render({ ...props, group: fallback, accepted: fallback });
  assert.deepEqual(elements(history).find(node => node.type === 'FlatList')!.props.data.map((row: any) => row.bill.id), ['bill']);
  const payments = elements(history).find(node => node.type === 'LegacyPayments')!;
  assert.equal(payments.props.group, fallback);
  assert.ok(elements(history).some(node => node.type === 'Disclosure' && node.props.title === 'Payment records'));
  assert.ok(!elements(history).some(node => node.type === 'HistoryPages'));
});

test('actual GroupScreen transaction rows expose offline new/edit bills and their detail callback', () => {
  const bill = { ...billRow({ id: 'accepted', total: '1000', paid: { self: '1000' }, shares: { self: '500', other: '500' } }), category: 'other', notes: '', split: { mode: 'equal' as const, values: { self: '1', other: '1' } } };
  const accepted: Group = { ...group, name: 'Trip', version: 1, read_mode: 'summary', expenses: [bill], settlements: [], balances: { self: '500', other: '-500' }, transfers: [{ sender: 'other', recipient: 'self', amount: '500' }], activity: [], transactions: [{ kind: 'bill', date: bill.date, bill }], history: { transactions: { next_cursor: 'older' } } };
  const pending: Command[] = [
    { command_id: 'edit', group_id: 'g', base_version: 1, state: 'pending', error: null, method: 'PUT', path: '/groups/g/expenses/accepted', body: { ...bill, description: 'Saved accepted edit' } },
    { command_id: 'photo', group_id: 'g', base_version: 1, state: 'pending', error: null, method: 'POST', path: '/groups/g/expenses', body: { ...bill, id: 'photo', date: '2026-10-27', description: 'Saved photo bill' } },
  ];
  const projected = previewPending(accepted, pending), opened: string[] = [];
  const tree = production('GroupScreen')({ group: projected, accepted, pending, selfId: 'self', busy: false, online: false, onExpense: (bill: any) => opened.push(bill.id) });
  const list = elements(tree).find(node => node.type === 'FlatList')!;
  assert.deepEqual(list.props.data.map((row: any) => row.bill.id), ['photo', 'accepted']);
  assert.equal(list.props.data[1].bill.description, 'Saved accepted edit');
  assert.deepEqual(list.props.data.map(list.props.keyExtractor), ['bill:photo', 'bill:accepted']);
  const row = list.props.renderItem({ item: list.props.data[0] });
  assert.equal(row.props.group, projected);
  const rendered = production('BillTimelineRow')(row.props);
  elements(rendered).find(node => node.type === 'LogRow')!.props.onPress();
  assert.deepEqual(opened, ['photo'], 'the newly saved bill reaches the existing detail callback offline');
  assert.equal(elements(tree).find(node => node.type === 'PersonalTransferRow')!.props.disabled, true);
  assert.deepEqual(projected.history, accepted.history);
});

test('own saved payload changes adopt the same queued ID while conflict and acknowledgement keep the reading snapshot', () => {
  const slots: any[] = [];
  let cursor = 0, dirty = false, effects: (() => void)[] = [];
  const effect = (callback: () => void, deps: unknown[]) => { const index = cursor++, previous = slots[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { slots[index] = deps; effects.push(callback); } };
  const render = production('GroupScreen', {
    useState: (initial: any) => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value: any) => { slots[index] = value; dirty = true; }]; },
    useRef: (initial: any) => { const index = cursor++; return slots[index] ??= { current: initial }; }, useLayoutEffect: effect, useEffect: effect,
  });
  const accepted = { ...group, version: 1, expenses: [], settlements: [], balances: { self: '0' }, transfers: [], transactions: [] };
  const firstBill = billRow({ id: 'pending', description: 'Saved first' }), secondBill = { ...firstBill, description: 'Saved edited' };
  const first = { ...accepted, expenses: [firstBill], transactions: [{ kind: 'bill', date: firstBill.date, bill: firstBill }] };
  const second = { ...first, expenses: [secondBill], transactions: [{ kind: 'bill', date: secondBill.date, bill: secondBill }] };
  const command = { command_id: 'same-command', state: 'pending', body: { id: 'pending', description: 'Saved first' } };
  const props = { group: first, accepted, pending: [command], selfId: 'self', busy: false, revision: 0 };
  const view = (next: any) => { let tree: Element; do { dirty = false; cursor = 0; effects = []; tree = render(next); effects.forEach(fn => fn()); } while (dirty); return elements(tree!).find(node => node.type === 'FlatList')!; };
  view(props);
  const edited = { ...command, body: { ...command.body, description: 'Saved edited' } };
  assert.equal(view({ ...props, group: second, pending: [edited] }).props.data[0].bill.description, 'Saved edited');
  assert.equal(view({ ...props, group: accepted, pending: [{ ...edited, state: 'conflict' }] }).props.data[0].bill.description, 'Saved edited');
  const acknowledged = { ...accepted, version: 2 };
  assert.equal(view({ ...props, group: acknowledged, accepted: acknowledged, pending: [] }).props.data[0].bill.description, 'Saved edited');
  assert.deepEqual(view({ ...props, group: acknowledged, accepted: acknowledged, pending: [], revision: 1 }).props.data, []);
});

test('held optimistic total keeps its pending label until Show updates adopts accepted records', () => {
  const slots: any[] = [];
  let cursor = 0, dirty = false, effects: (() => void)[] = [], available = false;
  const effect = (callback: () => void, deps: unknown[]) => {
    const index = cursor++, previous = slots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { slots[index] = deps; effects.push(callback); }
  };
  const render = production('GroupScreen', {
    useState: (initial: any) => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value: any) => { slots[index] = value; dirty = true; }]; },
    useRef: (initial: any) => { const index = cursor++; return slots[index] ??= { current: initial }; },
    useLayoutEffect: effect, useEffect: effect,
  });
  const bill = { ...billRow(), category: 'other', notes: '', total: '800', paid: { self: '800' }, shares: { self: '400', other: '400' }, split: { mode: 'equal' as const, values: { self: '1', other: '1' } } };
  const accepted: Group = { ...group, name: 'Trip', activity: [], read_mode: 'summary', version: 1, balances: { self: '400', other: '-400' }, expenses: [bill], settlements: [], transfers: [{ sender: 'other', recipient: 'self', amount: '400' }] };
  const pending: Command[] = [
    { command_id: 'edit', group_id: 'g', method: 'PUT', path: '/groups/g/expenses/bill', base_version: 1, state: 'pending', error: null, body: { ...bill, command_id: 'edit' } },
    { command_id: 'later', group_id: 'g', method: 'POST', path: '/groups/g/expenses', base_version: 1, state: 'pending', error: null, body: { ...bill, id: 'later', total: '300', paid: { self: '300' }, command_id: 'later' } },
  ];
  const optimistic = previewPending(accepted, pending);
  const props = { group: optimistic, accepted, pending, selfId: 'self', busy: false, revision: 0, previewError: '', onUpdatesAvailable: (value: boolean) => { available = value; } };
  const view = (next: any) => { let tree: Element; do { dirty = false; cursor = 0; effects = []; tree = render(next); effects.forEach(fn => fn()); } while (dirty); return tree!; };
  view(props);
  const latest = { ...accepted, version: 2 };
  let previewError = '';
  try { previewPending(latest, pending); } catch (error) { previewError = (error as Error).message; }
  assert.match(previewError, /Balances show accepted records/);
  view({ ...props, group: accepted, previewError });
  assert.equal(available, true, 'a changed preview status exposes Show updates even at the same accepted version');
  const conflictProps = { ...props, group: latest, accepted: latest, pending: [{ ...pending[0], state: 'conflict' }, pending[1]], previewError };
  const held = view(conflictProps), row = elements(held).find(node => node.type === 'PersonalTransferRow')!;
  assert.equal(row.props.transfer.amount, '550', 'background conflict preserves reading position and total');
  assert.equal(row.props.disabled, true, 'live pending work keeps payments disabled');
  assert.match(text(held), /Balances show a pending preview/);
  assert.doesNotMatch(text(held), /Balances show accepted records/);
  assert.equal(available, true);
  const refreshed = view({ ...conflictProps, revision: 1 });
  assert.equal(elements(refreshed).find(node => node.type === 'PersonalTransferRow')!.props.transfer.amount, '400');
  assert.ok(text(refreshed).includes(previewError));
  assert.doesNotMatch(text(refreshed), /Balances show a pending preview/);
  assert.equal(elements(refreshed).find(node => node.type === 'PersonalTransferRow')!.props.disabled, true);
});

test('background summaries preserve displayed bills and accepted payments until an explicit read or own saved change', async () => {
  const slots: any[] = [], updates: boolean[] = [], reads: any[][] = [], offsets: unknown[] = [];
  let cursor = 0, dirty = false, layout: (() => void)[] = [], effects: (() => void)[] = [], paging: any;
  const effect = (queue: (() => void)[], callback: () => void, deps: unknown[]) => {
    const index = cursor++, previous = slots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { slots[index] = deps; queue.push(callback); }
  };
  const render = production('GroupScreen', {
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: any) => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(slots[index], next)) { slots[index] = next; dirty = true; } }];
    },
    useRef: (initial: any) => { const index = cursor++; return slots[index] ??= { current: initial }; },
    useLayoutEffect: (callback: () => void, deps: unknown[]) => effect(layout, callback, deps),
    useEffect: (callback: () => void, deps: unknown[]) => effect(effects, callback, deps),
    useScrollPagination: (options: any) => { paging = options; return { events: {}, loading: false, failed: false }; },
  });
  const bill = billRow(), payment = { id: 'older-payment', sender: 'self', recipient: 'other', amount: '10' };
  const original = { ...group, version: 1, read_mode: 'summary', expenses: [bill], settlements: [payment], transfers: [], transactions: [{ kind: 'bill', bill }, { kind: 'payment', payment }], history: { transactions: { next_cursor: 'older' } } };
  const initial = { ...original }, props = { group: initial, accepted: original, selfId: 'self', pending: [], busy: false, revision: 0, onUpdatesAvailable: (value: boolean) => updates.push(value), onHistoryPage: async (...args: any[]) => { reads.push(args); return true; } };
  const view = (next: any) => {
    let tree: Element;
    do { dirty = false; cursor = 0; layout = []; effects = []; tree = render(next); layout.forEach(fn => fn()); effects.forEach(fn => fn()); } while (dirty);
    return elements(tree!).find(node => node.type === 'FlatList')!;
  };
  const first = view(props);
  first.props.ref.current = { scrollToOffset: (value: unknown) => offsets.push(value) };
  const latestBill = billRow({ id: 'newest' }), latest = { ...original, version: 2, expenses: [latestBill], settlements: [], transactions: [{ kind: 'bill', bill: latestBill }], history: { transactions: { next_cursor: 'newer-window' } } };
  const background = view({ ...props, group: latest, accepted: latest });
  assert.equal(background.props.data, original.transactions, 'background head replacement preserves every displayed row');
  const oldPayment = background.props.renderItem({ item: original.transactions[1] });
  assert.equal(oldPayment.props.accepted, original, 'accepted payment membership advances with the displayed snapshot');
  assert.equal(updates.at(-1), true); assert.deepEqual(offsets, []);
  await paging.load(undefined);
  assert.equal(reads[0][4], original, 'paging uses the accepted displayed version rather than an optimistic preview or newer background summary');
  const refreshed = view({ ...props, group: latest, accepted: latest, revision: 1 });
  assert.equal(refreshed.props.data, latest.transactions); assert.equal(updates.at(-1), false);
  assert.deepEqual(offsets, [{ offset: 0, animated: false }]);
  const own = { ...latest, transactions: [...latest.transactions, { kind: 'bill', bill }] };
  const saved = view({ ...props, group: own, accepted: latest, revision: 1, pending: [{ command_id: '00000000-0000-4000-8000-000000000001', state: 'pending' }] });
  assert.equal(saved.props.data, own.transactions, 'own saved changes appear without waiting for another refresh');
  const acknowledged = { ...latest, version: 3 };
  const afterSync = view({ ...props, group: acknowledged, accepted: acknowledged, revision: 1 });
  assert.equal(afterSync.props.data, own.transactions, 'background acknowledgment keeps the displayed rows');
  assert.deepEqual(offsets, [{ offset: 0, animated: false }], 'acknowledgment does not move the reader');
  assert.equal(updates.at(-1), true);
  const adopted = view({ ...props, group: acknowledged, accepted: acknowledged, revision: 2 });
  assert.equal(adopted.props.data, acknowledged.transactions);
  assert.equal(updates.at(-1), false);
});

test('search opens from the heading line, stays open for an active query, and partial pages still offer it', () => {
  const render = production('GroupScreen');
  const bills = Array.from({ length: 5 }, (_, index) => ({ id: `b${index}`, description: `Bill ${index}`, total: '100', paid: { self: '100' }, shares: { self: '100' }, date: '2026-10-18' }));
  const base = { ...group, expenses: bills, settlements: [], transfers: [], read_mode: 'summary', transactions: bills.map(bill => ({ kind: 'bill', date: bill.date, bill })) };
  const notice = { notices: [] };
  const view = (value: Record<string, any>, accepted: Record<string, any> = value) => elements(render({ group: value, accepted, selfId: 'self', pending: [], busy: false, noticeVisibility: notice }));
  const closed = view(base);
  assert.ok(closed.some(node => node.type === 'Button' && node.props.title === 'Search' && node.props.accessibilityLabel === 'Search bills'));
  assert.ok(!closed.some(node => node.type === 'BillSearch'));
  assert.ok(closed.filter(node => node.type === 'BillTimelineRow').every(node => node.props.noticeVisibility?.notices === notice.notices), 'notice hooks stay on the displayed accepted bills');
  assert.ok(view(base, { ...base }).filter(node => node.type === 'BillTimelineRow').every(node => node.props.noticeVisibility === undefined), 'previews never mark bills seen');
  const queried = view({ ...base, history: { transactions: { query: 'rent', next_cursor: null } } });
  const field = queried.find(node => node.type === 'BillSearch')!;
  assert.equal(field.props.value, 'rent'); assert.equal(field.props.showSubmit, true); assert.equal(field.props.autoFocus, false);
  assert.ok(!queried.some(node => node.type === 'Button' && node.props.title === 'Search'));
  const partial = view({ ...base, expenses: bills.slice(0, 1), transactions: base.transactions.slice(0, 1), history: { transactions: { next_cursor: 'older' } } });
  assert.ok(partial.some(node => node.type === 'Button' && node.props.title === 'Search'));
  assert.ok(partial.some(node => node.type === 'PagingFooter'));
  assert.ok(!partial.some(node => node.type === 'HistoryPages'));
  const few = view({ ...base, expenses: bills.slice(0, 2), transactions: base.transactions.slice(0, 2) });
  assert.ok(!few.some(node => node.type === 'BillSearch' || node.type === 'Button' && node.props.title === 'Search'));
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


test('settled presentation celebrates only a known accepted zero without pending work', () => {
  const render = production('GroupScreen');
  const value = { ...group, balances: { self: '0', other: '0' }, expenses: [], settlements: [], transfers: [], activity: [] };
  const base = { group: value, accepted: value, selfId: 'self', pending: [], busy: false };
  const heading = elements(render(base)).find(node => node.type === 'Text' && text(node) === '🎉 All settled')!;
  assert.equal(heading.props.style.fontSize, 32); assert.equal(heading.props.numberOfLines, undefined);
  for (const props of [
    { pending: [{ state: 'pending' }] },
    { accepted: { ...value, balances: {} } },
    { accepted: { ...value, balances: { self: '100' } } },
    { pending: [{ state: 'pending' }], accepted: { ...value, balances: { self: '100' } } },
  ]) {
    const tree = render({ ...base, ...props });
    assert.ok(!text(tree).includes('🎉')); assert.ok(text(tree).includes('All settled'));
  }
  assert.ok(!text(render({ ...base, group: { ...value, transfers: [{ sender: 'self', recipient: 'other', amount: '100' }] } })).includes('All settled'));
});


test('detail attribution is short, truthful about missing actors and absent from compact rows', () => {
  const render = production('RecordAttribution');
  assert.equal(text(render({ action: 'Added', name: 'Recorder' })), 'Added by Recorder');
  assert.equal(text(render({ action: 'Reversed', name: null })), 'Reversed by unknown');
  const payment = { id: 'p', sender: 'self', recipient: 'other', amount: '100', reversed: true, recorded_by_name: 'Actual recorder', reversal: { actor_name: 'Actual reverser' } };
  const tree = production('PaymentDetail')({ payment, group, selfId: 'self', busy: false, canReverse: true });
  assert.deepEqual(elements(tree).filter(node => node.type === 'RecordAttribution').map(node => [node.props.action, node.props.name]), [['Marked paid', 'Actual recorder'], ['Reversed', 'Actual reverser']]);
  const bill = { id: 'b', description: 'Lunch', total: '100', paid: { self: '100' }, shares: { self: '100' }, split: { mode: 'equal', values: { self: '1' } }, deleted: true, added_by: 'Actual creator', reversal: { actor_name: 'Another reverser' } };
  const detail = production('ExpenseDetail')({ expense: bill, group: { ...group, expenses: [bill] }, selfId: 'self', busy: false, canEdit: true });
  assert.deepEqual(elements(detail).filter(node => node.type === 'RecordAttribution').map(node => [node.props.action, node.props.name]), [['Added', 'Actual creator'], ['Reversed', 'Another reverser']]);
});

test('manual payment details omit an unconfirmed label and dangling separator', () => {
  const payment = { id: 'record', sender: 'self', recipient: 'other', amount: '334', method: 'manual_record', date: null };
  const tree = production('PaymentDetail')({ payment, group: { ...group, name: 'Trip' }, selfId: 'self', busy: false, canReverse: true });
  const caption = elements(tree).find(node => node.type === 'Text')!;
  assert.equal(text(caption), 'Trip · Date unavailable');
});


test('balance explanation target and Record remain independent siblings with unchanged payment guards', () => {
  const render = production('PersonalTransferRow'), transfer = { sender: 'other', recipient: 'self', amount: '501' };
  let explanations = 0, records = 0;
  const props = { transfer, group, selfId: 'self', disabled: false, onSettle: (row: unknown) => { assert.equal(row, transfer); records++; }, onExplain: (row: unknown, focus: unknown) => { assert.equal(row, transfer); assert.equal(typeof focus, 'function'); explanations++; } };
  const tree = render(props), direct = tree.children.filter(Boolean) as Element[];
  assert.deepEqual(direct.map(node => node.type), ['Pressable', 'Button']);
  direct[0].props.onPress(); assert.equal(explanations, 1); assert.equal(records, 0);
  direct[1].props.onPress(); assert.equal(explanations, 1); assert.equal(records, 1);
  assert.equal(direct[1].props.title, 'Record'); assert.equal(direct[1].props.disabled, false);
  assert.equal((render({ ...props, disabled: true }).children[1] as Element).props.disabled, true);
  const removed = { ...group, participants: group.participants.map(person => ({ ...person, removed: person.id === 'other' })) };
  assert.equal((render({ ...props, group: removed }).children[1] as Element).props.disabled, true);
});


test('local full-history search remains editable and clearable after filtering below five rows or to zero', () => {
  let cursor = 0; const states: any[] = [];
  const render = production('GroupScreen', { useState: (initial: any) => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], (value: any) => { states[index] = value; }]; } });
  const bills = Array.from({ length: 6 }, (_, index) => ({ ...billRow(), id: `bill${index}`, description: `Bill ${index}`, notes: '' }));
  const value = { ...group, expenses: bills, settlements: [], transfers: [], balances: { self: '0', other: '0' } };
  const view = () => { cursor = 0; return elements(render({ group: value, accepted: value, selfId: 'self', pending: [], busy: false })); };
  view().find(node => node.type === 'Button' && node.props.accessibilityLabel === 'Search bills')!.props.onPress();
  for (const [query, count] of [['Bill 1', 1], ['no matching bill', 0], ['', 6]] as const) {
    view().find(node => node.type === 'BillSearch')!.props.onChange(query);
    const tree = view(), field = tree.find(node => node.type === 'BillSearch');
    assert.ok(field, `the active local search remains available for ${count} results`);
    assert.equal(field.props.value, query); assert.equal(field.props.showSubmit, false);
    assert.equal(tree.filter(node => node.type === 'BillTimelineRow').length, count);
  }
});

test('group and direct-person Pay use the same outlined icon button without changing guards', () => {
  const render = production('PersonalTransferRow'), transfer = { sender: 'self', recipient: 'other', amount: '501' };
  const payable = { ...group, participants: group.participants.map(person => person.id === 'other' ? { ...person, user_id: 2, payment_profile: { vpa: 'other@bank' } } : person) };
  for (const direct of [false, true]) {
    let calls = 0;
    const props = { group: { ...payable, is_direct: direct }, transfer, selfId: 'self', disabled: false, onSettle: (value: unknown) => { assert.equal(value, transfer); calls++; }, onExplain() {} };
    const button = render(props).children[1] as Element;
    assert.equal(button.props.title, 'Pay'); assert.equal(button.props.kind, 'outlined'); assert.equal(button.props.icon, 'pay'); assert.equal(button.props.compact, true);
    button.props.onPress(); assert.equal(calls, 1);
    assert.equal((render({ ...props, disabled: true }).children[1] as Element).props.disabled, true);
  }
});


test('payment attempts never add receipt confirmation cards to the group or person log', () => {
  const render = production('GroupScreen', { ReceiptRequest: 'ReceiptRequest' });
  const value = { ...group, name: 'Om 2', expenses: [], settlements: [], transfers: [], payment_attempts: ['cancelled', 'cancelled', 'reported', 'recorded', 'confirmed', 'prepared'].map((state, index) => ({ id: `attempt-${index}`, sender: 'other', recipient: 'self', amount: '3533', state })) };
  const tree = render({ group: value, accepted: value, selfId: 'self', pending: [], busy: false });
  assert.equal(elements(tree).filter(node => node.type === 'ReceiptRequest').length, 0, 'payment attempts must not become confirmation cards');
  assert.ok(!text(tree).includes('Did you get'));
  assert.ok(!elements(tree).some(node => node.type === 'HistoryPages' && node.props.resource === 'attempts'), 'no empty receipt-request pager');
  assert.equal(value.payment_attempts.length, 6, 'rendering does not mutate payment history');
});


test('category slot announces accepted meaning once, honors manual General and preserves reversal icon', () => {
  const render = production('BillTimelineRow');
  const icons = { [JSON.stringify(['g', 'bill', 'Lunch'])]: 'food' };
  const base = { group, selfId: 'self', busy: false, categoryIcons: icons };
  const row = (expense: any) => elements(render({ ...base, expense })).find(node => node.type === 'LogRow')!;
  let value = row(billRow({ category: 'general', category_auto: true }));
  assert.equal(value.props.leading.props.name, 'food'); assert.equal(value.props.label.match(/Food category/g)?.length, 1);
  value = row(billRow({ category: 'general', category_auto: false }));
  assert.equal(value.props.leading.props.name, 'bill'); assert.ok(!value.props.label.includes('Food category'));
  value = row(billRow({ category: 'water', category_auto: true })); assert.equal(value.props.leading.props.name, 'water');
  value = row(billRow({ category: 'water', deleted: true })); assert.equal(value.props.leading.props.name, 'refresh'); assert.ok(!value.props.label.includes('category'));
  const summary = production('RecordSummary');
  const shown = elements(summary({ title: 'Lunch', amount: '100', category: 'food' })).find(node => node.type === 'SectionHeading')!;
  assert.equal(shown.props.accessibilityLabel, 'Lunch, Food category');
  const named = elements(summary({ title: 'Lunch', amount: '100', category: 'food', categoryText: true })).find(node => node.type === 'SectionHeading')!;
  assert.equal(named.props.accessibilityLabel, 'Lunch');
});


test('pending and offline detail retain the receipt in the same slot as a ready category', () => {
  const detail = production('ExpenseDetail'), summary = production('RecordSummary');
  const expense = billRow({ category: 'general', category_auto: true, split: { mode: 'equal', values: { self: '1' } }, notes: '' });
  const base = { expense, group: { ...group, expenses: [expense] }, selfId: 'self', busy: false, canEdit: false };
  const pending = elements(detail(base)).find(node => node.type === 'RecordSummary')!;
  const ready = elements(detail({ ...base, categoryIcons: { [JSON.stringify(['g', 'bill', 'Lunch'])]: 'food' } })).find(node => node.type === 'RecordSummary')!;
  const manual = elements(detail({ ...base, expense: { ...expense, category_auto: false }, categoryIcons: { [JSON.stringify(['g', 'bill', 'Lunch'])]: 'food' } })).find(node => node.type === 'RecordSummary')!;
  for (const [value, name] of [[pending, 'bill'], [ready, 'food'], [manual, 'bill']] as const) {
    const header = elements(summary({ ...value.props, children: value.children })).find(node => node.type === 'TransactionIcon');
    assert.ok(header, 'every expense detail reserves its decorative icon slot'); assert.equal(header.props.name, name);
  }
});


test('saved local payment is readable with an explicit pending label, never a server confirmation', () => {
 const payment={id:'queued',sender:'other',recipient:'self',amount:'334',date:'2026-10-24',provenance:'pending_manual'};
 const opened:unknown[]=[];
 const tree=production('PaymentRow')({group,selfId:'self',busy:false,payment,accepted:{settlements:[]},onPayment:(value:unknown)=>opened.push(value)});
 assert.equal(tree.type,'LogRow');assert.match(tree.props.label,/Pending sync/);assert.match(text(tree),/Pending sync/);
 tree.props.onPress();assert.deepEqual(opened,[payment]);assert.ok(!/confirmed/i.test(tree.props.label));
});


test('pending bill stays editable but cannot request server history or reversal before confirmation', () => {
 const expense=billRow({split:{mode:'equal',values:{self:'1',other:'1'}}});
 const tree=production('ExpenseDetail')({expense,group:{...group,expenses:[expense]},selfId:'self',busy:false,canEdit:true,pending:true,onHistory(){}});
 const buttons=elements(tree).filter(node=>node.type==='Button');
 assert.equal(buttons.find(node=>node.props.title==='Edit bill')?.props.disabled,false);
 assert.equal(buttons.find(node=>node.props.title==='Reverse record')?.props.disabled,true);
 assert.equal(buttons.find(node=>node.props.title==='Version history')?.props.disabled,true);
 assert.ok(!elements(tree).some(node=>node.type==='RecordAttribution'&&node.props.action==='Added'));
});
