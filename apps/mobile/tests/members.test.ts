import test from 'node:test';
import assert from 'node:assert/strict';
import { addPerson, currentEmailInvite, emailInvitationRequest, personRequest, saveContact, sendInvitation } from '../src/members.ts';
import type { Group } from '../src/types.ts';
const group: Group = { id: 'group', name: 'Trip', version: 1, participants: [], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };

test('Adding a placeholder normalizes optional email and reports the accepted unlinked outcome without sending', async () => {
  let next = 0;
  const request = personRequest('  Asha  ', '  Asha@Example.test ', null, () => String(++next));
  const calls: unknown[] = [];
  const result = await addPerson(group.id, request, async (path, body) => { calls.push({ path, body }); return { id: group.id, version: 2, linked_participant_ids: [] }; });
  assert.deepEqual(result, { linked: false, linkedParticipantIds: [] });
  assert.deepEqual(calls, [{ path: '/participants', body: { command_id: '1', id: '2', name: 'Asha', email: 'asha@example.test' } }]);
  assert.equal(personRequest('No email', '', null, () => 'id').email, '');
  assert.throws(() => personRequest(' ', '', null, () => 'id'), /Enter a name/);
  assert.throws(() => personRequest('Asha', 'wrong address', null, () => 'id'), /valid email/);
});

test('Lost add acknowledgement retries identical command and participant IDs', async () => {
  let next = 0;
  const request = personRequest('Asha', 'asha@example.test', null, () => String(++next));
  const bodies: unknown[] = [];
  await assert.rejects(addPerson(group.id, request, async (_, body) => { bodies.push(body); throw new Error('Response lost'); }), /Response lost/);
  const retry = personRequest(' Asha ', 'ASHA@example.test', request, () => { throw new Error('Must retain identity'); });
  await addPerson(group.id, retry, async (_, body) => { bodies.push(body); return { id: group.id, version: 2, linked_participant_ids: [] }; });
  assert.equal(retry, request); assert.deepEqual(bodies, [request, request]);
  for (const result of [{}, { id: 'another-group', version: 2 }, { id: group.id, version: 0 }]) await assert.rejects(addPerson(group.id, retry, async () => result), /Sync and check/);
});

test('Adding an existing account reports only a validated link for the requested person', async () => {
  const request = personRequest('Asha', 'asha@example.test', null, () => 'person-id');
  assert.deepEqual(await addPerson(group.id, request, async () => ({ id: group.id, version: 2, linked_participant_ids: [request.id] })),
    { linked: true, linkedParticipantIds: [request.id] });
  for (const linked_participant_ids of [undefined, null, 'person-id', [1], ['different-person'], [request.id, request.id]]) {
    await assert.rejects(addPerson(group.id, request, async () => ({ id: group.id, version: 2, linked_participant_ids })), /Sync and check/);
  }
});

test('Invitation retries are bound to the exact person and saved email', () => {
  const previous = { personId: 'asha', email: 'asha@example.test', id: 'lost-response-command' };
  assert.equal(emailInvitationRequest('asha', previous.email, previous, undefined, () => 'new'), previous);
  assert.equal(emailInvitationRequest('kabir', previous.email, previous, undefined, () => 'new').id, 'new');
  assert.equal(emailInvitationRequest('asha', 'other@example.test', previous, undefined, () => 'new').id, 'new');
  const failed = { id: 'failed-command', participant_id: 'asha', intended_email: previous.email, send_state: 'failed', revoked: false, approved: false, claimant_id: null, claimant_email: null };
  assert.equal(emailInvitationRequest('asha', previous.email, undefined, failed, () => 'new').id, 'failed-command');
  assert.equal(emailInvitationRequest('asha', previous.email, undefined, { ...failed, send_state: 'sent' }, () => 'new').id, 'new');
});

test('Only an active invitation for the exact saved email supplies a retry identity', () => {
  const invitation = { id: 'current', participant_id: 'asha', intended_email: 'asha@example.test', send_state: 'sent', revoked: false, approved: false, claimant_id: null, claimant_email: null, expires_at: new Date(Date.now() + 60_000).toISOString() };
  const invites = [invitation, { ...invitation, id: 'revoked', revoked: true }, { ...invitation, id: 'approved', approved: true }, { ...invitation, id: 'expired', expires_at: '2020-01-01T00:00:00Z' }, { ...invitation, id: 'other', participant_id: 'kabir' }, { ...invitation, id: 'old-email', intended_email: 'old@example.test' }];
  assert.equal(currentEmailInvite({ ...group, invites }, 'asha', invitation.intended_email)?.id, 'current');
  assert.equal(currentEmailInvite({ ...group, invites }, 'asha', ''), undefined);
});

test('Explicit sending reports only the matching accepted provider state', async () => {
  const request = { personId: 'asha', email: 'asha@example.test', id: 'email-command' }, calls: unknown[] = [];
  for (const state of ['sent', 'failed', 'sending']) {
    const result = await sendInvitation(group.id, request, async (path, body) => { calls.push({ path, body }); return { id: group.id, version: 3, linked_participant_ids: [], invite: { id: request.id, state, retry_after: 60 } }; });
    assert.equal(result.state, state); assert.equal(result.retryAfter, 60); assert.equal(result.linked, false);
  }
  assert.deepEqual(calls, Array(3).fill({ path: '/participants/asha/email-invite', body: { command_id: 'email-command' } }));
  for (const result of [{}, { id: group.id, version: 3, linked_participant_ids: [] }, { id: group.id, version: 3, linked_participant_ids: [], invite: { id: 'other-command', state: 'sent' } }, { id: group.id, version: 3, linked_participant_ids: [], invite: { id: request.id, state: 'success' } }]) await assert.rejects(sendInvitation(group.id, request, async () => result), /Sync and check/);
});

test('Explicit Send can link the now-existing account without fabricating a delivery receipt', async () => {
  const request = { personId: 'asha', email: 'asha@example.test', id: 'email-command' };
  const result = await sendInvitation(group.id, request, async () => ({ id: group.id, version: 3, linked_participant_ids: ['asha'] }));
  assert.deepEqual(result, { linked: true, linkedParticipantIds: ['asha'], state: 'linked', retryAfter: 0 });
  for (const reply of [
    { linked_participant_ids: [] },
    { linked_participant_ids: ['other'] },
    { linked_participant_ids: ['asha'], invite: { id: request.id, state: 'sent' } },
    { linked_participant_ids: [], invite: { id: 'other-command', state: 'sent' } },
  ]) await assert.rejects(sendInvitation(group.id, request, async () => ({ id: group.id, version: 3, ...reply })), /Sync and check/);
});

test('Saving an existing contact addresses only that participant and requires a matching accepted group receipt', async () => {
  const calls: unknown[] = [], body = { command_id: 'contact-command', email: 'asha@example.invalid' };
  await saveContact(group.id, 'existing-person', body, async (path, payload) => { calls.push({ path, payload }); return { id: group.id, version: 2 }; });
  assert.deepEqual(calls, [{ path: '/participants/existing-person/contact', payload: body }]);
  for (const result of [{}, { id: 'other', version: 2 }, { id: group.id, version: 0 }]) await assert.rejects(saveContact(group.id, 'existing-person', body, async () => result), /Sync and check/);
});
