import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Session } from '../src/types.ts';

const baseUrl = 'https://merosplit.test';
const old: Session = { baseUrl, userId: '1', email: 'old@example.invalid', token: 'old-native-session', displayName: 'Old' };
const fresh: Session = { baseUrl, userId: '2', email: 'fresh@example.invalid', token: 'fresh-native-session', displayName: 'Fresh' };
const first = { id: '11111111-1111-4111-8111-111111111111', proof: 'a'.repeat(43) };
const second = { id: '22222222-2222-4222-8222-222222222222', proof: 'b'.repeat(43) };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(done => setImmediate(done));

// Extract named production functions, not a test-side reconstruction of their
// control flow. Only platform/storage/network/render boundaries are supplied.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['beginEmailLink', 'restore', 'finishEmailLink', 'openEmailTarget', 'finishSignIn'];
const declarations: string[] = [];
function collect(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')) declarations.push(node.getText(source));
  ts.forEachChild(node, collect);
}
collect(source);
assert.equal(declarations.length, names.length, 'each named production lifecycle function must exist exactly once');
const compiled = ts.transpile(declarations.join('\n'), { target: ts.ScriptTarget.ES2022 });
type Entry = { id: string; phase: string; error: string; sent: boolean; target?: unknown };
type Result = { session: Session; needsName: boolean; target: { kind: 'home' } | { kind: 'group'; group_id: string } };
type Calls = { beginEmailLink: (link: typeof first) => void; restore: () => Promise<void>; finishEmailLink: (entry: Entry, epoch: number) => Promise<void>; openEmailTarget: (active: Session, target: Result['target'], epoch: number) => Promise<void>; finishSignIn: () => Promise<void> };
function harness() {
  const events: string[] = [], resolved: unknown[][] = [], scopedWrites: { owner: string; id: string }[] = [];
  const state = { persisted: old as Session | null, session: old as Session | null, entry: null as Entry | null, ready: false, paused: false, groupId: null as string | null, screen: '', tab: '', storageError: '', result: { session: fresh, needsName: false, target: { kind: 'home' } } as Result };
  const ref = <T>(current: T) => ({ current });
  const env: Record<string, any> = {
    Platform: { OS: 'android' }, API_URL: baseUrl, authEpoch: ref(0), authHeldRef: ref(false), activeSessionRef: ref(old),
    emailProof: ref(null), emailEntryRef: ref(null), cookieCheck: ref(false), initialEmailLink: ref(null), validatedBrowserSession: ref(''), draftWrites: ref(Promise.resolve()),
    challenge: { challengeId: 'qa-code' }, email: fresh.email, code: '0000',
    pauseAccountRequests: async () => { state.paused = true; events.push('pause'); },
    resumeAccountRequests: () => { state.paused = false; events.push('resume'); },
    savedSession: async () => state.persisted,
    saveSession: async (value: Session) => { events.push(`persist:${value.userId}`); state.persisted = value; },
    getDatabase: async () => ({}), retireSyncPause: async () => {},
    resolveNativeEmailLink: async (...args: unknown[]) => { events.push('resolve'); resolved.push(args); return state.result; },
    resolveEmailLink: () => { throw Error('Native flow must not use browser cookie auth'); },
    push: { clear: async () => { events.push('clear-push'); } },
    clearMediaPreviews: async () => { events.push('clear-media'); },
    endPushSession: async () => { events.push('end-old-session'); },
    changeScope: (value: Session | null) => { events.push(`adopt:${value?.userId}`); state.session = value; env.activeSessionRef.current = value; },
    readProfile: async (value: Session) => { events.push(`profile:${value.userId}`); return { display_name: value.displayName }; },
    fetchGroup: async (_value: Session, id: string) => ({ id, is_direct: false }),
    accountOwner: (value: Session) => `${value.baseUrl}|${value.userId}`,
    saveGroup: async (_db: unknown, owner: string, group: { id: string }) => { scopedWrites.push({ owner, id: group.id }); },
    load: async (owner: string) => { events.push(`load:${owner}`); },
    forgetEmailProof: () => { events.push('forget-proof'); },
    setEmailEntry: (value: Entry | null) => { state.entry = value; },
    setReady: (value: boolean) => { state.ready = value; },
    setStorageError: (value: string) => { state.storageError = value; },
    setGroupId: (value: string) => { state.groupId = value; }, setScreen: (value: string) => { state.screen = value; }, setTab: (value: string) => { state.tab = value; },
    setSession: (value: Session) => { state.session = value; }, setCheckingCookie: () => {}, setAppLink: () => {}, setPushTarget: () => {}, setEmail: () => {}, setChallenge: () => {}, setCode: () => {}, setEmailRequested: () => {}, setExpenseId: () => {},
    confirmEmailCode: async () => fresh, syncAccount: async (value: Session) => { events.push(`sync:${value.userId}`); },
  };
  Object.defineProperty(env, 'session', { get: () => state.session });
  const api = new Function('env', `with (env) { ${compiled}; return { ${names.join(',')} }; }`)(env) as Calls;
  const begin = () => { api.beginEmailLink(first); return { entry: state.entry!, epoch: env.authEpoch.current as number }; };
  return { env, state, events, resolved, scopedWrites, api, begin };
}

