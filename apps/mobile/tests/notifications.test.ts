import test from 'node:test';
import assert from 'node:assert/strict';
import { accountOwner, ApiError, request } from '../src/api.ts';
import { consentToPush, emptyPushPreferences, notificationForAccount, notificationTarget, pushPermission, refreshPushDevice, unregisterPushDevice } from '../src/notifications.ts';
import type { PushDevice, PushPreferences } from '../src/notifications.ts';
import type { Group, Session } from '../src/types.ts';

const session: Session = { baseUrl: 'https://example.test', userId: '1', email: 'qa@example.test', token: 'synthetic' };
const installation = '4b8f5680-c7c4-45ec-8a2f-842fb5854090';
const device: PushDevice = { provider: 'expo', platform: 'ios', token: 'ExpoPushToken[synthetic-private-token]' };
const initial = emptyPushPreferences(installation);
const opted = { ...initial, owner: accountOwner(session), opted_in: true };
const registered = { ...opted, binding: device };
const groupId = 'e8ba5bee-0f17-42a5-b46f-0e4f27b07260', expenseId = '13dc400e-268e-4ab3-a905-08b357ca7850';
const data = { type: 'new_bill', recipient_user_id: '1', group_id: groupId, expense_id: expenseId, event_id: 'synthetic-event' };
const group: Group = { id: groupId, name: 'Synthetic trip', version: 1, participants: [], expenses: [{ id: expenseId, version: 1, description: 'Dinner', total: '100', paid: {}, shares: {}, split: { mode: 'equal', values: {} }, date: '2026-10-17', category: 'general', notes: '', deleted: false }], settlements: [], balances: {}, transfers: [], activity: [] };

test('Notification permissions interpret iOS granular authorization and Android status', () => {
  for (const status of [2, 3, 4]) assert.equal(pushPermission({ status: 'denied', ios: { status } }), 'granted');
  assert.equal(pushPermission({ status: 'granted', canAskAgain: true, ios: { status: 1 } }), 'denied');
  assert.equal(pushPermission({ status: 'undetermined', ios: { status: 0 } }), 'ask');
  assert.equal(pushPermission({ status: 'granted' }), 'granted');
  assert.equal(pushPermission({ status: 'denied' }), 'denied');
  assert.equal(pushPermission({ status: 'undetermined' }), 'ask');
});

test('Android denial before the first system prompt remains requestable, while a blocked denial opens settings', () => {
  // SDK58 can return denied before POST_NOTIFICATIONS has ever been requested.
  const response = { status: 'denied', granted: false, canAskAgain: true, expires: 'never', android: { importance: 0, interruptionFilter: 1 } };
  assert.equal(pushPermission(response), 'ask');
  assert.equal(pushPermission({ ...response, canAskAgain: false }), 'denied');
});

test('Fresh and switched accounts never obtain a token or inherit another account consent', async () => {
  let tokens = 0, requests = 0, saved: PushPreferences = initial;
  const getDevice = async () => { tokens++; return device; };
  const send: typeof request = async <T>(): Promise<T> => { requests++; throw new Error('Must not contact provider or registry'); };
  const save = async (value: PushPreferences) => { saved = value; };
  await refreshPushDevice(session, initial, 'granted', getDevice, save, send);
  assert.deepEqual(saved, initial);
  await refreshPushDevice({ ...session, userId: '2' }, registered, 'granted', getDevice, save, send);
  assert.deepEqual(saved, initial); assert.equal(tokens, 0); assert.equal(requests, 0);
  await refreshPushDevice({ ...session, baseUrl: 'https://other.test' }, registered, 'granted', getDevice, save, send);
  assert.deepEqual(saved, initial);
});

test('Consent is persisted before registration, and only confirmed current-token registration becomes a binding', async () => {
  const writes: PushPreferences[] = [], calls: string[] = [];
  const save = async (value: PushPreferences) => { writes.push(structuredClone(value)); };
  const consent = await consentToPush(session, initial, save);
  assert.equal(writes[0].opted_in, true); assert.equal(writes[0].binding, null);
  const send: typeof request = async <T>(active: Session, path: string, method?: string, body?: unknown): Promise<T> => {
    calls.push(`${method} ${path}`); assert.equal(active, session); assert.deepEqual(body, device); assert.equal(writes.length, 1);
    return { id: installation, enabled: true } as T;
  };
  const result = await refreshPushDevice(session, consent, 'granted', async () => device, save, send);
  assert.deepEqual(result.binding, device); assert.equal(writes.length, 2);
  assert.deepEqual(calls, [`PUT /me/push-devices/${installation}`]);
  const newer = { ...device, token: 'ExpoPushToken[rotated]' };
  await refreshPushDevice(session, result, 'granted', async () => newer, save, async <T>(_active: Session, _path: string, _method?: string, body?: unknown): Promise<T> => {
    assert.deepEqual(body, newer); return { id: installation, enabled: true } as T;
  });
  assert.deepEqual(writes.at(-1)?.binding, newer);
});

