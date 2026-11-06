import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { sqliteAdapter } from './sqlite.ts';
import { enqueue, enqueueBill, migrate, pendingCommands, replaceCommand } from '../src/storage.ts';
import { ApiError, accountOwner, expensePayload } from '../src/api.ts';
import * as accounting from '../src/accounting.ts';
import { isPersonalPayment } from '../src/personalBalances.ts';

function bind(file: string, names: string[], env: Record<string, any>) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')) found.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(found.length, names.length);
  return new Function('env', `with(env){${ts.transpile(found.join('\n'), { target: ts.ScriptTarget.ES2022 })};return {${names.join(',')}}}`)(env);
}
const old = { baseUrl: 'https://synthetic.invalid', token: 'old', userId: '1', email: 'old@example.invalid' };
const fresh = { ...old, token: 'new', userId: '2', email: 'new@example.invalid' };
const owner = accountOwner(old);
const group: any = { id: 'g', version: 4, name: 'Trip', participants: [{ id: 'a', name: 'A', user_id: 1 }, { id: 'b', name: 'B', user_id: 2 }], expenses: [], settlements: [], activity: [], balances: {}, transfers: [] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => resolve = yes); return { promise, resolve }; }

function app(db: any, overrides: Record<string, any> = {}) {
  let id = 0;
  const navigations: string[] = [], expired: boolean[] = [];
  const env: any = {
    ApiError, accountOwner, expensePayload, session: old, owner, ownerRef: { current: owner }, activeSessionRef: { current: old },
    selected: { kind: 'shared', group }, groupId: group.id, expenseId: null, reviewCommand: null,
    vpa: 'synthetic@invalid', selfId: 'a', draftWrites: { current: Promise.resolve() }, pending: [],
    getDatabase: async () => db, enqueue, enqueueBill, replaceCommand, storageIsDurable: () => true, isOnline: () => false,
    uuid: () => `id-${++id}`, load: async () => {}, syncOutbox: async () => {},
    perform: async (action: () => Promise<any>) => action(),
    setReviewCommand() {}, setReviewInput() {}, setSyncing() {}, setSyncProblem() {}, setPushOpportunity() {},
    setExpired: (value: boolean) => expired.push(value), navigation: { complete: (screen: string) => navigations.push(screen) },
    retryAccountMediaUploads: async () => 0, refreshGroups: async () => [],
    ...overrides,
  };
  return { env, navigations, expired, api: bind('../App.tsx', ['command', 'requireConnectionForTemporaryStorage', 'queue', 'savePayment', 'saveExpense'], env) };
}

function paymentForm(onSave: (...args: any[]) => Promise<void>) {
  const errors: string[] = [];
  const env = { group, selfId: 'a', busy: false, lock: { current: false }, handedOff: { current: false },
    setSaving() {}, setSavingAction() {}, setError: (value: string) => errors.push(value), isPersonalPayment, onSave };
  return { ...bind('../src/SettleForm.tsx', ['save'], env), env, errors };
}

test('audit: a durable payment handoff cannot be retried after local refresh failure', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db);
    let reads = 0;
    const h = app(db, { load: async () => { if (++reads === 1) throw Error('Synthetic local refresh failure'); } });
    const payment = { sender: 'a', recipient: 'b', amount: '100' };
    const form = paymentForm(h.api.savePayment);
    await form.save(payment);
    assert.equal((await pendingCommands(db, owner)).length, 1);
    assert.equal(form.env.handedOff.current, true);
    assert.deepEqual(h.navigations, ['group'], 'durable handoff leaves the form before refreshing');
    assert.deepEqual(form.errors, [], 'post-handoff refresh failure must not invite another payment');
    await form.save(payment);
    const commands = await pendingCommands(db, owner);
    assert.equal(commands.length, 1, `Retry created duplicate payments ${commands.map(row => row.body.id).join(', ')}`);
  } finally { raw.close(); }
});

test('audit: App payment save succeeds after durable enqueue even if local refresh fails', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), problems: boolean[] = [];
  try {
    await migrate(db);
    const h = app(db, { load: async () => { throw Error('Synthetic local refresh failure'); }, setSyncProblem: (value: boolean) => problems.push(value) });
    await h.api.savePayment({ sender: 'a', recipient: 'b', amount: '100' });
    assert.equal((await pendingCommands(db, owner)).length, 1);
    assert.deepEqual(h.navigations, ['group']);
    assert.deepEqual(problems, [true], 'failed refresh remains visible as sync recovery, not a failed payment save');
  } finally { raw.close(); }
});

