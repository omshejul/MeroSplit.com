import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { confirmEmailCode, endSession, accountOwner } from '../src/api.ts';
import type { Session } from '../src/types.ts';

const baseUrl = 'https://merosplit.test';
const old: Session = { baseUrl, userId: '1', email: 'old@example.invalid', token: 'synthetic-old' };
const fresh: Session = { baseUrl, userId: '2', email: 'new@example.invalid', token: 'synthetic-new' };
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['finishSignIn', 'endPushSession', 'changeScope'], declarations: string[] = [];
function collect(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')) declarations.push(node.getText(source));
  ts.forEachChild(node, collect);
}
collect(source);
assert.equal(declarations.length, names.length, 'run all three actual App functions, including current changeScope');
const compiled = ts.transpile(declarations.join('\n'), { target: ts.ScriptTarget.ES2022 });
const tick = () => new Promise<void>(done => setImmediate(done));

function harness(active: Session | null = old, target = fresh) {
  const events: string[] = [], view: Record<string, unknown> = { groups: ['old-private-group'], commands: ['old-pending-command'], draft: 'old-private-draft' };
  const state = { persisted: active, session: active }, ref = <T>(current: T) => ({ current });
  const env: Record<string, any> = {
    Platform: { OS: 'ios' }, API_URL: baseUrl, challenge: { challengeId: 'synthetic-challenge' }, email: target.email, code: '0000',
    authEpoch: ref(0), authHeldRef: ref(false), activeSessionRef: ref(active), draftWrites: ref(Promise.resolve()),
    validatedBrowserSession: ref(''), emailEntryRef: ref(null), ownerRef: ref(active ? accountOwner(active) : ''),
    publishedStorage: ref({ scope: 'old-scope', view: 'old-view', changes: 'old-revision' }), loadGeneration: ref(7),
    googleReturn: ref(null), activityOwner: ref('old-activity'), groupVersions: ref('old-group-versions'),
    confirmEmailCode, endSession, accountOwner,
    saveSession: async (value: Session) => { events.push('persist'); state.persisted = value; },
    push: { disable: async () => { events.push('disable-push'); }, clear: async () => { events.push('clear-push'); } },
    clearMediaPreviews: async () => { events.push('clear-media'); },
    setSession: (value: Session) => { events.push('adopt'); state.session = value; },
    load: async (owner: string) => { events.push(`load:${owner}`); },
    syncAccount: async (value: Session) => { events.push(`sync:${accountOwner(value)}`); },
  };
  for (const name of ['FeedbackOpen', 'UpiSetup', 'VerifiedEmptyOwner', 'EmptyChatScope', 'ShowArchived', 'ShowHidden', 'NeedsInvitation', 'Expired', 'Groups', 'Commands', 'Legacy', 'Recoveries', 'Unavailable', 'LegacySelf', 'GroupId', 'ExpenseId', 'Draft', 'Vpa', 'LastConfirmed', 'SyncProblem', 'Syncing', 'PendingFiles', 'DownloadingOwner', 'Screen', 'Tab', 'MyName', 'ReviewCommand', 'ReviewInput', 'Returns', 'ReturnAttemptId', 'SettlementId', 'Activity', 'ActivityError', 'PushTarget', 'Challenge', 'Code']) {
    env[`set${name}`] = (value: unknown) => { view[name[0].toLowerCase() + name.slice(1)] = value; };
  }
  Object.defineProperty(env, 'session', { get: () => state.session });
  const run = new Function('env', `with (env) { ${compiled}; return finishSignIn; }`)(env) as () => Promise<void>;
  return { env, state, view, events, target, run };
}