test('A failed registration keeps consent retryable without claiming a confirmed binding', async () => {
  const writes: PushPreferences[] = [], save = async (value: PushPreferences) => { writes.push(value); };
  const failed: typeof request = async <T>(): Promise<T> => { throw new Error('Registry offline'); };
  await assert.rejects(refreshPushDevice(session, opted, 'granted', async () => device, save, failed), /Registry offline/);
  assert.equal(writes.length, 0); assert.equal(opted.binding, null);
  await assert.rejects(refreshPushDevice(session, opted, 'granted', async () => ({ ...device, token: 'raw-apns-token' }), save, failed), /unavailable/);
});

test('Permission revocation opts out before unregistering and never fetches another token', async () => {
  const writes: PushPreferences[] = [], save = async (value: PushPreferences) => { writes.push(value); };
  const send: typeof request = async <T>(_active: Session, path: string, method?: string): Promise<T> => {
    assert.equal(path, `/me/push-devices/${installation}`); assert.equal(method, 'DELETE');
    assert.equal(writes[0].opted_in, false); assert.deepEqual(writes[0].binding, device);
    return { removed: true } as T;
  };
  const result = await refreshPushDevice(session, registered, 'denied', async () => { throw new Error('No token call when denied'); }, save, send);
  assert.deepEqual(result, initial); assert.equal(writes.length, 2);
});

test('Offline unregister retains the retry identity, expired session401 safely clears it, and a new account must consent again', async () => {
  let stored: PushPreferences = registered;
  const save = async (value: PushPreferences) => { stored = value; };
  const offline: typeof request = async <T>(): Promise<T> => { throw new Error('Unregister offline'); };
  await assert.rejects(unregisterPushDevice(session, registered, save, offline), /Unregister offline/);
  assert.equal(stored.opted_in, false); assert.equal(stored.owner, accountOwner(session)); assert.deepEqual(stored.binding, device);
  const expired: typeof request = async <T>(): Promise<T> => { throw new ApiError(401, 'Session expired'); };
  assert.deepEqual(await unregisterPushDevice(session, stored, save, expired), initial);
  const other = { ...session, userId: '2' };
  const consent = await consentToPush(other, stored, save); assert.equal(consent.owner, accountOwner(other)); assert.equal(consent.binding, null);
});

test('Push taps fetch only the authorized current-account group and select an existing bill', async () => {
  const send: typeof request = async <T>(active: Session, path: string, method = 'GET'): Promise<T> => {
    assert.equal(active, session); assert.equal(path, `/groups/${groupId}`); assert.equal(method, 'GET'); return group as T;
  };
  assert.deepEqual(await notificationTarget(session, data, send), { group, expenseId });
  const missing = { ...group, expenses: [] };
  assert.deepEqual(await notificationTarget(session, data, async <T>(): Promise<T> => missing as T), { group: missing, expenseId: null });
  const deleted = { ...group, expenses: [{ ...group.expenses[0], deleted: true }] };
  assert.deepEqual(await notificationTarget(session, data, async <T>(): Promise<T> => deleted as T), { group: deleted, expenseId: null });
});

test('Wrong-account, malformed, revoked and unavailable push taps safely fall back without arbitrary navigation', async () => {
  let requests = 0;
  const denied: typeof request = async <T>(): Promise<T> => { requests++; throw new ApiError(403, 'No longer a member'); };
  for (const payload of [{ ...data, recipient_user_id: '2' }, { ...data, group_id: '../account' }, { ...data, expense_id: 'https://untrusted.test' }, { ...data, type: 'arbitrary-link' }, null]) {
    assert.equal(await notificationTarget(session, payload, denied), null);
  }
  assert.equal(requests, 0); assert.equal(await notificationTarget(session, data, denied), null); assert.equal(requests, 1);
  assert.equal(notificationForAccount(null, data), false); assert.equal(notificationForAccount(session, { ...data, recipient_user_id: '2' }), false);
  assert.equal(notificationForAccount(session, data), true);
});