test('cold native link before SecureStore hydration retains old identity but leaves it inactive and paused', async () => {
  const h = harness(), hydrated = deferred<Session>(); h.state.session = null; h.env.activeSessionRef.current = null;
  h.env.savedSession = () => hydrated.promise;
  const restoring = h.api.restore(); h.begin(); hydrated.resolve(old); await restoring;
  assert.equal(h.state.ready, true); assert.equal(h.state.persisted, old); assert.equal(h.state.session, old);
  assert.equal(h.env.activeSessionRef.current, null); assert.equal(h.state.paused, true); assert.equal(h.state.entry?.id, first.id);
  assert.equal(h.events.includes('end-old-session'), false); assert.equal(h.events.some(value => value.startsWith('sync:')), false);
});

test('native resolution waits for the account request drain and all pending draft writes', async () => {
  const h = harness(), { entry, epoch } = h.begin(), drain = deferred<void>(), drafts = deferred<void>();
  h.env.pauseAccountRequests = () => drain.promise; h.env.draftWrites.current = drafts.promise;
  const finishing = h.api.finishEmailLink(entry, epoch); await tick(); assert.equal(h.resolved.length, 0);
  drain.resolve(); await tick(); assert.equal(h.resolved.length, 0);
  drafts.resolve(); await finishing;
  assert.equal(h.resolved.length, 1); assert.equal(h.resolved[0][3], old, 'resolver receives the hydrated old native session');
  assert.equal(h.state.session, fresh); assert.ok(h.events.indexOf('persist:2') < h.events.indexOf('clear-push'));
  assert.equal(h.events.includes('end-old-session'), false, 'email exchange owns old-session revocation; never delete the new session');
});

test('superseded native resolver result cannot persist or adopt the older target', async () => {
  const h = harness(), { entry, epoch } = h.begin(), response = deferred<Result>();
  h.env.resolveNativeEmailLink = () => response.promise;
  const finishing = h.api.finishEmailLink(entry, epoch); await tick(); h.api.beginEmailLink(second); response.resolve(h.state.result); await finishing;
  assert.equal(h.state.persisted, old); assert.equal(h.state.session, old); assert.equal(h.env.activeSessionRef.current, null);
  assert.equal(h.state.entry?.id, second.id); assert.equal(h.events.includes('clear-push'), false); assert.equal(h.state.paused, true);
});

test('supersession during SecureStore save keeps new token recoverable without adopting its stale UI', async () => {
  const h = harness(), { entry, epoch } = h.begin(), saved = deferred<void>(), started = deferred<void>();
  h.env.saveSession = async (value: Session) => { started.resolve(); await saved.promise; h.state.persisted = value; };
  const finishing = h.api.finishEmailLink(entry, epoch); await started.promise; h.api.beginEmailLink(second); saved.resolve(); await finishing;
  assert.equal(h.state.persisted, fresh, 'successful token write remains available to the next transition');
  assert.equal(h.state.session, old); assert.equal(h.env.activeSessionRef.current, null); assert.equal(h.state.entry?.id, second.id);
  assert.equal(h.events.includes('clear-push'), false); assert.equal(h.state.paused, true);
});

test('supersession during push cleanup cannot resume requests or open the previous destination', async () => {
  const h = harness(), { entry, epoch } = h.begin(), cleared = deferred<void>(), started = deferred<void>();
  h.env.push.clear = async () => { assert.equal(h.state.persisted, fresh); started.resolve(); await cleared.promise; };
  const finishing = h.api.finishEmailLink(entry, epoch); await started.promise; h.api.beginEmailLink(second); cleared.resolve(); await finishing;
  assert.equal(h.state.session, old); assert.equal(h.state.entry?.id, second.id); assert.equal(h.state.paused, true);
  assert.equal(h.events.includes('adopt:2'), false); assert.equal(h.events.includes('profile:2'), false);
});

test('correct existing native session resumes exact canonical target without clearing push preference or moving old owner data', async () => {
  const h = harness(), { entry, epoch } = h.begin(); h.state.result = { session: old, needsName: false, target: { kind: 'group', group_id: 'canonical-target' } };
  await h.api.finishEmailLink(entry, epoch);
  assert.equal(h.events.includes('clear-push'), false); assert.equal(h.events.includes('end-old-session'), false);
  assert.equal(h.state.groupId, 'canonical-target'); assert.equal(h.state.screen, 'group'); assert.equal(h.state.entry, null);
  assert.deepEqual(h.scopedWrites, [{ owner: `${baseUrl}|1`, id: 'canonical-target' }]);
});

