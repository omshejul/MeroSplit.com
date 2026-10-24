import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { accountOwner, ApiError, request } from '../src/api.ts';
import { consentToPush, dismissReadPushes, emptyPushPreferences, notificationForAccount, notificationTarget, pushPermission, refreshPushDevice, unregisterPushDevice } from '../src/notifications.ts';
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
const membership = { type: 'group_membership', recipient_user_id: '1', group_id: groupId, event_id: `membership:${installation}:1` };
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
    calls.push(`${method} ${path}`); assert.equal(active, session); assert.deepEqual(body, { ...device, bill_chat: true }); assert.equal(writes.length, 1);
    return { id: installation, enabled: true } as T;
  };
  const result = await refreshPushDevice(session, consent, 'granted', async () => device, save, send);
  assert.deepEqual(result.binding, device); assert.equal(writes.length, 2);
  assert.deepEqual(calls, [`PUT /me/push-devices/${installation}`]);
  const newer = { ...device, token: 'ExpoPushToken[rotated]' };
  await refreshPushDevice(session, result, 'granted', async () => newer, save, async <T>(_active: Session, _path: string, _method?: string, body?: unknown): Promise<T> => {
    assert.deepEqual(body, { ...newer, bill_chat: true }); return { id: installation, enabled: true } as T;
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

test('Permission revocation preserves confirmed choice until unregister acknowledgment and never fetches another token', async () => {
  const writes: PushPreferences[] = [], save = async (value: PushPreferences) => { writes.push(value); };
  const send: typeof request = async <T>(_active: Session, path: string, method?: string): Promise<T> => {
    assert.equal(path, `/me/push-devices/${installation}`); assert.equal(method, 'DELETE');
    assert.equal(writes[0].opted_in, true); assert.equal(writes[0].pending_off, true); assert.deepEqual(writes[0].binding, device);
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
  assert.equal(stored.opted_in, true); assert.equal(stored.pending_off, true); assert.equal(stored.owner, accountOwner(session)); assert.deepEqual(stored.binding, device);
  const expired: typeof request = async <T>(): Promise<T> => { throw new ApiError(401, 'Session expired'); };
  assert.deepEqual(await unregisterPushDevice(session, stored, save, expired), initial);
  const other = { ...session, userId: '2' };
  const consent = await consentToPush(other, stored, save); assert.equal(consent.owner, accountOwner(other)); assert.equal(consent.binding, null);
});

test('Push taps fetch only the authorized current-account group and select an existing bill', async () => {
  const send: typeof request = async <T>(active: Session, path: string, method = 'GET'): Promise<T> => {
    assert.equal(active, session); assert.equal(path, `/groups/${groupId}/summary`); assert.equal(method, 'GET'); return group as T;
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

test('Membership taps fetch one authorized summary and never select, fetch or acknowledge a bill', async () => {
  const summary = { ...group, read_mode: 'summary' as const, expenses: [] };
  const paths: string[] = [];
  const send: typeof request = async <T>(active: Session, path: string, method = 'GET', body?: unknown): Promise<T> => {
    assert.equal(active, session); assert.equal(method, 'GET'); assert.equal(body, undefined);
    paths.push(path); return summary as T;
  };
  assert.equal(notificationForAccount(session, membership), true);
  assert.deepEqual(await notificationTarget(session, membership, send), { group: summary, expenseId: null });
  assert.deepEqual(paths, [`/groups/${groupId}/summary`]);
  await dismissReadPushes(session, [{ identifier: 'membership', data: membership }],
    async () => assert.fail('Membership is not a bill-read prompt'),
    async () => assert.fail('Membership must not query any bill/chat read feed'));
});

test('Membership payload account, event, group and shape are validated before any request', async () => {
  const invalid = [null, [], {}, { ...membership, recipient_user_id: '2' }, { ...membership, recipient_user_id: 1 },
    { ...membership, group_id: '../account' }, { ...membership, group_id: null }, { ...membership, event_id: null },
    { ...membership, event_id: `membership:${installation}:2` }, { ...membership, event_id: `membership:${installation}:01` },
    { ...membership, event_id: `membership:${installation}:1:extra` }, { ...membership, event_id: `membership:invalid:1` },
    { ...membership, event_id: `MEMBERSHIP:${installation}:1` }, { ...membership, type: 'membership' },
    { ...membership, expense_id: expenseId }, { ...membership, bank_verified: true }];
  const send: typeof request = async () => assert.fail('Invalid membership payload must not contact the server');
  for (const payload of invalid) {
    assert.equal(notificationForAccount(session, payload), false);
    assert.equal(await notificationTarget(session, payload, send), null);
  }
  assert.equal(notificationForAccount(null, membership), false);
  assert.equal(notificationForAccount({ ...session, userId: '2' }, membership), false);
});

test('Membership taps fail closed when access is revoked, offline or the summary identifies another group', async () => {
  for (const error of [new ApiError(401, 'Expired'), new ApiError(404, 'No membership'), new Error('offline')]) {
    let requests = 0;
    assert.equal(await notificationTarget(session, membership, async () => { requests++; throw error; }), null);
    assert.equal(requests, 1);
  }
  assert.equal(await notificationTarget(session, membership, async <T>() => ({ ...group, id: installation }) as T), null);
});


test('A push for an older bill loads one pinned detail without downloading all history', async () => {
  const summary = { ...group, read_mode: 'summary' as const, version: 7, expenses: [] };
  const detail = { ...group.expenses[0], group_id: groupId, group_version: 7 };
  const paths: string[] = [];
  const send: typeof request = async <T>(_active: Session, path: string): Promise<T> => { paths.push(path); return (path.endsWith('/summary') ? summary : detail) as T; };
  const target = await notificationTarget(session, data, send);
  assert.equal(target?.expenseId, expenseId);
  assert.equal(target?.group.focused_expense?.id, expenseId);
  assert.deepEqual(paths, [`/groups/${groupId}/summary`, `/groups/${groupId}/expenses/${expenseId}?version=7`]);
});


test('Displayed push reconciliation dismisses only current-account read prompts and never acknowledges a bill', async () => {
  const seenId = '11111111-1111-4111-8111-111111111111', unreadId = '22222222-2222-4222-8222-222222222222';
  const shown = [
    { identifier: 'read', data: { ...data, event_id: seenId } },
    { identifier: 'unread', data: { ...data, event_id: unreadId } },
    { identifier: 'other-account', data: { ...data, event_id: seenId, recipient_user_id: '2' } },
    { identifier: 'invalid', data },
  ];
  const dismissed: string[] = [];
  const send: typeof request = async <T>(_active: Session, path: string, method = 'GET'): Promise<T> => {
    assert.equal(method, 'GET'); assert.equal(path, `/me/notifications?limit=100&expense_ids=${expenseId}`);
    return { has_more: false, notices: [{ id: unreadId }] } as T;
  };
  await dismissReadPushes(session, shown, async id => { dismissed.push(id); }, send);
  assert.deepEqual(dismissed, ['read']);
});

test('Displayed prompt reconciliation fails closed on incomplete or malformed feed and query errors', async () => {
  const shown = [{ identifier: 'keep', data: { ...data, event_id: installation } }];
  for (const response of [{ has_more: true, notices: [] }, { notices: [] }, { has_more: false }, { has_more: false, notices: [{ id: 'bad' }] }, { has_more: false, notices: [null] }]) {
    await dismissReadPushes(session, shown, async () => assert.fail('Must preserve uncertain prompts'), async <T>() => response as T);
  }
  await assert.rejects(dismissReadPushes(session, shown, async () => assert.fail('Must preserve prompts on network error'), async () => { throw Error('offline'); }), /offline/);
});

test('Displayed prompt reconciliation never dismisses an expense outside its bounded query', async () => {
  const shown = Array.from({ length: 60 }, (_, n) => ({ identifier: String(n), data: { ...data, event_id: installation, expense_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` } }));
  const dismissed: string[] = [];
  await dismissReadPushes(session, shown, async id => { dismissed.push(id); }, async <T>(_active: Session, path: string, method = 'GET'): Promise<T> => {
    assert.equal(method, 'GET'); assert.equal(new URL(`https://example.test${path}`).searchParams.get('expense_ids')?.split(',').length, 50);
    return { has_more: false, notices: [] } as T;
  });
  assert.equal(dismissed.length, 50); assert.equal(dismissed.at(-1), '49');
});


test('Explicit Push enable cancels a failed disable intent before registering again', async () => {
  let stored: PushPreferences = { ...registered, pending_off: true };
  const save = async (value: PushPreferences) => { stored = value; };
  const consent = await consentToPush(session, stored, save);
  assert.equal(consent.pending_off, false);
  const calls: string[] = [];
  const send: typeof request = async <T>(_session: Session, _path: string, method?: string): Promise<T> => { calls.push(method || 'GET'); return { id: installation, enabled: true } as T; };
  await refreshPushDevice(session, consent, 'granted', async () => device, save, send);
  assert.deepEqual(calls, ['PUT']); assert.deepEqual(stored.binding, device);
});


test('A failed native token refresh invalidates availability, including token rotation', async () => {
  const source = ts.createSourceFile('PushSettings.tsx', readFileSync(new URL('../src/PushSettings.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration = '';
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'refreshNow') declaration = node.getText(source); ts.forEachChild(node, visit); }
  visit(source); assert.ok(declaration);
  let verified = true;
  const env = { activeSession: { current: session }, state: async () => registered, mounted: { current: true }, setPermission() {}, setVerified: (value: boolean) => { verified = value; }, Notifications: { getPermissionsAsync: async () => ({ status: 'granted' }) }, pushPermission, refreshPushDevice: async () => { throw Error('Registry unavailable'); }, save() {} };
  const refresh = new Function('env', `with(env){${ts.transpile(declaration, { target: ts.ScriptTarget.ES2022 })};return refreshNow;}`)(env);
  await assert.rejects(refresh({ type: 'ios', data: 'synthetic-rotated' }), /Registry unavailable/);
  assert.equal(verified, false);
});
