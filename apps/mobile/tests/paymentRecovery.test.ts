import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { formatMoney, integer, rupeesToPaise } from '../src/accounting.ts';
import { isPersonalPayment } from '../src/personalBalances.ts';
import { paymentReturnNeedsConfirmation } from '../src/paymentReturn.ts';

const payment = { sender: 'self', recipient: 'other', amount: '165869' };
const attempt = { id: 'old-attempt', ...payment, state: 'prepared', group_version: 3, expires_at: '2020-01-01T00:00:00Z' };
const group = { id: 'group', name: 'Synthetic trip', version: 5, participants: [{ id: 'self', name: 'Riya', user_id: 1 }, { id: 'other', name: 'Asha', user_id: 2, payment_profile: { vpa: 'asha@example', version: 1 } }], balances: { self: '-165869', other: '165869' }, transfers: [payment], expenses: [], settlements: [], activity: [], payment_attempts: [attempt] };
class ReviewError extends Error { attempt: typeof attempt; constructor(value: typeof attempt) { super('Review payment'); this.attempt = value; } }
class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function code(file: string) { return ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function action(name: string, env: Record<string, any>) {
  const source = code('App.tsx'); let body = '';
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node.getText(source); ts.forEachChild(node, visit); }
  visit(source); assert.ok(body);
  return new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022 })}; return ${name};}`)(env);
}
function preparation(existing: any = attempt, launchError?: Error, concurrent = false) {
  const calls: string[] = [], feedback: boolean[] = []; let current = existing;
  const env = { session: { token: 'test', userId: '1' }, groupId: 'group', pending: [], owner: 'owner', getDatabase: async () => ({}),
    perform: async (fn: Function, report = true) => { feedback.push(report); return fn(); },
    fetchGroup: async () => group, validateUPIPayment: () => ({ vpa: 'asha@example', name: 'Asha' }),
    request: async (_session: any, path: string) => { if (path.includes('/history/')) return { items: current ? [current] : [] }; if (!path.endsWith('/launch')) return current; calls.push('launch'); if (launchError) throw launchError; return { id: 'new-attempt' }; },
    saveReadGroup: async () => true, activeGroupRef: { current: 'group' }, load: async () => {},
    enqueue: async () => { calls.push('prepare'); current = { ...attempt, id: concurrent ? 'another-device-attempt' : 'new-attempt' }; }, command: (...args: any[]) => args,
    syncOutbox: async () => {}, listGroups: async () => [{ group }], uuid: () => 'new-attempt', ApiError, UPIPaymentReviewError: ReviewError,
    reviewPaymentAttempt: async () => { calls.push('refresh'); },
  };
  return { prepare: action('prepareUPI', env), calls, feedback };
}

test('an existing prepared attempt is reviewed instead of repeatedly launching its expired quote', async () => {
  const h = preparation();
  await assert.rejects(h.prepare(payment), (error: any) => error instanceof ReviewError && error.attempt.id === attempt.id);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.feedback, [false], 'payment screen owns feedback, including conflicts');
});

test('reported attempts cannot be prepared or launched again', async () => {
  const h = preparation({ ...attempt, state: 'reported' });
  await assert.rejects(h.prepare(payment), ReviewError); assert.deepEqual(h.calls, []);
});

test('a new attempt can launch, and a launch conflict becomes review without retrying money handoff', async () => {
  const fresh = preparation(null); await fresh.prepare(payment); assert.deepEqual(fresh.calls, ['prepare', 'launch']);
  const race = preparation(null, new ApiError(409, 'Quote is stale or already reported; review the payment instead of launching again'));
  await assert.rejects(race.prepare(payment), ReviewError); assert.equal(race.calls.filter(value => value === 'launch').length, 1);
  const offline = preparation(null, Error('Offline')); await assert.rejects(offline.prepare(payment), /Offline/);
});

test('an attempt created concurrently on another device is reviewed, never opened as the newly requested payment', async () => {
  const h = preparation(null, undefined, true);
  await assert.rejects(h.prepare(payment), (error: any) => error instanceof ReviewError && error.attempt.id === 'another-device-attempt');
  assert.deepEqual(h.calls, ['prepare']);
});

type Element = { type: any; props: any; children: any[] };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
function screen(overrides: Record<string, any> = {}) {
  let cursor = 0; const states: any[] = [], saved: any[] = [], cancelled: string[] = [], opened: string[] = [];
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) };
  const env: any = { React, View: 'View', Text: 'Text', Button: 'Button', ErrorText: 'ErrorText', NoticeBanner: 'NoticeBanner', Avatar: 'Avatar', Icon: 'Icon', AmountField: 'AmountField', DetailDialog: 'DetailDialog', PersonSelectionList: 'PersonSelectionList', PaymentAddress: 'PaymentAddress', PaymentHelpDialog: 'PaymentHelpDialog', UPIAppChooser: 'UPIAppChooser', WebPaymentQuote: 'WebPaymentQuote',
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => states[cursor++] ??= { current: initial }, useEffect() {}, useMemo: (fn: Function) => fn(), useLoading() {}, useScreenRemovalLock() {}, useToast: () => () => {}, useUI: () => ({ palette: {}, ui: {} }), StyleSheet: { create: (value: any) => value },
    formatMoney, integer, rupeesToPaise, isPersonalPayment, paymentReturnNeedsConfirmation, UPIPaymentReviewError: ReviewError,
    currencySymbol: () => '₹', Platform: { OS: 'ios' }, Alert: { alert: (_title: string, _body: string, actions: any[]) => actions.find(action => action.text === 'Record payment')?.onPress() }, addSettlement() {},
  };
  const source = code('src/SettleForm.tsx');
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const render = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return SettleForm;}`)(env);
  const props: any = { group: structuredClone(group), initial: payment, selfId: 'self', busy: false, returnPayment: null, onReviewAttempt: async () => {}, onCancel: () => {}, onSave: async (value: any) => saved.push(value), onCancelUPI: async (id: string) => { cancelled.push(id); props.group = { ...props.group, payment_attempts: [] }; }, onPrepareUPI: async () => { opened.push('prepare'); }, ...overrides };
  const tree = () => { cursor = 0; return render(props); };
  const press = async (title: string) => { const button = nodes(tree()).find(node => node.props.title === title); assert.ok(button, title); await button.props.onPress(); for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { tree, press, props, saved, cancelled, opened };
}

