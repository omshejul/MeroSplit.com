import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createPaymentReturn, launchPaymentReturn, paymentReturnEvent, paymentReturnNeedsConfirmation, PaymentReturnReviewError } from '../src/paymentReturn.ts';
import type { PaymentReturn, PaymentReturnEvent } from '../src/paymentReturn.ts';
import { buildUPIUrl, openUPIPayment } from '../src/upi.ts';

const identity = { groupId: 'group', groupVersion: 1, attemptId: 'b7cc727a-992b-4d75-9f7b-a5accdb6c6ae', sender: 'self', recipient: 'payee', amount: '334', payeeName: 'Original payee', vpa: 'synthetic@invalid', yesCommandId: 'yes-once', noCommandId: 'no-once', settlementId: 'settlement-once', date: '2026-10-17' };
const fresh = () => createPaymentReturn(identity);
const quote = { id: identity.attemptId, amount: identity.amount, recipient: identity.payeeName, vpa: identity.vpa, currency: 'INR', note: 'Synthetic only', bank_verified: false as const, direct_launch_supported: true, expires_at: '2099-01-01T00:00:00Z', group_version: 1 };
function tracking() {
  let record = fresh();
  const persisted: PaymentReturn[] = [];
  return { get record() { return record; }, persisted, async event(event: PaymentReturnEvent) { record = paymentReturnEvent(record, event); persisted.push(structuredClone(record)); } };
}

test('successful handoff waits for actual leave and return; unrelated foreground and no departure never prompt', async () => {
  const flow = tracking();
  await flow.event({ type: 'background' }); await flow.event({ type: 'active' });
  assert.equal(paymentReturnNeedsConfirmation(flow.record), false);
  await launchPaymentReturn(async () => {}, flow.event, async () => {}, true);
  await flow.event({ type: 'active' });
  assert.equal(paymentReturnNeedsConfirmation(flow.record), false);
  await flow.event({ type: 'background' });
  assert.equal(paymentReturnNeedsConfirmation(flow.record), false);
  await flow.event({ type: 'active' });
  assert.equal(paymentReturnNeedsConfirmation(flow.record), true);
  assert.strictEqual(paymentReturnEvent(flow.record, { type: 'active' }), flow.record, 'repeated foreground is inert');
});

test('departure and return before native open promise resolves are preserved, but failed open clears them', async () => {
  for (const fail of [false, true]) {
    const flow = tracking();
    const open = async () => { await flow.event({ type: 'background' }); await flow.event({ type: 'active' }); if (fail) throw Error('OS refused'); };
    const action = launchPaymentReturn(async () => {}, flow.event, open, true);
    if (fail) await assert.rejects(action, /OS refused/); else await action;
    assert.equal(paymentReturnNeedsConfirmation(flow.record), !fail);
  }
});

test('chooser cancellation never prompts even when the chooser backgrounds our Activity; ambiguous browser launch needs explicit review', async () => {
  const cancelled = tracking();
  await launchPaymentReturn(async () => {}, cancelled.event, async () => { await cancelled.event({ type: 'background' }); await cancelled.event({ type: 'active' }); return false; }, true);
  assert.equal(cancelled.record.launch, 'failed');
  assert.equal(paymentReturnNeedsConfirmation(cancelled.record), false);
  const browser = tracking();
  await launchPaymentReturn(async () => {}, browser.event, async () => { await browser.event({ type: 'background' }); await browser.event({ type: 'active' }); }, false);
  assert.equal(paymentReturnNeedsConfirmation(browser.record), false);
  await browser.event({ type: 'review' });
  assert.equal(paymentReturnNeedsConfirmation(browser.record), true);
});

test('durable arming and opening complete before crossing the OS boundary; persistence failure prevents launch', async () => {
  const order: string[] = [];
  await launchPaymentReturn(async () => { order.push('persist identity'); }, async event => { order.push(event.type); }, async () => { order.push('OS'); }, true);
  assert.deepEqual(order, ['persist identity', 'opening', 'OS', 'opened']);
  let opens = 0;
  await assert.rejects(launchPaymentReturn(async () => { throw Error('disk'); }, async () => {}, async () => { opens++; }, true), /disk/);
  await assert.rejects(launchPaymentReturn(async () => {}, async () => { throw Error('disk'); }, async () => { opens++; }, true), /disk/);
  assert.equal(opens, 0);
});