test('new unnamed recipient gets only Name; a named recipient writes its target solely under its own owner', async () => {
  const unnamed = harness(), a = unnamed.begin(); unnamed.state.result = { session: fresh, needsName: true, target: { kind: 'group', group_id: 'new-target' } };
  await unnamed.api.finishEmailLink(a.entry, a.epoch);
  assert.equal(unnamed.state.entry?.phase, 'name'); assert.equal(unnamed.env.activeSessionRef.current, fresh); assert.equal(unnamed.state.paused, false);
  assert.equal(unnamed.scopedWrites.length, 0); assert.equal(unnamed.events.includes('profile:2'), false);
  const named = harness(), b = named.begin(); named.state.result = { session: fresh, needsName: false, target: { kind: 'group', group_id: 'new-target' } };
  await named.api.finishEmailLink(b.entry, b.epoch);
  assert.deepEqual(named.scopedWrites, [{ owner: `${baseUrl}|2`, id: 'new-target' }]);
  assert.equal(named.state.groupId, 'new-target'); assert.equal(named.state.entry, null);
  assert.equal(named.events.some(value => value.startsWith(`load:${baseUrl}|1`)), false);
});

test('late canonical group fetch cannot navigate over a newer incoming link', async () => {
  const h = harness(), page = deferred<{ id: string; is_direct: boolean }>(); h.env.fetchGroup = () => page.promise;
  const opening = h.api.openEmailTarget(old, { kind: 'group', group_id: 'old-target' }, 0); await tick();
  h.api.beginEmailLink(second); page.resolve({ id: 'old-target', is_direct: false }); await opening;
  assert.equal(h.state.groupId, null); assert.equal(h.scopedWrites.length, 0); assert.equal(h.state.entry?.id, second.id);
});

test('native OTP response superseded by an email link never revokes, persists or adopts its result', async () => {
  const h = harness(), response = deferred<Session>(); h.env.confirmEmailCode = () => response.promise;
  const confirming = h.api.finishSignIn(); await tick(); h.api.beginEmailLink(second); response.resolve(fresh); await confirming;
  assert.equal(h.state.persisted, old); assert.equal(h.state.session, old); assert.equal(h.state.entry?.id, second.id);
  assert.equal(h.events.includes('end-old-session'), false); assert.equal(h.events.some(value => value.startsWith('sync:')), false);
});

test('SecureStore failure retains the old session and push binding instead of claiming a successful switch', async () => {
  const h = harness(), { entry, epoch } = h.begin(); h.env.saveSession = async () => { throw Error('Synthetic SecureStore failure'); };
  await assert.rejects(h.api.finishEmailLink(entry, epoch), /SecureStore failure/);
  assert.equal(h.state.persisted, old); assert.equal(h.state.session, old); assert.equal(h.env.activeSessionRef.current, null);
  assert.equal(h.events.includes('clear-push'), false); assert.equal(h.events.includes('end-old-session'), false);
  assert.equal(h.state.paused, true); assert.equal(h.env.emailProof.current.proof, first.proof);
});

test('duplicate cold/warm link does not restart an opening or completed Name transition', async () => {
  const h = harness(), { entry, epoch } = h.begin();
  h.api.beginEmailLink({ ...first }); assert.equal(h.env.authEpoch.current, epoch);
  h.state.result = { session: fresh, needsName: true, target: { kind: 'home' } };
  await h.api.finishEmailLink(entry, epoch); const after = [...h.events];
  h.api.beginEmailLink({ ...first });
  assert.equal(h.env.authEpoch.current, epoch); assert.equal(h.state.entry?.phase, 'name');
  assert.deepEqual(h.events, after); assert.equal(h.state.paused, false);
});

test('native OTP SecureStore failure never revokes the old session or clears its push binding', async () => {
  const h = harness(); h.env.saveSession = async () => { throw Error('Synthetic OTP SecureStore failure'); };
  await assert.rejects(h.api.finishSignIn(), /OTP SecureStore failure/);
  assert.equal(h.state.persisted, old); assert.equal(h.state.session, old);
  assert.equal(h.events.includes('end-old-session'), false); assert.equal(h.events.includes('clear-push'), false);
  assert.equal(h.events.some(value => value.startsWith('sync:')), false);
});

test('native OTP persists its new token before revoking the old session and adopting the new account', async () => {
  const h = harness();
  h.env.endPushSession = async (active: Session) => {
    assert.equal(active, old); assert.equal(h.state.persisted, fresh);
    assert.equal(h.state.session, old, 'UI adoption waits for old-session cleanup');
    h.events.push('end-old-session');
  };
  await h.api.finishSignIn();
  assert.ok(h.events.indexOf('persist:2') < h.events.indexOf('end-old-session'));
  assert.ok(h.events.indexOf('end-old-session') < h.events.indexOf('adopt:2'));
  assert.equal(h.state.persisted, fresh); assert.equal(h.state.session, fresh);
  assert.equal(h.events.at(-1), 'sync:2');
});
