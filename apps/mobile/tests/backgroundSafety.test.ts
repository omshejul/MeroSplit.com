import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { syncOutbox, accountOwner, ApiError, request, refreshGroups } from '../src/api.ts';
import { migrate, saveGroup, enqueue, pendingCommands, reconcileGroupCache, readVisibleGroup, saveDraft, readDraft } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';

// Ported from Root's independent PR52 production-callsite/SQLite reproduction.
const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function production(name: string, env: any) {
  let found: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); }
  visit(app); assert.ok(found);
  return new Function('env', `with(env){${ts.transpile(found.getText(app), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return ${name}}`)(env);
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const session = { baseUrl: 'https://synthetic.invalid', userId: '1', email: 'fixture@example.invalid', token: 'old-synthetic-session' };
const owner = accountOwner(session);
const group: any = { id: 'g', name: 'Synthetic', version: 1, participants: [], expenses: [], settlements: [], balances: {}, transfers: [], activity: [], read_mode: 'summary', history: {}, totals: {} };
const command = (id: string): any => ({ command_id: id, group_id: 'g', base_version: 1, method: 'POST', path: '/groups/g/expenses', body: { command_id: id, id: 'expense-' + id }, state: 'pending', error: null });

for (const reenter of [false, true]) test(`actual background refresh stops later writes after session departure${reenter ? ' even if the same token returns' : ''}`, async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
  const first = gate(), release = gate(), posts: string[] = [];
  let job: Promise<unknown> | undefined;
  const env: any = { ApiError, accountOwner, getDatabase: async () => db, ownerRef: { current: owner }, scopeGeneration: { current: 0 }, activeSessionRef: { current: session }, authHeldRef: { current: false }, activeGroupRef: { current: null }, session,
    setSyncing() {}, setSyncProblem() {}, setVerifiedEmptyOwner() {}, setExpired() {}, setNeedsInvitation() {}, readProfile: async () => {}, request, syncOutbox,
    retryAccountMediaUploads: async () => { assert.fail('No media replay after departure'); }, refreshGroups, load: async () => {}, publishIfChanged: async () => {}, downloadOffline: async () => {}, setReading() {}, setNotice() {}, navigation: { ref: { getRootState: () => ({}) } } };
  for (const name of ['setFeedbackOpen', 'setUpiSetup', 'setUpiAfterSplit', 'forgetGroupInvite', 'setAppLink', 'setEmptyChatScope', 'setShowArchived', 'setShowHidden', 'setSession', 'setGroups', 'setCommands', 'setLegacy', 'setRecoveries', 'setUnavailable', 'setLegacySelf', 'setVpa', 'setLastConfirmed', 'setPendingFiles', 'setDownloadingOwner', 'setNavigationScope', 'setMyName', 'setReviewCommand', 'setReviewInput', 'setReturns', 'setReturnAttemptId', 'setActivity', 'setActivityError']) env[name] = () => {};
  Object.assign(env, { saveGroupInvite: async () => {}, publishedStorage: { current: {} }, loadGeneration: { current: 0 }, initialScreen: { current: 'home' }, googleReturn: { current: null }, activityOwner: { current: owner }, groupVersions: { current: '' } });
  env.changeScope = production('changeScope', env);
  env.runAccountRefresh = production('runAccountRefresh', env); env.background = production('background', env);
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') { const id = JSON.parse(String(options.body)).command_id; posts.push(id); if (id === 'c1') { first.resolve(); await release.promise; } return Response.json({ id: 'g', command_id: id, version: 1 }); }
    return Response.json(String(url).endsWith('/me/bill-email-entry') ? { needs_invitation: false } : group);
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await enqueue(db, owner, command('c1')); await enqueue(db, owner, command('c2'));
    job = env.background(() => env.runAccountRefresh(session), false); await first.promise;
    env.changeScope(null);
    if (reenter) env.changeScope(session);
    release.resolve(); await job;
    assert.deepEqual(posts, ['c1']);
    assert.deepEqual((await pendingCommands(db, owner)).map(row => [row.command_id, !!row.attempted]), [['c2', false]], 'accepted c1 is reconciled, later work remains untouched');
  } finally { release.resolve(); await job?.catch(() => {}); globalThis.fetch = original; raw.close(); }
});

test('same durable owner with a rotated token has one queue drainer', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
  const started = gate(), release = gate(), posts: string[] = [], jobs: Promise<unknown>[] = [];
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') { posts.push(JSON.parse(String(options.body)).command_id); started.resolve(); await release.promise; return Response.json({ id: 'g', version: 1 }); }
    return Response.json(group);
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await enqueue(db, owner, command('c1'));
    jobs.push(syncOutbox(db, session, 'summary')); await started.promise;
    jobs.push(syncOutbox(db, { ...session, token: 'new-synthetic-session' }, 'summary')); await tick();
    assert.deepEqual(posts, ['c1']); release.resolve(); await Promise.all(jobs); assert.deepEqual(posts, ['c1']);
  } finally { release.resolve(); await Promise.allSettled(jobs); globalThis.fetch = original; raw.close(); }
});

test('a queued drainer rechecks its session predicate after waiting for the owner', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
  const started = gate(), release = gate(), posts: string[] = [], jobs: Promise<unknown>[] = []; let current = true;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') { posts.push(JSON.parse(String(options.body)).command_id); started.resolve(); await release.promise; return Response.json({ id: 'g', version: 1 }); }
    return Response.json(group);
  };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await enqueue(db, owner, command('c1'));
    const first = syncOutbox(db, session, 'summary'); jobs.push(first); await started.promise;
    await enqueue(db, owner, command('c2'));
    const queued = syncOutbox(db, { ...session, token: 'rotated' }, 'summary', undefined, () => current); jobs.push(queued);
    current = false; release.resolve(); await first; await assert.rejects(queued, /account changed/);
    assert.deepEqual(posts, ['c1']); assert.deepEqual((await pendingCommands(db, owner)).map(row => row.command_id), ['c2']);
  } finally { release.resolve(); await Promise.allSettled(jobs); globalThis.fetch = original; raw.close(); }
});