test('restart restores only proven departure and freezes paise, payee and each decision command on retries', async () => {
  const flow = tracking();
  await launchPaymentReturn(async () => {}, flow.event, async () => {}, true);
  await flow.event({ type: 'background' });
  const restored: PaymentReturn = JSON.parse(JSON.stringify(flow.record));
  const returned = paymentReturnEvent(restored, { type: 'active' });
  assert.equal(paymentReturnNeedsConfirmation(returned), true);
  for (const paid of [true, false]) {
    const decided = paymentReturnEvent(returned, { type: 'decision', paid });
    assert.deepEqual(Object.fromEntries(Object.keys(identity).map(key => [key, decided[key as keyof PaymentReturn]])), identity);
    assert.strictEqual(paymentReturnEvent(decided, { type: 'decision', paid: !paid }), decided, 'ambiguous retry cannot switch Yes/No');
    assert.strictEqual(paymentReturnEvent(decided, { type: 'opening' }), decided, 'cannot relaunch a decided payment');
  }
  assert.equal(paymentReturnNeedsConfirmation(paymentReturnEvent(fresh(), { type: 'active' })), false);
});

// Exercise actual production callsites with the OS/API boundaries replaced. No
// React renderer, payment app, network, or copied implementation is involved.
const source = readFileSync(new URL('../src/SettleForm.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('SettleForm.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function productionFunction(name: string, context: Record<string, unknown>) {
  let found: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); }
  visit(file); assert.ok(found, `${name} production callsite exists`);
  const javascript = ts.transpileModule(found.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function(...Object.keys(context), `${javascript}; return ${name};`)(...Object.values(context));
}

test('production native handoff persists frozen quote before bound Linking and captures early lifecycle return', async () => {
  const flow = tracking(), calls: string[] = [];
  const Linking = { marker: true, async openURL(url: string) { assert.equal(this.marker, true); assert.match(url, /^gpay:\/\/upi\/pay\?/); calls.push('OS'); await flow.event({ type: 'background' }); await flow.event({ type: 'active' }); } };
  const handoff = productionFunction('handoff', { onPrepareUPI: async () => quote, mounted: { current: true }, buildUPIUrl, Platform: { OS: 'ios' }, setWebQuote: () => assert.fail('not web'), launchPaymentReturn, armReturn: async (payment: unknown, actualQuote: unknown) => { assert.equal(actualQuote, quote); calls.push('persist'); }, transitionReturn: flow.event, openUPIPayment, Linking });
  await handoff({ sender: 'self', recipient: 'payee', amount: '334' }, { name: identity.payeeName, vpa: identity.vpa }, { id: 'google-pay' });
  assert.deepEqual(calls, ['persist', 'OS']); assert.equal(paymentReturnNeedsConfirmation(flow.record), true);
  await assert.rejects(handoff({ sender: 'self', recipient: 'payee', amount: '335' }, { name: identity.payeeName, vpa: identity.vpa }, { id: 'google-pay' }), /changed/);
  assert.equal(calls.length, 2, 'mismatched quote cannot arm or open');
});

test('production Android native chooser cancellation flows through UPI helper and suppresses the return question', async () => {
  for (const selected of [false, true]) {
    const flow = tracking();
    const handoff = productionFunction('handoff', { onPrepareUPI: async () => quote, mounted: { current: true }, buildUPIUrl, Platform: { OS: 'android' }, setWebQuote: () => {}, launchPaymentReturn, armReturn: async () => {}, transitionReturn: flow.event, openUPIPayment, Linking: { openURL: () => assert.fail('Android must use selection-aware adapter') }, openAndroidUPIChooser: async (url: string) => { assert.match(url, /^upi:\/\/pay\?/); await flow.event({ type: 'background' }); await flow.event({ type: 'active' }); return selected; } });
    await handoff({ sender: 'self', recipient: 'payee', amount: '334' }, { name: identity.payeeName, vpa: identity.vpa }, { id: 'upi' });
    assert.equal(paymentReturnNeedsConfirmation(flow.record), selected);
  }
});

test('leaving the production screen during durable arm prevents the OS handoff', async () => {
  const flow = tracking(), mounted = { current: true };
  const handoff = productionFunction('handoff', { onPrepareUPI: async () => quote, mounted, buildUPIUrl, Platform: { OS: 'ios' }, setWebQuote: () => {}, launchPaymentReturn, armReturn: async () => { mounted.current = false; }, transitionReturn: flow.event, openUPIPayment, Linking: { openURL: () => assert.fail('screen/account left before launch') } });
  await assert.rejects(handoff({ sender: 'self', recipient: 'payee', amount: '334' }, { name: identity.payeeName, vpa: identity.vpa }, { id: 'google-pay' }), /Open this payment again/);
  assert.equal(flow.record.launch, 'failed');
  assert.equal(paymentReturnNeedsConfirmation(flow.record), false);
});

test('production Yes is single-flight; uncertain retry preserves one frozen payload and cannot become No', async () => {
  let record = paymentReturnEvent(fresh(), { type: 'review' });
  const returnRef = { current: record }, lock = { current: false }, errors: string[] = [], sent: PaymentReturn[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const resolveReturn = productionFunction('resolveReturn', {
    lock, busy: false, returnRef, paymentReturnNeedsConfirmation, setSaving: () => {}, setReturnError: (value: string) => errors.push(value), setReturnReview: () => {}, mounted: { current: true }, PaymentReturnReviewError,
    transitionReturn: async (event: PaymentReturnEvent) => { returnRef.current = paymentReturnEvent(returnRef.current, event); }, returnWrites: { current: Promise.resolve() },
    onResolveReturn: async (frozen: PaymentReturn, paid: boolean) => { assert.equal(paid, true); sent.push(structuredClone(frozen)); if (first) { first = false; await gate; throw Error('response lost'); } },
  });
  const firstPress = resolveReturn(true); await Promise.resolve();
  await resolveReturn(true); release(); await firstPress;
  assert.equal(sent.length, 1); assert.equal(errors.at(-1), 'Could not confirm the update. Try again.');
  await resolveReturn(false);
  assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]); assert.equal(sent[1].decision, 'paid');
});

