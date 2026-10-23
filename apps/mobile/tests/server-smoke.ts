// Explicit integration command. Creates synthetic accounts/groups, never bank transfers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requestEmailCode, confirmEmailCode, expensePayload, request } from '../src/api.ts';
import { validateExpense } from '../src/accounting.ts';
import type { Group, Session } from '../src/types.ts';

const base = process.env.API_URL ?? 'http://127.0.0.1:8000';
const outbox = process.env.FAKE_EMAIL_OUTBOX;
if (!outbox || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Run against the local fake email provider and set FAKE_EMAIL_OUTBOX. No real inboxes are used.');
const signup = async () => {
  const email = `mobile-${randomUUID()}@example.invalid`, challenge = await requestEmailCode(base, email);
  const messages = JSON.parse(readFileSync(outbox, 'utf8')).messages as { recipient: string; text: string }[];
  const code = messages.findLast(message => message.recipient === email)?.text.match(/\b[0-9]{4}\b/)?.[0];
  if (!code) throw new Error('The local fake provider did not capture a code.');
  return confirmEmailCode(base, challenge.challengeId, code);
};
const a = await signup(), b = await signup(), groupId = randomUUID(), ids = [randomUUID(), randomUUID()].sort();
const post = <T>(session: Session, path: string, body: Record<string, unknown> = {}) => request<T>(session, path, 'POST', { ...body, command_id: randomUUID() });
const snapshot = (session = a) => request<Group>(session, `/groups/${groupId}`);
await post(a, '/groups', { id: groupId, name: 'Mobile client synthetic smoke', self_participant_id: ids[0], participants: ids.map((id, index) => ({ id, name: `Synthetic ${index + 1}` })) });
const split = { mode: 'equal' as const, values: Object.fromEntries(ids.map(id => [id, '1'])) };
const vectors = validateExpense('120000', { [ids[0]]: '120000' }, split, ids);
const expense = { id: randomUUID(), version: 0, description: 'Synthetic bill', total: '120000', ...vectors, split, date: '2026-10-16', category: 'test', notes: 'No bank transfer', deleted: false };
const expenseCommand = { ...expensePayload(expense), command_id: randomUUID() };
const ack = await request<{ version: number }>(a, `/groups/${groupId}/expenses`, 'POST', expenseCommand);
await request(a, `/groups/${groupId}/expenses`, 'POST', expenseCommand);
assert.equal((await snapshot()).version, ack.version);
assert.equal((await snapshot()).balances[ids[0]], '60000');
await post(a, `/groups/${groupId}/settlements`, { id: randomUUID(), sender: ids[1], recipient: ids[0], amount: '15000' });
assert.equal((await snapshot()).balances[ids[0]], '45000');
const laterParticipant = randomUUID();
await post(a, `/groups/${groupId}/participants`, { id: laterParticipant, name: 'Added after bill' });
const withParticipant = await snapshot();
assert.equal(withParticipant.balances[laterParticipant], '0');
assert.deepEqual(withParticipant.expenses[0].shares, vectors.shares, 'new participant cannot rewrite historical shares');
assert.equal(withParticipant.totals!.spending, '120000');
assert.equal(withParticipant.totals!.paid[ids[0]], '120000');
assert.equal(withParticipant.totals!.shares[ids[0]], '60000');
assert.equal(withParticipant.totals!.shares[laterParticipant], '0');

const invitation = await post<{ token: string }>(a, `/groups/${groupId}/invites`, { participant_id: ids[1] });
await post(b, `/invites/${invitation.token}/claim`);
const ownerView = await request<Group & { invites: { id: string; participant_id: string }[] }>(a, `/groups/${groupId}`);
const inviteId = ownerView.invites.find(invite => invite.participant_id === ids[1])!.id;
await post(a, `/groups/${groupId}/invites/${inviteId}/approve`);
assert.equal((await snapshot(b)).participants.find(p => p.id === ids[1])?.user_id, Number(b.userId));
await request(a, '/me/payment-profile', 'PUT', { vpa: 'synthetic@okaxis' });

async function prepare(amount: string) {
  const before = await snapshot(b), version = before.participants.find(p => p.id === ids[0])!.payment_profile!.version;
  await post(b, `/groups/${groupId}/payment-attempts`, { id: randomUUID(), sender: ids[1], recipient: ids[0], amount, group_version: before.version, payee_version: version });
  const active = (await snapshot(b)).payment_attempts!.find(attempt => attempt.sender === ids[1] && attempt.recipient === ids[0] && ['prepared', 'reported'].includes(attempt.state));
  assert.ok(active); return active.id;
}
const attemptId = await prepare('10000');
assert.equal(await prepare('10000'), attemptId, 'existing attempt reused across different command IDs');
const details = await request<{ direct_launch_supported: boolean; bank_verified: boolean }>(b, `/groups/${groupId}/payment-attempts/${attemptId}/launch`);
assert.equal(typeof details.direct_launch_supported, 'boolean'); assert.equal(details.bank_verified, false);
await post(b, `/groups/${groupId}/payment-attempts/${attemptId}/report`);
assert.equal((await snapshot()).balances[ids[0]], '45000', 'payer report does not post');
await post(a, `/groups/${groupId}/payment-attempts/${attemptId}/confirm`);
assert.equal((await snapshot()).balances[ids[0]], '35000');
const second = await prepare('10000');
await post(b, `/groups/${groupId}/settlements`, { id: randomUUID(), sender: ids[1], recipient: ids[0], amount: '11000', attempt_id: second });
assert.equal((await snapshot()).balances[ids[0]], '24000');
await post(a, `/groups/${groupId}/payment-attempts/${second}/confirm`);
assert.equal((await snapshot()).balances[ids[0]], '24000', 'acknowledging manual entry cannot post twice');

await request(a, `/groups/${groupId}/export?format=json`);
const csv = await request<string>(a, `/groups/${groupId}/export?format=csv`, 'GET', undefined, 'text');
assert.ok(csv.includes('Synthetic bill'));
await request(a, '/account/export');
await post(a, `/groups/${groupId}/archive`, { archived: true });
await post(a, `/groups/${groupId}/archive`, { archived: false });
console.log(JSON.stringify({ result: 'passed', backend: base, group: groupId, checks: ['allauth', 'native session header', 'strict payload', 'duplicate write', 'manual payment', 'add participant without rewriting history', 'accepted spending/paid/share totals', 'scoped claim and approval', 'own VPA', 'active attempt reuse', 'no bank verification claim', 'report no posting', 'receipt posting', 'actual manual amount', 'no double confirmation', 'JSON/CSV/account export', 'archive/reopen'] }));
