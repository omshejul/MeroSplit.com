import { withSharedUI } from './componentHarness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, enqueue, pendingCommands, saveGroup, readVisibleGroup, replaceCommand, discardCommand } from '../src/storage.ts';
import { accountOwner, expensePayload, syncOutbox, ApiError } from '../src/api.ts';
import { validateExpense } from '../src/accounting.ts';
import type { Command, Expense, Group, Session } from '../src/types.ts';

type Element = { type: string; props: Record<string, any>; children: any[] };
const React = { Fragment: 'Fragment', createElement: (type: string, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children }) };
const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean) {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) { if (predicate(node)) result = node; ts.forEachChild(node, visit); }
  visit(app); assert.ok(result); return result;
}
function evaluate(code: string, env: object) {
  return new Function('env', `with(env){${ts.transpile(code, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}}`)(withSharedUI({ React, Text: 'Text', ...env }));
}
function production(name: string, env: object) {
  const declaration = find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return evaluate(`${declaration.getText(app)};return ${name};`, env);
}
function variable(name: string, env: object): Element {
  const declaration = find(node => ts.isVariableDeclaration(node) && node.name.getText(app) === name) as ts.VariableDeclaration;
  return evaluate(`return (${declaration.initializer!.getText(app)});`, env);
}
function component(file: string, name: string, props: object): Element {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  return evaluate(`${body};return ${name}(props);`, { props, View: 'View', Text: 'Text', Button: 'Button', DetailDialog: 'DetailDialog', SectionHeading: 'SectionHeading', useUI: () => ({ ui: {}, palette: {} }), useMemo: (fn: () => unknown) => fn(), StyleSheet: { create: (value: unknown) => value }, radii: {}, validateExpense });
}
function elements(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return tree && typeof tree === 'object' && 'children' in tree ? [tree, ...elements(tree.children)] : [];
}
const session: Session = { baseUrl: 'https://synthetic.invalid', userId: '1', email: 'one@example.invalid', token: 'generation' }, owner = accountOwner(session);
const bill: Expense = { id: 'bill', version: 2, description: 'Latest bill', total: '800', paid: { a: '800' }, shares: { a: '400', b: '400' }, split: { mode: 'equal', values: { a: '1', b: '1' } }, date: '2026-10-26', category: 'other', notes: '', deleted: false };
const group: Group = { id: 'g', name: 'Trip', version: 3, participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], expenses: [bill], settlements: [], activity: [], balances: { a: '400', b: '-400' }, transfers: [] };
const edit: Command = { command_id: 'edit', group_id: 'g', method: 'PUT', path: '/groups/g/expenses/bill', base_version: 1, body: { ...expensePayload({ ...bill, description: 'Saved edit', version: 1 }, true), command_id: 'edit' }, state: 'conflict', error: 'Bill changed', attempted: true };