test('in-app multiple-app selection does not prepare or arm until a choice is made', async () => {
  let chooser: unknown;
  const pay = productionFunction('pay', { lock: { current: false }, busy: false, group: { archived: false }, setSaving: () => {}, setSavingAction: () => {}, setError: () => {}, setNotice: () => {}, chooser: null, sender: 'self', recipient: 'other', amount: '3.34', rupeesToPaise: () => '334', selfId: 'self', validateUPIPayment: () => ({ vpa: identity.vpa, name: identity.payeeName }), Platform: { OS: 'ios' }, availableUPIApps: async () => [{ id: 'phonepe' }, { id: 'google-pay' }], Linking: { canOpenURL: async () => true }, mounted: { current: true }, handoff: () => assert.fail('chooser has not selected an app'), setChooser: (next: unknown) => { chooser = next; } });
  await pay(); assert.ok(chooser);
});


test('production web preparation durably arms before rendering a clickable handoff', async () => {
  const order: string[] = [];
  const handoff = productionFunction('handoff', { onPrepareUPI: async () => quote, mounted: { current: true }, buildUPIUrl, Platform: { OS: 'web' }, setPeopleOpen: () => {}, armReturn: async () => { order.push('arm durable'); }, transitionReturn: async (event: PaymentReturnEvent) => { order.push(event.type + ' durable'); }, setWebQuote: () => { order.push('render button'); } });
  await handoff({ sender: 'self', recipient: 'payee', amount: '334' }, { name: identity.payeeName, vpa: identity.vpa });
  assert.deepEqual(order, ['arm durable', 'opening durable', 'render button']);
});

test('production web button invokes bound URL opener in the original gesture before a promise tick', async () => {
  const order: string[] = [];
  const frozen = paymentReturnEvent(fresh(), { type: 'opening' });
  const openWebPayment = productionFunction('openWebPayment', { webQuote: { quote, target: { name: identity.payeeName, vpa: identity.vpa } }, lock: { current: false }, busy: false, returnRef: { current: frozen }, setSaving: () => {}, setSavingAction: () => {}, setError: () => {}, openUPIPayment, Linking: { bound: true, async openURL(this: { bound: boolean }, url: string) { assert.equal(this.bound, true); assert.match(url, /^upi:\/\/pay\?/); order.push('open URL'); } }, transitionReturn: async (event: PaymentReturnEvent) => { order.push(event.type); }, mounted: { current: true }, setWebQuote: () => {} });
  queueMicrotask(() => order.push('promise tick'));
  openWebPayment();
  assert.deepEqual(order, ['open URL']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['open URL', 'promise tick', 'opened']);
});


test('web prearmed reminder survives reload for explicit review without pretending a handoff happened', () => {
  const prepared = paymentReturnEvent(fresh(), { type: 'opening' });
  const restored: PaymentReturn = JSON.parse(JSON.stringify(prepared));
  const active = paymentReturnEvent(restored, { type: 'active' });
  assert.equal(paymentReturnNeedsConfirmation(active), false);
  const reviewed = paymentReturnEvent(active, { type: 'review' });
  assert.equal(paymentReturnNeedsConfirmation(reviewed), true);
  assert.equal(reviewed.handoffConfirmed, false); assert.equal(reviewed.leftApp, false);
  assert.deepEqual(paymentReturnEvent(reviewed, { type: 'decision', paid: true }).yesCommandId, identity.yesCommandId);
});