test('prepared recovery replaces Pay, explicitly cancels the exact old attempt and leaves a fresh Pay action', async () => {
  const h = screen();
  assert.ok(JSON.stringify(h.tree()).includes('Check this payment'));
  assert.ok(!nodes(h.tree()).some(node => node.props.title?.includes('with UPI')));
  await h.press('No, start over');
  assert.deepEqual(h.cancelled, [attempt.id]); assert.deepEqual(h.opened, []);
  assert.ok(nodes(h.tree()).some(node => node.props.title?.includes('with UPI')));
});

test('paid recovery records the exact original amount and attempt rather than the edited form amount', async () => {
  const h = screen({ initial: { ...payment, amount: '500' } });
  await h.press('Yes, I paid');
  assert.deepEqual(h.saved, [{ ...payment, attemptId: attempt.id }]);
  assert.deepEqual(h.opened, []); assert.deepEqual(h.cancelled, []);
});

test('reported and offline recovery preserve the attempt and never expose another UPI launch', async () => {
  const reported = screen({ group: { ...group, payment_attempts: [{ ...attempt, state: 'reported' }] } });
  assert.ok(!nodes(reported.tree()).some(node => node.props.title === 'No, start over' || node.props.title?.includes('with UPI')));
  const offline = screen({ onCancelUPI: async () => { throw Error('Could not connect'); } });
  await offline.press('No, start over'); assert.ok(JSON.stringify(offline.tree()).includes('Could not connect'));
  assert.ok(!nodes(offline.tree()).some(node => node.props.title?.includes('with UPI')));
});

test('a conflicting cancellation switches to reported or already-recorded review without another cancellation or launch', async () => {
  for (const state of ['reported', 'recorded', 'confirmed']) {
    const h = screen({ onCancelUPI: async () => { throw new ReviewError({ ...attempt, state }); } });
    await h.press('No, start over');
    assert.ok(!nodes(h.tree()).some(node => node.props.title === 'No, start over' || node.props.title?.includes('with UPI')));
    if (state !== 'reported') assert.ok(nodes(h.tree()).some(node => node.props.title === 'Review balance'));
    assert.deepEqual(h.opened, []);
  }
});

test('manual recovery passes the exact reviewed attempt to bookkeeping and omits client-only identity fields', async () => {
  const writes: any[] = [];
  const save = action('savePayment', { selected: { group }, groupId: group.id, pending: [], session: null, uuid: () => 'settlement',
    perform: async (fn: Function, report = true) => { assert.equal(report, false); return fn(); },
    command: (_method: string, _path: string, body: any) => body, queue: async (body: any) => writes.push(body), navigation: { complete() {} },
  });
  await save({ ...payment, attemptId: 'exact-reviewed-attempt' });
  assert.equal(writes[0].attempt_id, 'exact-reviewed-attempt'); assert.equal(writes[0].amount, payment.amount);
  assert.ok(!('attemptId' in writes[0]));
});

test('a saved bank-return question takes precedence over generic attempt recovery', () => {
  const h = screen({ returnPayment: { groupId: group.id, ...payment, attemptId: attempt.id, amount: '500', payeeName: 'Original payee', vpa: 'original@example', launch: 'opened', handoffConfirmed: true, leftApp: true, returned: true, decision: null } });
  const rendered = JSON.stringify(h.tree());
  assert.ok(rendered.includes('Original payee')); assert.ok(!rendered.includes('Check this payment'));
  assert.ok(!nodes(h.tree()).some(node => node.props.title === 'No, start over'));
});
