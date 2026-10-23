import test from 'node:test';
import assert from 'node:assert/strict';
import { availableUPIApps, buildUPIUrl, openUPIPayment, validateUPIPayment } from '../src/upi.ts';
import type { UPILaunchQuote } from '../src/upi.ts';
import type { Group } from '../src/types.ts';

const quote: UPILaunchQuote = { id: '4b8f5680-c7c4-45ec-8a2f-842fb5854090', vpa: 'rita.pay@okaxis', amount: '12501', currency: 'INR', recipient: 'Rita & ऋता + friend', note: 'Group repayment & dinner? pa=wrong@bank', bank_verified: false, direct_launch_supported: true, expires_at: new Date(Date.now() + 600_000).toISOString(), group_version: 4 };
const group: Group = { id: 'g', name: 'Synthetic trip', version: 4, participants: [{ id: 'A', name: 'A', user_id: 1 }, { id: 'B', name: quote.recipient, user_id: 2, payment_profile: { vpa: quote.vpa, version: 3, bank_verified: false } }], expenses: [], settlements: [], balances: { A: '-15000', B: '15000' }, transfers: [{ sender: 'A', recipient: 'B', amount: '15000' }], activity: [] };

test('UPI URLs preserve exact paise and safely encode the intended address, Unicode name and note', () => {
  const url = new URL(buildUPIUrl(quote));
  assert.equal(url.protocol, 'upi:'); assert.equal(url.hostname, 'pay');
  assert.equal(url.searchParams.get('pa'), quote.vpa); assert.equal(url.searchParams.getAll('pa').length, 1);
  assert.equal(url.searchParams.get('pn'), quote.recipient); assert.equal(url.searchParams.get('tn'), quote.note);
  assert.equal(url.searchParams.get('am'), '125.01'); assert.equal(url.searchParams.get('cu'), 'INR');
  assert.equal(url.searchParams.get('tr'), quote.id.replaceAll('-', ''));
  assert.match(buildUPIUrl(quote, 'google-pay'), /^gpay:\/\/upi\/pay\?/);
  assert.equal(new URL(buildUPIUrl({ ...quote, amount: '1' })).searchParams.get('am'), '0.01');
  assert.equal(new URL(buildUPIUrl({ ...quote, amount: '1000000000' })).searchParams.get('am'), '10000000.00');
});

test('Only an active self payer with a known recipient address can pay up to the actual outstanding proposal', () => {
  const payment = { sender: 'A', recipient: 'B', amount: '12501' };
  assert.deepEqual(validateUPIPayment(group, 'A', payment), { vpa: quote.vpa, name: quote.recipient });
  for (const amount of ['0', '15001', '-1', '1.2', '001', '1000000001']) assert.throws(() => validateUPIPayment(group, 'A', { ...payment, amount }));
  assert.throws(() => validateUPIPayment(group, 'B', payment), /own outstanding/);
  assert.throws(() => validateUPIPayment({ ...group, archived: true }, 'A', payment), /Reopen/);
  assert.throws(() => validateUPIPayment({ ...group, transfers: [] }, 'A', payment), /current amount/);
  assert.throws(() => validateUPIPayment({ ...group, participants: group.participants.map(person => person.id === 'B' ? { ...person, removed: true } : person) }, 'A', payment), /own outstanding/);
  assert.throws(() => validateUPIPayment({ ...group, participants: group.participants.map(person => person.id === 'B' ? { ...person, payment_profile: null } : person) }, 'A', payment), /UPI address/);
});

test('Expired, unsupported-currency, disabled and malformed quotes cannot produce a payment link', () => {
  for (const value of [{ ...quote, currency: 'USD' }, { ...quote, direct_launch_supported: false }, { ...quote, amount: '0' }, { ...quote, amount: '12.5' }, { ...quote, amount: '1000000001' }, { ...quote, vpa: 'rita@bank&pa=wrong@bank' }, { ...quote, id: 'https://example.test' }, { ...quote, expires_at: 'not-a-date' }, { ...quote, expires_at: new Date(Date.now() - 1000).toISOString() }, { ...quote, group_version: 0 }, { ...quote, group_version: 1.5 }]) assert.throws(() => buildUPIUrl(value));
  assert.throws(() => buildUPIUrl(quote, 'toString' as 'upi'));
});

test('Only provider-documented native routes are probed; browsers never claim installed-app detection', async () => {
  const probes: string[] = [];
  const probe = async (url: string) => { probes.push(url); return true; };
  assert.deepEqual((await availableUPIApps('ios', probe)).map(app => app.id), ['google-pay', 'upi']);
  assert.deepEqual(probes, ['gpay://upi/pay', 'upi://pay']); probes.length = 0;
  assert.deepEqual((await availableUPIApps('android', probe)).map(app => app.id), ['upi']); assert.deepEqual(probes, ['upi://pay']); probes.length = 0;
  assert.deepEqual(await availableUPIApps('web', probe), []); assert.deepEqual(probes, []);
  assert.deepEqual(await availableUPIApps('ios', async () => { throw new Error('No supported handler'); }), []);
});

test('Opening captures the intended quote only, and mismatch/cancel/failure never reports a payment', async () => {
  const opened: string[] = [], expected = { amount: quote.amount, vpa: quote.vpa, name: quote.recipient };
  await openUPIPayment(quote, 'upi', expected, async url => { opened.push(url); return { status: 'success', arbitrary_untrusted_callback: true }; });
  assert.deepEqual(opened, [buildUPIUrl(quote)]);
  for (const mismatch of [{ ...expected, amount: '15000' }, { ...expected, vpa: 'other@bank' }, { ...expected, name: 'Other person' }]) await assert.rejects(openUPIPayment(quote, 'upi', mismatch, async url => { opened.push(url); }), /recipient changed/);
  assert.equal(opened.length, 1);
  await assert.rejects(openUPIPayment(quote, 'upi', expected, async () => { throw new Error('Cancelled with private URI/token'); }), error => error instanceof Error && /No UPI app opened/.test(error.message) && !error.message.includes('private URI'));
  assert.equal(opened.length, 1);
});