for (const leaveRoute of [false, true]) test(`detail cache transaction cannot reauthorize a revoked group${leaveRoute ? ' after route departure' : ''}`, async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), started = gate(), release = gate();
  let current = true, job: Promise<unknown> | undefined;
  // Pause acquisition, so revocation can commit before the read gets its writer transaction.
  const waiting = { ...db, withExclusiveTransactionAsync: async (work: Parameters<typeof db.withExclusiveTransactionAsync>[0]) => { started.resolve(); await release.promise; return db.withExclusiveTransactionAsync(work); } };
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared'); await saveDraft(db, owner, 'g', { notes: 'Preserve unsent work' });
    const env = { getDatabase: async () => waiting, accountOwner, readVisibleGroup, activeSessionRef: { current: session }, saveGroup };
    job = production('saveReadGroup', env)(session, { ...group, focused_expense: { id: 'bill' } }, () => current);
    await started.promise; await reconcileGroupCache(db, owner, []); assert.equal((await readVisibleGroup(db, owner, 'g'))?.kind, 'unavailable');
    if (leaveRoute) current = false; release.resolve(); assert.equal(await job, false);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.kind, 'unavailable'); assert.deepEqual(await readDraft(db, owner, 'g'), { notes: 'Preserve unsent work' });
  } finally { release.resolve(); await job?.catch(() => {}); raw.close(); }
});

test('detail cache transaction rolls back if the session leaves during its storage write', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw); let current = true;
  try {
    await migrate(db); await saveGroup(db, owner, group, 'shared');
    const env = { getDatabase: async () => db, accountOwner, readVisibleGroup, activeSessionRef: { current: session }, saveGroup: async (...args: Parameters<typeof saveGroup>) => { await saveGroup(...args); current = false; } };
    assert.equal(await production('saveReadGroup', env)(session, { ...group, focused_expense: { id: 'bill' } }, () => current), false);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.group.focused_expense, undefined);
  } finally { raw.close(); }
});

test('actual attachment submission gates bill reversal and editing while another route stays usable', async () => {
  let writes = 0; const state = { route: { key: 'bill-detail' } };
  const env: any = { ApiError, groupId: 'g', submissions: { current: new Set<string>() }, lock: { current: false }, setBusyRoutes() {}, setNotice() {}, setExpired() {}, activeSessionRef: { current: session }, publishIfChanged: async () => {},
    navigation: { ref: { getCurrentRoute: () => state.route, getRootState: () => state.route } }, selected: { group: { archived: false } }, queue: async () => { writes++; }, command: () => ({}), navigate() {} };
  env.setSubmission = production('setSubmission', env); env.perform = production('perform', env); env.reverseExpense = production('reverseExpense', env);
  env.setSubmission(true, 'bill-detail|attachments');
  let busy: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'renderScreen') {
      for (const statement of node.body!.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (declaration.name.getText(app) === 'busy') busy = declaration.initializer;
    } ts.forEachChild(node, visit);
  } visit(app); assert.ok(busy);
  const renderBusy = new Function('env', `with(env){${ts.transpile('return (' + busy.getText(app) + ');', { target: ts.ScriptTarget.ES2022 })}}`);
  assert.equal(renderBusy({ ...env, route: state.route }), true, 'ExpenseDetail edit/reversal receive busy for this file operation');
  await assert.rejects(env.perform(() => env.reverseExpense({ id: 'bill', version: 1 })), /Please wait/); assert.equal(writes, 0);
  state.route = { key: 'unrelated' }; assert.equal(renderBusy({ ...env, route: state.route }), false);
  await env.perform(async () => { writes++; }); assert.equal(writes, 1); assert.equal(env.lock.current, true, 'attachment remains protected after unrelated work');
});


test('actual history paging uses the same atomic cache authorization fence', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), started = gate(), release = gate(); let loads = 0, job: Promise<unknown> | undefined;
  const cached = { ...group, transactions: [], history: { transactions: { next_cursor: 'older' } } };
  const waiting = { ...db, withExclusiveTransactionAsync: async (work: Parameters<typeof db.withExclusiveTransactionAsync>[0]) => { started.resolve(); await release.promise; return db.withExclusiveTransactionAsync(work); } };
  const env: any = { session, accountOwner, getDatabase: async () => waiting, readVisibleGroup, saveGroup, activeSessionRef: { current: session }, activeGroupRef: { current: 'g' }, browseCurrent: { current: 'scope' }, selected: { group: cached }, selfId: 'self', ApiError,
    request: async () => ({ read_mode: 'page', group_id: 'g', version: 1, items: [{ kind: 'bill', bill: { id: 'older' } }], next_cursor: null }), load: async () => { loads++; }, setLedgerRevision() {} };
  env.saveReadGroup = production('saveReadGroup', env);
  try {
    await migrate(db); await saveGroup(db, owner, cached, 'shared'); await saveDraft(db, owner, 'g', { notes: 'Saved work' });
    job = production('historyPage', env)('transactions', 'next'); await started.promise;
    await reconcileGroupCache(db, owner, []); release.resolve(); assert.equal(await job, false);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.kind, 'unavailable'); assert.equal(loads, 0);
  } finally { release.resolve(); await job?.catch(() => {}); raw.close(); }
});