function network(target = fresh, logout: number | Error | Promise<Response> = 410) {
  const previous = globalThis.fetch, calls: { url: string; method: string; token: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    calls.push({ url, method, token: new Headers(init?.headers).get('X-Session-Token') });
    assert.equal(new URL(url).origin, baseUrl, 'no actual network or other backend');
    if (url.endsWith('/auth/code/confirm')) {
      assert.equal(method, 'POST');
      return Response.json({ data: { user: { id: target.userId, email: target.email } }, meta: { is_authenticated: true, session_token: target.token } });
    }
    assert.equal(url, `${baseUrl}/_allauth/app/v1/auth/session`); assert.equal(method, 'DELETE');
    if (logout instanceof Error) throw logout;
    return typeof logout === 'number' ? new Response(null, { status: logout }) : logout;
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

test('actual native endSession treats an invalid410 session as already ended', async () => {
  const n = network();
  try { await endSession(old); assert.deepEqual(n.calls.map(c => [c.method, c.token]), [['DELETE', old.token]]); }
  finally { n.restore(); }
});

test('actual App OTP persists, cleans up only old token, and adopts current account scope', async t => {
  for (const status of [200, 401, 410]) for (const target of [fresh, { ...old, token: 'synthetic-renewed' }]) await t.test(`${status}, account${target.userId}`, async () => {
    const h = harness(old, target), n = network(target, status);
    try {
      await h.run();
      assert.deepEqual(h.state.persisted, target); assert.deepEqual(h.state.session, target);
      assert.deepEqual(n.calls.map(c => [c.method, c.token]), [['POST', null], ['DELETE', old.token]]);
      assert.ok(h.events.indexOf('persist') < h.events.indexOf('disable-push'));
      assert.ok(h.events.indexOf('clear-push') < h.events.indexOf('adopt'));
      assert.equal(h.env.ownerRef.current, accountOwner(target)); assert.equal(h.env.activeSessionRef.current.token, target.token);
      assert.deepEqual(h.env.publishedStorage.current, { scope: '', view: '', changes: '' }); assert.equal(h.env.loadGeneration.current, 8);
      assert.deepEqual(h.view.groups, []); assert.deepEqual(h.view.commands, []); assert.equal(h.view.draft, null);
      assert.equal(h.env.activityOwner.current, ''); assert.equal(h.env.groupVersions.current, '');
      assert.deepEqual(h.events.slice(-2), [`load:${accountOwner(target)}`, `sync:${accountOwner(target)}`]);
    } finally { n.restore(); }
  });
});

test('403, server and network logout failures do not silently adopt the saved new session', async t => {
  for (const response of [403, 500, 503, new Error('synthetic network failure')]) await t.test(String(response), async () => {
    const h = harness(), n = network(fresh, response);
    try {
      await assert.rejects(h.run(), /Could not (sign out|connect to sign out)/);
      assert.deepEqual(h.state.persisted, fresh, 'accepted token remains recoverable'); assert.equal(h.state.session, old);
      assert.equal(h.env.ownerRef.current, accountOwner(old)); assert.equal(h.env.loadGeneration.current, 7);
      assert.deepEqual(h.env.publishedStorage.current, { scope: 'old-scope', view: 'old-view', changes: 'old-revision' });
      assert.deepEqual(h.view.groups, ['old-private-group']); assert.deepEqual(h.view.commands, ['old-pending-command']);
      assert.equal(h.events.includes('adopt'), false); assert.equal(h.events.includes('clear-push'), false);
      assert.equal(h.events.some(e => e.startsWith('sync:') || e.startsWith('load:')), false);
      assert.equal(n.calls.at(-1)?.token, old.token);
    } finally { n.restore(); }
  });
});

test('late410 cleanup cannot replace a newer account or reset its publication generation', async () => {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>(done => { resolve = done; }), h = harness(), n = network(fresh, response);
  try {
    const pending = h.run(); await tick(); assert.deepEqual(h.state.persisted, fresh);
    const newer = { ...fresh, userId: '3', token: 'synthetic-third' };
    h.env.authEpoch.current++; h.env.ownerRef.current = accountOwner(newer); h.env.activeSessionRef.current = newer; h.state.session = newer;
    h.env.loadGeneration.current = 99; h.env.publishedStorage.current = { scope: 'newer', view: 'newer', changes: 'newer' };
    resolve(new Response(null, { status: 410 })); await pending;
    assert.equal(h.state.session, newer); assert.equal(h.env.ownerRef.current, accountOwner(newer));
    assert.equal(h.env.loadGeneration.current, 99); assert.equal(h.env.publishedStorage.current.scope, 'newer');
    assert.equal(h.events.includes('adopt'), false); assert.equal(h.events.some(e => e.startsWith('sync:')), false);
    assert.equal(n.calls.at(-1)?.token, old.token, 'never revoke the newly accepted or newer account token');
  } finally { n.restore(); }
});

test('first login and same-token confirmation never delete the accepted session', async t => {
  for (const [active, target] of [[null, fresh], [old, old]] as const) await t.test(active ? 'same token' : 'first login', async () => {
    const h = harness(active, target), n = network(target);
    try { await h.run(); assert.deepEqual(h.state.session, target); assert.equal(n.calls.length, 1); assert.equal(h.events.includes('disable-push'), false); }
    finally { n.restore(); }
  });
});