test('audit: payment enqueue failure remains retryable and rapid duplicate taps stay blocked', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db);
    let attempts = 0;
    const gate = deferred<void>();
    const h = app(db, { enqueue: async (...args: Parameters<typeof enqueue>) => {
      if (++attempts === 1) throw Error('Synthetic enqueue failure');
      await gate.promise; return enqueue(...args);
    } });
    const form = paymentForm(h.api.savePayment), payment = { sender: 'a', recipient: 'b', amount: '100' };
    await form.save(payment);
    assert.equal(form.env.handedOff.current, false);
    assert.deepEqual(h.navigations, []);
    assert.deepEqual(form.errors, ['Synthetic enqueue failure']);
    const retry = form.save(payment); await tick(); await form.save(payment); gate.resolve(); await retry;
    assert.equal(attempts, 2);
    assert.equal((await pendingCommands(db, owner)).length, 1);
    assert.deepEqual(h.navigations, ['group']);
  } finally { raw.close(); }
});

test('audit control: real navigation completion guard ignores the replaced account route', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), sync = deferred<void>();
  try {
    await migrate(db);
    let route = { key: 'old-expense-route' };
    const navigations: string[] = [];
    const navigation = bind('../src/AppStack.tsx', ['complete'], {
      ref: { getRootState: () => route }, contentRoute: (state: any) => state,
      route, go: (screen: string) => navigations.push(screen),
    });
    const h = app(db, { navigation, isOnline: () => true, syncOutbox: () => sync.promise });
    const bill = { id: 'e', version: 0, description: 'Dinner', total: '100', paid: { a: '100', b: '0' }, shares: { a: '50', b: '50' }, split: { mode: 'equal', values: { a: '1', b: '1' } }, date: '2026-11-01', deleted: false };
    const saving = h.api.saveExpense(bill);
    await tick();
    h.env.activeSessionRef.current = fresh;
    h.env.ownerRef.current = accountOwner(fresh);
    route = { key: 'replacement-account-home' };
    sync.resolve();
    await saving;
    assert.deepEqual(navigations, [], 'actual AppStack guard must prevent old route completion');
  } finally { raw.close(); }
});

test('audit: description-only edit preserves removed-person amounts for focused historical bill', async () => {
  const bill: any = { id: 'historical', version: 3, description: 'Dinner', total: '1000', paid: { a: '500', b: '500' }, shares: { a: '500', b: '500' }, split: { mode: 'equal', values: { a: '1', b: '1' } }, date: '2026-11-01', deleted: false, notes: '' };
  const focused = { ...group, participants: [group.participants[0], { ...group.participants[1], removed: true }], focused_expense: bill };
  const draft = { id: bill.id, expenseVersion: 3, description: 'Corrected description', amount: '10.00', date: bill.date, notes: '', payerIds: ['a', 'b'], payerAmounts: { a: '5.00', b: '5.00' }, participantIds: ['a', 'b'], splitValues: { a: '1', b: '1' }, multiplePayers: true, mode: 'equal' };
  const source = ts.createSourceFile('ExpenseForm.tsx', readFileSync(new URL('../src/ExpenseForm.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let accepted = '';
  function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'acceptedExpense') accepted = node.getText(source); ts.forEachChild(node, visit); }
  visit(source); assert.ok(accepted);
  let saved = 0, error = '';
  const env: any = { ...accounting, ready: true, busy: false, fileBusy: false, handedOff: { current: false }, lock: { current: false }, group: focused, expense: bill, draft,
    descriptionInput: { current: null }, descriptionError: 'Description invalid', pendingSave: { current: null }, store: { write: async () => {} },
    setError: (value: string) => error = value, setSaving() {}, onSave: async () => saved++,
    usesPayerAmounts: (value: any) => value.multiplePayers || value.payerIds.length > 1,
    paise: accounting.rupeesToPaise,
  };
  Object.assign(env, new Function('env', `with(env){${ts.transpile(`const ${accepted}`, { target: ts.ScriptTarget.ES2022 })};return {acceptedExpense}}`)(env));
  await bind('../src/ExpenseForm.tsx', ['save'], env).save();
  assert.equal(saved, 1, `Description-only edit was rejected: ${error}`);
  env.handedOff.current = false;
  draft.payerAmounts = { a: '6.00', b: '4.00' };
  await bind('../src/ExpenseForm.tsx', ['save'], env).save();
  assert.equal(saved, 1, 'focused historical bills must still preserve removed-person amounts');
  assert.match(error, /Keep removed people/);
});