test('Saved changes actual row and App route reach latest review, edit replacement and discard for the command group', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), routes: any[] = [], originalFetch = globalThis.fetch;
  const later: Command = { ...edit, command_id: 'later', method: 'POST', path: '/groups/g/expenses', body: { ...edit.body, id: 'later', command_id: 'later' }, state: 'pending', error: null, attempted: undefined };
  const env: any = { browse: async (_key: string, work: any) => work(() => true), syncQuietly() {}, open: (work: any) => work(), accountOwner, readVisibleGroup, session, owner, groupId: null, selected: null, commands: [edit, later], groups: [{ kind: 'shared', group }], busy: false, expired: false, screen: 'savedChanges',
    ownerRef: { current: owner }, activeSessionRef: { current: session }, getDatabase: async () => db, saveGroup, ApiError,
    fetchGroup: async (_session: Session, id: string) => { assert.equal(id, 'g'); return group; }, withBill: async (_session: Session, current: Group) => current,
    load: async () => { env.selected = await readVisibleGroup(db, owner, 'g'); },
    setReviewCommand: (value: Command | null) => { env.reviewCommand = value; }, setReviewInput: (value: Expense) => { env.reviewInput = value; },
    navigate: (screen: string, params: any) => { routes.push([screen, params]); if (params?.groupId) env.groupId = params.groupId; if (params && 'expenseId' in params) env.expenseId = params.expenseId; },
    launch: (fn: () => unknown) => fn(), openGroup: () => { throw new Error('conflict opened read-only group instead of review'); }, SavedChanges: 'SavedChanges',
    confirm: (_title: string, _detail: string, fn: () => unknown) => fn(), discardCommand };
  try {
    await migrate(db); await enqueue(db, owner, { ...edit, state: 'pending', error: null, attempted: undefined }); await enqueue(db, owner, later); await enqueue(db, 'other-account', edit);
    const attempts: string[] = [];
    globalThis.fetch = async (url, options) => { attempts.push(`${options?.method} ${url}`); return Response.json({ detail: edit.error }, { status: 409 }); };
    await assert.rejects(syncOutbox(db, session), /Bill changed/);
    env.commands = await pendingCommands(db, owner);
    assert.equal(attempts.length, 1, 'known 409 holds later work without attempting it');
    env.saveReadGroup = production('saveReadGroup', env); env.reviewChange = production('reviewChange', env);
    const saved = variable('savedChangesView', env);
    const list = component('AccountRecovery.tsx', 'SavedChanges', saved.props);
    const row = elements(list).find(node => node.props.command?.command_id === 'edit')!;
    const renderedRow = component('AccountRecovery.tsx', 'SavedCommandRow', row.props);
    const review = elements(renderedRow).find(node => node.type === 'Button' && node.props.title === 'Review');
    assert.ok(review, 'known conflict needs an actionable Review button');
    await review.props.onPress();
    assert.deepEqual(routes.at(-1), ['review', { groupId: 'g', expenseId: null }]);
    assert.deepEqual(env.reviewCommand, edit); assert.equal(env.selected.group.version, 3);
    assert.deepEqual((await pendingCommands(db, owner)).map(row => row.command_id), ['edit', 'later'], 'opening review never mutates saved work');

    const reviewNode = find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'SavedChangeScreen');
    const discardable = { ...edit, command_id: 'discard-me' };
    await enqueue(db, owner, discardable);
    const discardProps = evaluate(`return (${reviewNode.getText(app)});`, { ...env, reviewCommand: discardable, SavedChangeScreen: 'SavedChangeScreen' }).props;
    const discardScreen = component('SavedChangeScreen.tsx', 'SavedChangeScreen', discardProps);
    await elements(discardScreen).find(node => node.props.title === 'Discard saved change')!.props.onPress();
    assert.deepEqual((await pendingCommands(db, owner)).map(row => row.command_id), ['edit', 'later'], 'explicit discard removes only the selected saved command');
    env.reviewCommand = edit;
    const reviewProps = evaluate(`return (${reviewNode.getText(app)});`, { ...env, SavedChangeScreen: 'SavedChangeScreen' }).props;
    const screen = component('SavedChangeScreen.tsx', 'SavedChangeScreen', reviewProps);
    elements(screen).find(node => node.props.title === 'Edit your change')!.props.onPress();
    assert.equal(env.reviewInput.description, 'Saved edit'); assert.equal(env.reviewInput.version, 2, 'review uses latest bill revision');
    assert.deepEqual(routes.at(-1), ['expense', { expenseId: 'bill' }]);
    Object.assign(env, { perform: async (fn: () => unknown) => fn(), draftWrites: { current: Promise.resolve() }, expensePayload, uuid: () => 'reviewed-edit', isOnline: () => false,
      queue: async (value: Command, previousId: string) => replaceCommand(db, owner, previousId, value), navigation: { complete: () => {} } });
    env.command = production('command', env);
    await production('saveExpense', env)(env.reviewInput);
    const after = await pendingCommands(db, owner), replacement = after.find(row => row.command_id === 'reviewed-edit')!;
    assert.equal(replacement.body.version, 2); assert.equal(replacement.base_version, 3);
    assert.deepEqual(after.find(row => row.command_id === 'later')?.body, later.body, 'dependent work stays unchanged');
    assert.equal(after.find(row => row.command_id === 'later')?.attempted, undefined);
    assert.equal((await pendingCommands(db, 'other-account')).length, 1, 'review/discard stays account scoped');
  } finally { globalThis.fetch = originalFetch; raw.close(); }
});

test('an uncertain attempted pending bill still opens read-only and never offers conflict replacement', () => {
  const tree = component('AccountRecovery.tsx', 'SavedCommandRow', { command: { ...edit, state: 'pending', error: null }, group: { group }, busy: true });
  const buttons = elements(tree).filter(node => node.type === 'Button');
  assert.deepEqual(buttons.map(node => node.props.title), ['Open']);
  assert.equal(buttons[0].props.disabled, true);
});

test('review fetch cannot publish a screen or cache after the account/session generation changes', async () => {
  for (const change of ['owner', 'token']) {
    let saves = 0, navigations = 0;
    const env: any = { browse: async (_key: string, work: any) => work(() => true), syncQuietly() {}, open: (work: any) => work(), accountOwner, readVisibleGroup, session, owner, groupId: null, ownerRef: { current: owner }, activeSessionRef: { current: session }, ApiError,
      fetchGroup: async () => group, withBill: async () => { if (change === 'owner') env.ownerRef.current = 'other-account'; else env.activeSessionRef.current = { ...session, token: 'new-generation' }; return group; },
      getDatabase: async () => ({}), saveGroup: async () => { saves++; }, load: async () => {}, setReviewInput() {}, setReviewCommand() {}, navigate: () => { navigations++; } };
    env.saveReadGroup = production('saveReadGroup', env); await production('reviewChange', env)(edit);
    assert.equal(saves, 0); assert.equal(navigations, 0);
  }
});

test('actual group callsite passes preview status separately from the live header', () => {
  const previewError = 'Balances show accepted records. Sync or review saved changes before previewing a new total.';
  const view = variable('groupView', { screen: 'group', selected: { group }, preview: group, previewError, GroupScreen: 'GroupScreen', categoryIcons: {}, listNotice: null, noticeVisibility: undefined, owner, groupId: 'g', ledgerRevision: 0, setLedgerUpdates() {}, pending: [edit], busy: false, selfId: 'a', loadBalanceGroup() {}, browseScope: '', remindPayment() {}, focused: true, foreground: true, expired: false, authHeld: false, online: true, pullToRefresh() {}, pulling: false });
  assert.equal(view.props.previewError, previewError, 'preview status must travel with the snapshot');
  assert.equal(elements(view.props.header).some(node => node.children.includes(previewError)), false, 'live header must not relabel a held optimistic snapshot');
});
