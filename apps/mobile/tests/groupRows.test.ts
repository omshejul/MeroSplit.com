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
function production(name: string, overrides: Record<string, any> = {}) {
  const helpers = source.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ['billImpact', 'participantName', 'displayDate', 's'].includes(d.name.getText(source)))).map(node => node.getText(source)).join('\n');
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name); assert.ok(node);
  const code = ts.transpile(`${helpers}\n${node.getText(source).replace(/^export (?:default )?/, '')}\nreturn ${name};`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  return new Function('env', `with(env) { ${code} }`)({ React, expenseBalanceChange, formatMoney, paymentPresentation, personalSettlements, personalTransfers, BalanceExplanation: 'BalanceExplanation', balanceKey: () => '', useRef: () => ({ current: null }), useState: (initial: unknown) => [initial, () => {}], Avatar: 'Avatar', AmountText: 'AmountText', Text: 'Text', SectionHeading: 'SectionHeading', View: 'View', Pressable: 'Pressable', Icon: 'Icon', Button: 'Button', RecordSummary: 'RecordSummary', ParticipantAmountRow: 'ParticipantAmountRow', LogRow: 'LogRow', LogDate: 'LogDate', BillEffect: 'BillEffect', VisibleExpense: 'VisibleExpense', HistoryPages: 'HistoryPages', BillSearch: 'BillSearch', PaymentRow: 'PaymentRow', BillTimelineRow: 'BillTimelineRow', Disclosure: 'Disclosure', BillPeople: 'BillPeople', RecordAttribution: 'RecordAttribution', PersonalTransferRow: 'PersonalTransferRow', PendingChangeRow: 'PendingChangeRow', StyleSheet: { create: (styles: unknown) => styles }, radii: { surface: 16 }, balanceColor: (amount: string) => BigInt(amount) < 0n ? 'negative' : 'positive', useUI: () => ({ ui: { numeric: { fontSize: 32, fontWeight: '600' }, caption: { fontSize: 14 }, row: { minHeight: 52, paddingVertical: 6 } }, palette: { muted: 'muted' } }), ...overrides });
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
  assert.deepEqual(tree.children.flat().map((node: any) => node?.type ?? node), ['LogDate', 'View', 'Effect']);
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
  assert.ok(nodes.some(node => node.type === 'Icon' && node.props.name === 'payment' && node.props.size === 18));
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
    ['recipient_confirmed', true, 'Record reversed · No bank refund'],
  ] as const) {
    const payment = { id: 'record', sender: 'other', recipient: 'self', amount: '334', method, reversed, date: '2026-10-18' };
    const tree = render({ group, selfId: 'self', busy: false, payment, accepted: { settlements: [], transactions: [{ kind: 'payment', payment }] } });
    assert.ok(text(tree).includes(`Noor paid you ${formatMoney('334')}`));
    if (status) { assert.ok(text(tree).includes(status)); assert.ok(tree.props.label.includes(status)); }
    assert.ok(!`${text(tree)} ${tree.props.label}`.includes('Receipt unconfirmed'));
    assert.ok(tree.props.label.includes('18 Oct 2026')); assert.equal(tree.props.date, '2026-10-18');
    assert.ok(elements(tree).some(node => node.type === 'Icon' && node.props.name === (reversed ? 'refresh' : 'payment')));
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

test('timeline and fallback rows share contiguous list parents, preserve order and leave pagination outside', () => {
  const render = production('GroupScreen');
  const bill = { id: 'bill', description: 'Lunch', date: '2026-10-18' };
  const first = { id: 'first', sender: 'self', recipient: 'other', amount: '334' };
  const second = { ...first, id: 'second', reversed: true };
  const value = { ...group, expenses: [bill], settlements: [first, second], transfers: [], transactions: [{ kind: 'bill', bill }, { kind: 'payment', payment: first }, { kind: 'payment', payment: second }] };
  const props = { group: value, accepted: value, selfId: 'self', pending: [], busy: true, onPayment() {}, onExpense() {} };
  const children = (node: Element) => node.children.flat(Infinity).filter((child): child is Element => !!child && typeof child === 'object' && 'type' in child);
  const rowParent = (tree: Element) => elements(tree).find(node => node.type === 'View' && children(node).some(child => ['PaymentRow', 'BillTimelineRow'].includes(String(child.type))));
  const tree = render(props), list = elements(tree).find(node => node.props.role === 'list' && node.props.accessibilityLabel === 'Bills and payments')!;
  const rows = children(list).flatMap(children);
  assert.ok(children(list).every(node => node.props.role === 'listitem'));
  assert.ok(list); assert.equal(list.props.style, undefined);
  assert.deepEqual(rows.map(node => node.props.expense?.id ?? node.props.payment.id), ['bill', 'first', 'second']);
  assert.ok(rows.every(node => node.props.busy === true));
  assert.ok(rows.filter(node => node.type === 'PaymentRow').every(node => node.props.accepted === value && node.props.onPayment === props.onPayment));
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

test('search opens from the heading line, stays open for an active query, and partial pages still offer it', () => {
  const render = production('GroupScreen');
  const bills = Array.from({ length: 5 }, (_, index) => ({ id: `b${index}`, description: `Bill ${index}`, total: '100', paid: { self: '100' }, shares: { self: '100' }, date: '2026-10-18' }));
  const base = { ...group, expenses: bills, settlements: [], transfers: [], read_mode: 'summary', transactions: bills.map(bill => ({ kind: 'bill', date: bill.date, bill })) };
  const notice = { notices: [] };
  const view = (value: Record<string, any>, accepted: Record<string, any> = value) => elements(render({ group: value, accepted, selfId: 'self', pending: [], busy: false, noticeVisibility: notice }));
  const closed = view(base);
  assert.ok(closed.some(node => node.type === 'Button' && node.props.title === 'Search' && node.props.accessibilityLabel === 'Search bills'));
  assert.ok(!closed.some(node => node.type === 'BillSearch'));
  assert.ok(closed.filter(node => node.type === 'BillTimelineRow').every(node => node.props.noticeVisibility === notice), 'notice hooks stay on the displayed accepted bills');
  assert.ok(view(base, { ...base }).filter(node => node.type === 'BillTimelineRow').every(node => node.props.noticeVisibility === undefined), 'previews never mark bills seen');
  const queried = view({ ...base, history: { transactions: { query: 'rent', next_cursor: null } } });
  const field = queried.find(node => node.type === 'BillSearch')!;
  assert.equal(field.props.value, 'rent'); assert.equal(field.props.showSubmit, true); assert.equal(field.props.autoFocus, false);
  assert.ok(!queried.some(node => node.type === 'Button' && node.props.title === 'Search'));
  const partial = view({ ...base, expenses: bills.slice(0, 1), transactions: base.transactions.slice(0, 1), history: { transactions: { next_cursor: 'older' } } });
  assert.ok(partial.some(node => node.type === 'Button' && node.props.title === 'Search'));
  assert.ok(partial.some(node => node.type === 'HistoryPages' && node.props.resource === 'transactions'));
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
