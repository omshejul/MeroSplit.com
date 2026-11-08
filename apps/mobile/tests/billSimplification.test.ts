import { withSharedUI } from './componentHarness.ts';
import { currencySymbol } from '../src/currency.ts';
import { categoryIcon, expenseCategory, categoryKey } from '../src/categoryIcons.ts';
import { directTransfers } from '../src/accounting.ts';
import { explainTransfer, balanceKey, changedBalance } from '../src/balanceExplanation.ts';
import test from 'node:test';
import { channelSummary } from '../src/channelPreferences.ts';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { accountOwner, expensePayload } from '../src/api.ts';
import { enqueue, enqueueBill, migrate, pendingCommands, replaceCommand } from '../src/storage.ts';
import { enqueueExpenseWithMedia, pendingMediaUpload, saveMediaUpload } from '../src/media.ts';
import { sqliteAdapter } from './sqlite.ts';
import ts from 'typescript';
import * as members from '../src/members.ts';
import { adjustmentToPaise, formatMoney, integer, rupeesToPaise, validateExpense } from '../src/accounting.ts';
import { isPersonalPayment } from '../src/personalBalances.ts';
import { validUPIAddress } from '../src/upi.ts';
import { paymentReturnNeedsConfirmation } from '../src/paymentReturn.ts';

type Element = { type: any; props: Record<string, any>; children: any[] };
const React = { createElement: (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children }) };
const Dialog = Object.assign(() => {}, { Title: 'Title', Content: 'Content', Actions: 'Actions' });
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes), ...nodes(value.props?.anchor)] : [];
const find = (tree: any, prop: string, value: string) => nodes(tree).find(node => node.props[prop] === value)!;
const payerContent = (tree: any) => { const child = find(tree, 'title', 'Who paid?').children[0]; return typeof child === 'function' ? child(() => {}) : child; };
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const Animated = { View: 'Animated.View', Value: class { value: number; constructor(value: number) { this.value = value; } stopAnimation() {} setValue(value: number) { this.value = value; } interpolate(value: any) { return value; } } };
function harness(file: string, name: string, extra: Record<string, any> = {}) {
  let cursor = 0, states: any[] = [], effects: (() => void)[] = [], cleanups: Record<number, () => void> = {};
  const deps: Record<number, any[]> = {};
  const draftDiscard = { current: null as null | (() => Promise<boolean>) };
  const env: Record<string, any> = { Animated, motionDuration: { feedback: 180 }, balanceColor: (amount: string, palette: any) => BigInt(amount) > 0n ? palette.positive : BigInt(amount) < 0n ? palette.negative : palette.muted, channelSummary, categoryIcon, expenseCategory, changedBalance, useExpenseIcons: () => ({}), animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, cachedRead: () => undefined, rememberRead() {}, invalidateRead() {}, getDatabase: async () => ({}), draftDiscard, ScreenDraftDiscard: {}, useContext: () => draftDiscard, expenseDraftStore: () => ({ read: () => ({ then: (done: (value: null) => void) => { done(null); return { catch() {} }; } }), write: async () => {} }), React, Dialog, PersonInviteDialog: 'PersonInviteDialog', useToast: () => () => {}, DetailDialog: 'DetailDialog', useScreenRemovalLock() {}, validUPIAddress, View: 'View', ScrollView: 'ScrollView', KeyboardDialog: 'KeyboardDialog', BottomSheet: 'BottomSheet', Pressable: 'Pressable', Text: 'Text', LoadingSpinner: 'LoadingSpinner', NotificationSwitch: 'NotificationSwitch', PushSettings: 'PushSettings', PushStatus: 'PushStatus', BalanceStatements: 'BalanceStatements', DialogScrollBody: 'DialogScrollBody', Form: 'Form', SectionHeading: 'SectionHeading', Button: 'Button', Icon: 'Icon', SettingsRow: 'SettingsRow', BillPeople: 'BillPeople', DraftAttachment: 'DraftAttachment', LocalAttachment: 'LocalAttachment', AmountField: 'AmountField', TextField: 'TextField', DateField: 'DateField', ErrorText: 'ErrorText', Checkbox: { Item: 'Checkbox' }, RadioChoice: 'RadioChoice', Crypto: { randomUUID: () => 'bill-id' }, StyleSheet: { create: (value: any) => value }, Keyboard: { dismiss() {} }, useWindowDimensions: () => ({ height: 667 }), useSafeAreaInsets: () => ({ top: 20, bottom: 0 }), Platform: { OS: 'native' }, requestAnimationFrame: (fn: () => void) => fn(), useUI: () => ({ ui: {} }), adjustmentToPaise, formatMoney, integer, rupeesToPaise, validateExpense, ...extra,
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = typeof initial === 'function' ? initial() : initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
    useEffect: (fn: () => any, values: any[]) => { const id = cursor++; if (!deps[id] || values.some((value, i) => value !== deps[id][i])) { effects.push(() => { cleanups[id]?.(); cleanups[id] = fn(); }); deps[id] = values; } },
  };
  const readUI = env.useUI; env.useUI = () => ({ motion: { enabled: false }, ...readUI() });
  const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const code = ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  const render = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${code}; return ${name};}`)(withSharedUI(env));
  return { render: (props: any) => {
    cursor = 0; let tree = render(props);
    // Arithmetic/render tests hydrate an empty draft immediately. Real SQLite recovery is covered in expenseDraft.test.ts.
    if (name === 'ExpenseForm' && effects.length) { const pending = effects; effects = []; pending.forEach(fn => fn()); cursor = 0; tree = render(props); }
    return tree;
  }, commit: () => { const pending = effects; effects = []; pending.forEach(fn => fn()); }, unmount: () => Object.values(cleanups).forEach(fn => fn?.()), env };
}

test('One Export data action invokes once, has no chooser and blocks repeats until sharing finishes', async () => {
  let calls = 0, finish!: () => void;
  const app = harness('src/ExportData.tsx', 'ExportData');
  const props = { busy: false, onExport: () => { calls++; return new Promise<void>(resolve => { finish = resolve; }); } };
  let tree = app.render(props);
  assert.ok(!nodes(tree).some(node => node.type === 'KeyboardDialog'));
  assert.ok(!nodes(tree).some(node => node.type === 'Text'), 'Export stays a single action without routine caption');
  find(tree, 'label', 'Export data').props.onPress(); find(tree, 'label', 'Export data').props.onPress();
  assert.equal(calls, 1); finish(); await tick();
  tree = app.render({ ...props, busy: true }); find(tree, 'label', 'Export data').props.onPress(); assert.equal(calls, 1);
  tree = app.render(props); find(tree, 'label', 'Export data').props.onPress(); assert.equal(calls, 2); finish(); await tick();
});

function appAction(name: string, env: Record<string, any>) {
  env.navigation ??= { complete: env.navigate };
  if (name === 'saveExpense') env.vpa ??= 'already@bank';
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const app = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AppContent') as ts.FunctionDeclaration;
  const fn = app.body!.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  return new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${ts.transpile(fn.getText(source), { target: ts.ScriptTarget.ES2022 })};return ${name};}`)(withSharedUI(env));
}

test('combined export flushes saved work and never shares a stale account result', async () => {
  const calls: any[] = [], notices: any[] = [], ownerRef = { current: 'owner-a' }, session = { token: 'session-a' };
  const data = { account_data_status: 'unavailable_offline' };
  const env: Record<string, any> = { categoryIcon, expenseCategory, changedBalance, useExpenseIcons: () => ({}), animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, browse: async (_key: string, work: any) => work(() => true), owner: 'owner-a', ownerRef, session, activeSessionRef: { current: session },
    draftWrites: { current: Promise.resolve() }, flushChatWrites: async () => {}, getDatabase: async () => ({}), isOnline: () => false,
    portableExport: async () => data, setNotice: (...args: any[]) => notices.push(args), shareJson: async (...args: any[]) => calls.push(args) };
  await appAction('exportData', env)(); assert.deepEqual(calls, [['merosplit-data', data]]); assert.equal(notices.length, 1);
  env.portableExport = async () => { ownerRef.current = 'owner-b'; return data; };
  await appAction('exportData', env)(); assert.equal(calls.length, 1);
});

const group = { id: 'g', name: 'Example', expenses: [], participants: [{ id: 'self', name: 'Example' }, { id: 'other', name: 'Jordan' }] };

test('a new bill focuses Amount once after draft restore and Next focuses Description', () => {
  const app = harness('src/ExpenseForm.tsx', 'ExpenseForm');
  const props = { group, selfId: 'self', busy: false, autoFocusAmount: true, onSave: async () => {} };
  const focus: string[] = [];
  const tree = app.render(props);
  const amount = nodes(tree).find(node => node.type === 'AmountField')!;
  const description = find(tree, 'label', 'Description');
  amount.props.ref.current = { focus: () => focus.push('amount') };
  description.props.ref.current = { focus: () => focus.push('description') };
  app.commit();
  app.render({ ...props, busy: true }); app.render(props); app.commit();
  assert.deepEqual(focus, ['amount']);
  amount.props.onSubmitEditing();
  assert.deepEqual(focus, ['amount', 'description']);
});

test('form keeps one selected payer changeable when other people are eligible and retains values through dialog close', async () => {
  const app = harness('src/ExpenseForm.tsx', 'ExpenseForm'), drafts: any[] = [], saves: any[] = [];
  const props = { group, selfId: 'self', busy: false, onSave: async (value: any) => saves.push(value), onDraftChange: (value: any) => drafts.push(value) };
  let tree = app.render(props);
  let paid = find(tree, 'title', 'Who paid?'); assert.equal(paid.props.inline, false);
  const fields = payerContent(tree); fields.props.onChange({ multiplePayers: true }); payerContent(app.render(props)).props.onToggle('other');
  tree = app.render(props); paid = find(tree, 'title', 'Who paid?'); assert.equal(paid.props.summary, '2 people');
  payerContent(tree).props.onChange({ payerAmounts: { self: '6.00', other: '4.00' }, amount: '10.00', description: 'Lunch' });
  tree = app.render(props); assert.deepEqual(payerContent(tree).props.draft.payerAmounts, { self: '6.00', other: '4.00' });
  assert.equal(saves.length, 0); find(tree, 'title', 'Save bill').props.onPress(); await tick();
  assert.equal(saves.length, 1); assert.deepEqual(saves[0].paid, { self: '600', other: '400' });
  assert.equal(drafts.length, 0, 'typing and saving never autosave a form draft');
  const single = harness('src/ExpenseForm.tsx', 'ExpenseForm').render({ ...props, group: { ...group, participants: [group.participants[0]] } });
  assert.equal(find(single, 'title', 'Who paid?').props.inline, true); assert.equal(find(single, 'title', 'Split between').props.inline, true);
  assert.ok(nodes(single).some(node => node.type === 'NotesField' && node.props.value === ''));
});

test('all split modes still validate through the actual form and preserve draft-shaped amounts', async () => {
  for (const [mode, values] of [['equal', {}], ['exact', { self: '3.00', other: '7.00' }], ['percent', { self: '30', other: '70' }], ['shares', { self: '3', other: '7' }]] as const) {
    const saves: any[] = [], app = harness('src/ExpenseForm.tsx', 'ExpenseForm');
    const props = { group, selfId: 'self', busy: false, onSave: async (value: any) => saves.push(value) };
    let tree = app.render(props); find(tree, 'title', 'Split between').children[0].props.onChange({ amount: '10.00', description: 'Lunch', mode, splitValues: values });
    tree = app.render(props); assert.equal(saves.length, 0); find(tree, 'title', 'Save bill').props.onPress(); await tick();
    assert.equal(saves.length, 1); assert.equal(saves[0].split.mode, mode);
    assert.deepEqual(saves[0].shares, mode === 'equal' ? { self: '500', other: '500' } : { self: '300', other: '700' });
  }
  const app = harness('src/ExpenseForm.tsx', 'ExpenseForm'); let saved = 0;
  const props = { group, selfId: 'self', busy: false, onSave: async () => saved++ };
  let tree = app.render(props); find(tree, 'title', 'Split between').children[0].props.onChange({ amount: '10', description: 'Lunch', mode: 'exact', splitValues: { self: '1', other: '1' } });
  tree = app.render(props); find(tree, 'title', 'Save bill').props.onPress(); await tick();
  assert.equal(saved, 0); assert.ok(nodes(app.render(props)).some(node => node.type === 'ErrorText'));
});

function payerFields(app: ReturnType<typeof harness>, props: any) {
  const selection = payerContent(app.render(props));
  const tree = harness('src/ExpenseForm.tsx', 'PayerFields', { SplitPersonRow: 'SplitPersonRow' }).render(selection.props);
  return { ...selection.props, fields: nodes(tree).filter(node => node.type === 'SplitPersonRow' && node.props.selected) };
}

test('payer difference chips keep local values and save through existing validation', async () => {
  for (const id of ['self', 'other']) {
    const app = harness('src/ExpenseForm.tsx', 'ExpenseForm'), drafts: any[] = [], saves: any[] = [];
    const props = { group, selfId: 'self', busy: false, onSave: async (expense: any) => saves.push(expense), onDraftChange: (draft: any) => drafts.push(draft) };
    payerFields(app, props).onChange({ amount: '285', description: 'Lunch', payerIds: ['self', 'other'], payerAmounts: { self: '90', other: '192' } });
    const before = payerFields(app, props);
    assert.equal(before.fields.length, 2);
    assert.ok(before.fields.every((field: Element) => field.props.right.props.difference === 300n));
    before.fields[id === 'self' ? 0 : 1].props.right.props.onPress();
    before.onAdjust(id === 'self' ? 'other' : 'self'); // A second tap before rendering must recompute the current draft.
    const after = payerFields(app, props), expected = id === 'self' ? { self: '93.00', other: '192' } : { self: '90', other: '195.00' };
    assert.deepEqual(after.draft.payerAmounts, expected);
    assert.ok(after.fields.every((field: Element) => field.props.right === null));
    assert.equal(saves.length, 0);
    assert.equal(drafts.length, 0, 'editing stays in the mounted form');
    const reopened = harness('src/ExpenseForm.tsx', 'ExpenseForm');
    assert.deepEqual(payerFields(reopened, props).draft.payerAmounts, {});
    find(app.render(props), 'title', 'Save bill').props.onPress(); await tick();
    assert.deepEqual(saves[0].paid, id === 'self' ? { self: '9300', other: '19200' } : { self: '9000', other: '19500' });
  }
});

test('payer subtraction chips never make a contribution negative and handle zero exactly', () => {
  const app = harness('src/ExpenseForm.tsx', 'ExpenseForm'), props = { group, selfId: 'self', busy: false, onSave: async () => {} };
  payerFields(app, props).onChange({ amount: '285', payerIds: ['self', 'other'], payerAmounts: { self: '1', other: '287' } });
  let fields = payerFields(app, props);
  assert.equal(fields.fields[0].props.right, null);
  assert.equal(fields.fields[1].props.right.props.difference, -300n);
  fields.onAdjust('self');
  assert.deepEqual(payerFields(app, props).draft.payerAmounts, { self: '1', other: '287' });
  fields.fields[1].props.right.props.onPress();
  assert.deepEqual(payerFields(app, props).draft.payerAmounts, { self: '1', other: '284.00' });
  fields = payerFields(app, props);
  fields.onChange({ payerAmounts: { self: '3', other: '285' } });
  payerFields(app, props).fields[0].props.right.props.onPress();
  assert.deepEqual(payerFields(app, props).draft.payerAmounts, { self: '0.00', other: '285' });
});

test('payer chips support a one-paise difference, empty amounts and three payers without touching shares', () => {
  const app = harness('src/ExpenseForm.tsx', 'ExpenseForm');
  const props = { group: { ...group, participants: [...group.participants, { id: 'third', name: 'Noor' }] }, selfId: 'self', busy: false, onSave: async () => {} };
  payerFields(app, props).onChange({ amount: '285', payerIds: ['self', 'other', 'third'], payerAmounts: { self: '90', other: '194.99', third: '' }, mode: 'exact', splitValues: { self: '1' } });
  let fields = payerFields(app, props);
  assert.equal(fields.status, '₹0.01 still to add.');
  assert.equal(fields.fields[2].props.right.props.difference, 1n);
  fields.fields[2].props.right.props.onPress();
  fields = payerFields(app, props);
  assert.deepEqual(fields.draft.payerAmounts, { self: '90', other: '194.99', third: '0.01' });
  assert.deepEqual(fields.draft.splitValues, { self: '1' });
  assert.equal(fields.status, 'Adds up to the bill.');
});

test('invalid input, a single payer, locked forms and removed people cannot be adjusted', () => {
  const app = harness('src/ExpenseForm.tsx', 'ExpenseForm');
  const props = { group: { ...group, participants: [...group.participants, { id: 'removed', name: 'Former', removed: true }] }, selfId: 'self', busy: false, onSave: async () => {} };
  const draft = { amount: '285', payerIds: ['self', 'other', 'removed'], payerAmounts: { self: '90', other: '191', removed: '1' } };
  payerFields(app, props).onChange(draft);
  let fields = payerFields(app, props);
  assert.equal(fields.fields[2].props.right, null);
  fields.onAdjust('removed'); fields.onAdjust('unknown');
  assert.deepEqual(payerFields(app, props).draft.payerAmounts, draft.payerAmounts);
  for (const locked of [{ ...props, busy: true }, { ...props, group: { ...props.group, archived: true } }]) {
    fields = payerFields(app, locked);
    assert.ok(fields.fields.every((field: Element) => field.props.right === null));
    fields.onAdjust('self');
    assert.deepEqual(payerFields(app, locked).draft.payerAmounts, draft.payerAmounts);
  }
  for (const amount of ['-', '3.001', '1,000', '10000001']) {
    payerFields(app, props).onChange({ ...draft, amount });
    fields = payerFields(app, props);
    assert.ok(fields.fields.every((field: Element) => field.props.right === null));
    fields.onAdjust('self');
    assert.deepEqual(payerFields(app, props).draft.payerAmounts, draft.payerAmounts);
  }
  payerFields(app, props).onChange({ ...draft, payerAmounts: { ...draft.payerAmounts, other: '1.001' } });
  assert.ok(payerFields(app, props).fields.every((field: Element) => field.props.right === null));
  payerFields(app, props).onChange({ ...draft, payerIds: ['self'] });
  assert.equal(payerFields(app, props).fields.length, 0);
});

test('adjustment action uses an explicit sign and screen-reader action for either direction', () => {
  const render = harness('src/ExpenseForm.tsx', 'PayerAdjustment', { TouchableRipple: 'TouchableRipple' });
  for (const [difference, title, label] of [[300n, '+₹3.00', 'Add ₹3.00 to Jordan'], [-1n, '−₹0.01', 'Subtract ₹0.01 from Jordan']] as const) {
    let tapped = 0;
    const tree = render.render({ difference, name: 'Jordan', onPress: () => tapped++ });
    assert.equal(tree.props.accessibilityRole, 'button'); assert.equal(tree.props.accessibilityLabel, label);
    assert.equal(nodes(tree).find(node => node.type === 'Text')!.children.join(''), title);
    tree.props.onPress(); assert.equal(tapped, 1);
  }
});

test('people dialog opens/closes/reopens without changing its existing inputs and keeps Done outside scroll', () => {
  const app = harness('src/BillPeople.tsx', 'BillPeople'); const child = React.createElement('Input', { value: 'Preserved' });
  const props = { title: 'Who paid?', summary: '2 people', inline: false, disabled: false, children: child };
  let tree = app.render(props); app.commit();
  for (let i = 0; i < 2; i++) {
    nodes(tree).find(node => node.type === 'Button')!.props.onPress(); tree = app.render(props); app.commit();
    assert.equal(nodes(tree).find(node => node.type === 'PeopleSheet')!.props.visible, true);
    assert.equal(nodes(tree).find(node => node.type === 'Input'), child);
    nodes(tree).find(node => node.type === 'PeopleSheet')!.props.onDismiss(); tree = app.render(props); app.commit();
    assert.equal(nodes(tree).find(node => node.type === 'PeopleSheet')!.props.visible, false);
  }
});

test('people dialog adapts to short viewports and Done dismisses the keyboard while retaining inputs', () => {
  const viewport = { height: 667 }, safe = { top: 20, bottom: 0 }; let dismisses = 0;
  const people = harness('src/BillPeople.tsx', 'BillPeople', { useWindowDimensions: () => viewport, useSafeAreaInsets: () => safe, Keyboard: { dismiss: () => dismisses++ } });
  const child = React.createElement('Input', { value: '700.00' });
  const props = { title: 'Who paid?', icon: 'pay', summary: '2 people', inline: false, disabled: false, children: child };
  for (const [height, top, bottom] of [[667, 20, 0], [844, 47, 34], [375, 0, 21]]) {
    Object.assign(viewport, { height }); Object.assign(safe, { top, bottom });
    assert.equal(nodes(people.render(props)).find(node => node.type === 'PeopleSheet')!.props.maxHeight, height - top - bottom);
  }
  let tree = people.render(props); people.commit(); nodes(tree).find(node => node.type === 'Button')!.props.onPress();
  tree = people.render(props); people.commit(); nodes(tree).find(node => node.type === 'PeopleSheet')!.props.onDismiss();
  assert.equal(dismisses, 1); assert.equal(nodes(people.render(props)).find(node => node.type === 'Input'), child);
});

test('accepted attachment action reuses one load/picker path and preserves permission/limit/pending guards', async () => {
  let reads = 0, picks = 0, uploads = 0;
  const session = { token: 'owner-a' }, props = { session, groupId: 'g', expenseId: 'e', busy: false, onBusyChange() {} };
  const make = async (items: any[] = [], canModify = true, pending: any = null) => {
    const app = harness('src/BillAttachments.tsx', 'BillAttachments', {
      Platform: { OS: 'web' }, accountOwner: () => 'owner-a', getDatabase: async () => ({}), pendingMediaUpload: async () => pending,
      request: async () => { reads++; return { attachments: items, can_modify: canModify }; },
      pickMedia: async (photo: boolean) => { assert.equal(photo, false); picks++; return null; },
      stageMediaUpload: async () => { uploads++; throw Error('Upload boundary blocked'); }, PrivateMediaImage: 'PrivateMediaImage', RemoveMediaMenu: 'RemoveMediaMenu', mediaSize: () => '1 KB',
    });
    app.render(props); app.commit(); await tick(); return app;
  };
  const app = await make(); let tree = app.render(props); app.commit();
  assert.equal(reads, 1); assert.equal(nodes(tree).find(node => node.type === 'BottomSheet' && node.props.title === 'Photos & documents')!.props.visible, false);
  find(tree, 'accessibilityLabel', 'Add attachment').props.onPress(); assert.equal(picks, 0); find(app.render(props), 'title', 'Choose file').props.onPress(); await tick(); assert.equal(picks, 1); assert.equal(uploads, 0); assert.equal(reads, 1);
  tree = app.render({ ...props, busy: true }); find(tree, 'accessibilityLabel', 'Add attachment').props.onPress(); await tick(); assert.equal(picks, 1);
  assert.ok(!find(app.render({ ...props, readOnly: true }), 'accessibilityLabel', 'Add attachment'));
  for (const [items, canModify, pending] of [[[], false, null], [[], true, { file: { name: 'Retained pending file' } }], [Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: 'Synthetic.pdf', content_type: 'application/pdf' })), true, null]] as any[]) {
    const guarded = await make(items, canModify, pending); assert.ok(!find(guarded.render(props), 'accessibilityLabel', 'Add attachment'));
  }
  assert.equal(picks, 1); assert.equal(uploads, 0);
});

test('PDF and photo attachment rows reuse the same private thumbnail component and keep the file open action', () => {
  let opens = 0;
  for (const content_type of ['application/pdf', 'image/jpeg']) {
    const app = harness('src/BillAttachments.tsx', 'AttachmentRow', { PrivateMediaImage: 'PrivateMediaImage', mediaSize: () => '1 KB', useUI: () => ({ ui: {}, palette: {} }) });
    const item = { id: 'file', name: 'Synthetic attachment', content_type, size: 1000 };
    const tree = app.render({ title: item.name, label: `Open ${item.name}`, subtitle: '1 KB', thumbnail: React.createElement('PrivateMediaImage', { session: {}, media: item }), disabled: false, onOpen: () => opens++, options: null });
    assert.equal(nodes(tree).filter(node => node.type === 'PrivateMediaImage').length, 1);
    assert.equal(nodes(tree).find(node => node.type === 'PrivateMediaImage')!.props.media, item);
    find(tree, 'accessibilityLabel', 'Open Synthetic attachment').props.onPress();
  }
  assert.equal(opens, 2);
});

test('private thumbnail retries stay bounded and late results cannot replace the next account preview', async () => {
  const waiting: { resolve: (value: string) => void; reject: () => void }[] = [];
  const app = harness('src/PrivateMediaThumbnail.tsx', 'PrivateMediaThumbnail', { Platform: { OS: 'web' }, Image: 'Image', radii: { control: 8 }, useUI: () => ({ ui: {}, palette: {} }),
    mediaThumbnail: () => new Promise<string>((resolve, reject) => waiting.push({ resolve, reject: () => reject(Error('Unavailable')) })) });
  const media = { id: 'file', name: 'Receipt.pdf', content_type: 'application/pdf', size: 1000 };
  const props = { session: { baseUrl: 'https://example.invalid', userId: 'a', token: 'a' }, media };
  app.render(props); app.commit(); assert.equal(waiting.length, 1);
  const next = { ...props, session: { ...props.session, userId: 'b', token: 'b' } };
  app.render(next); app.commit(); waiting[0].resolve('old-account-image'); await tick();
  assert.ok(!nodes(app.render(next)).some(node => node.type === 'Image'));
  waiting[1].resolve('new-account-image'); await tick(); let tree = app.render(next);
  let image = nodes(tree).find(node => node.type === 'Image')!;
  assert.equal(image.props.source.uri, 'new-account-image'); assert.equal(image.props.resizeMode, 'contain');
  image.props.onError(); assert.equal(waiting.length, 3); waiting[2].resolve('one-refresh'); await tick();
  tree = app.render(next); nodes(tree).find(node => node.type === 'Image')!.props.onError();
  tree = app.render(next); assert.equal(waiting.length, 3);
  assert.equal(find(tree, 'accessibilityLabel', 'PDF preview unavailable').type, 'View');
  assert.ok(!nodes(tree).some(node => node.type === 'Button'), 'preview fallback must not nest a button in the file button');
  const later = { ...next, media: { ...media, id: 'next-file' } };
  app.render(later); app.commit(); assert.equal(waiting.length, 4);
  app.unmount(); waiting[3].resolve('after-unmount'); await tick();
});

test('native thumbnail failure retains the original manual Retry on iOS and Android', async () => {
  for (const OS of ['ios', 'android']) {
    const waiting: { resolve: (value: string) => void; reject: () => void }[] = [];
    const app = harness('src/PrivateMediaThumbnail.tsx', 'PrivateMediaThumbnail', { Platform: { OS }, Image: 'Image', radii: { control: 8 }, useUI: () => ({ ui: {}, palette: {} }),
      mediaThumbnail: () => new Promise<string>((resolve, reject) => waiting.push({ resolve, reject: () => reject(Error('Unavailable')) })) });
    const props = { session: { baseUrl: 'https://example.invalid', userId: 'owner', token: 'synthetic' }, media: { id: 'file', name: 'Receipt.pdf', content_type: 'application/pdf' } };
    app.render(props); app.commit(); waiting[0].reject(); await tick();
    const retry = find(app.render(props), 'accessibilityLabel', 'Retry PDF preview');
    assert.equal(retry.type, 'Button'); assert.equal(retry.props.accessibilityRole, 'button');
    retry.props.onPress(); assert.equal(waiting.length, 2);
    waiting[1].resolve('native-retry-image'); await tick();
    assert.equal(nodes(app.render(props)).find(node => node.type === 'Image')!.props.source.uri, 'native-retry-image');
    app.unmount();
  }
});

test('web PDFs use the shared private thumbnail while web photos retain the existing cookie-protected path', () => {
  const app = harness('src/PrivateMediaImage.web.tsx', 'PrivateMediaImage', { Image: 'Image', PrivateMediaThumbnail: 'PrivateMediaThumbnail', browserMediaUrl: () => '/app/media/photo', radii: { control: 8 }, useUI: () => ({ ui: {}, palette: {} }) });
  const props = { session: { userId: 'owner' }, media: { id: 'file', content_type: 'application/pdf' } };
  assert.equal(app.render(props).type, 'PrivateMediaThumbnail');
  const photo = app.render({ ...props, media: { ...props.media, content_type: 'image/jpeg' } });
  assert.equal(photo.type, 'Image'); assert.equal(photo.props.source.uri, '/app/media/photo');
});

test('removed payer controls stay locked and changing historical amounts is still rejected', async () => {
  const existing = { id: 'old-bill', version: 3, description: 'Lunch', total: '1000', paid: { self: '500', other: '500' }, shares: { self: '500', other: '500' }, split: { mode: 'equal', values: { self: '1', other: '1' } }, date: '2026-10-18', notes: '', category: 'general', deleted: false };
  const editedGroup = { ...group, participants: [group.participants[0], { ...group.participants[1], removed: true }], expenses: [existing] };
  let saved = 0; const app = harness('src/ExpenseForm.tsx', 'ExpenseForm');
  const props = { group: editedGroup, expense: existing, selfId: 'self', busy: false, onSave: async () => saved++ };
  let tree = app.render(props); const fields = payerContent(tree);
  const controls = fields.type(fields.props);
  assert.equal(find(controls, 'accessibilityLabel', 'Jordan (removed)').props.disabled, true);
  assert.equal(find(controls, 'label', 'One person').props.disabled, true);
  fields.props.onChange({ payerAmounts: { self: '6.00', other: '4.00' } });
  tree = app.render(props); find(tree, 'title', 'Save bill').props.onPress(); await tick(); assert.equal(saved, 0);
  const error = nodes(app.render(props)).find(node => node.type === 'ErrorText')!;
  assert.ok(error.children.join('').includes('Keep removed people'));
});


test('cached bill/payment attribution needs no detail request, while absent records still fetch', async () => {
  const calls: string[] = [], active = { token: 'synthetic' };
  const env = { request: async (_session: any, path: string) => { calls.push(path); return path.includes('/expenses/') ? { id: 'other-bill', group_id: 'g', group_version: 4, added_by: 'Creator' } : { id: 'other-payment', group_version: 4, recorded_by_name: 'Recorder' }; } };
  const saved = { id: 'g', version: 4, expenses: [{ id: 'bill', added_by: 'Creator' }], settlements: [{ id: 'payment', recorded_by_name: 'Recorder' }] };
  const withBill = appAction('withBill', env), withPayment = appAction('withPayment', env);
  assert.equal(await withBill(active, saved, 'bill'), saved);
  assert.equal(await withPayment(active, saved, 'payment'), saved); assert.equal(calls.length, 0);
  assert.equal((await withBill(active, saved, 'other-bill')).focused_expense.added_by, 'Creator');
  assert.equal((await withPayment(active, saved, 'other-payment')).focused_settlement.recorded_by_name, 'Recorder');
  assert.equal(calls.length, 2);
});


test('pre-save file picker stages privately before the durable draft, previews and persists removal before cleanup', async () => {
  const events: string[] = [], picked = { uri: 'file:///cache/photo.png', name: 'Photo.png', type: 'image/png', size: 3 }, staged = { ...picked, uri: 'file:///documents/saved.png' };
  const app = harness('src/DraftAttachment.tsx', 'DraftAttachment', { Platform: { OS: 'web' },
    pickMedia: async () => { events.push('pick'); return picked; }, stageMediaUpload: async () => { events.push('stage'); return staged; },
    clearPickedMedia: async () => events.push('clear picker'), clearStagedMedia: async () => events.push('clear staged') });
  let value: any, error = '';
  const props = { path: '/groups/g/expenses/e/attachments', disabled: false, onBusy() {}, onError: (message: string) => { error = message; }, onChange: async (next: any) => { events.push(next ? 'persist file' : 'persist removal'); value = next; } };
  find(app.render(props), 'accessibilityLabel', 'Add attachment').props.onPress(); find(app.render(props), 'title', 'Choose file').props.onPress(); await tick();
  assert.deepEqual(events, ['pick', 'stage', 'persist file', 'clear picker']); assert.equal(value.file.uri, staged.uri);
  const tree = app.render({ ...props, value }); assert.equal(nodes(tree).find(node => node.type === 'LocalAttachment')!.props.file, staged);
  find(tree, 'title', 'Remove file').props.onPress(); await tick();
  assert.equal(value, undefined); assert.deepEqual(events.slice(-2), ['persist removal', 'clear staged']); assert.equal(error, '');
});

test('bill save preserves both draft and file if enqueue fails, then reuses the same bill/file IDs on retry', async () => {
  const file = { id: 'file-id', path: '/groups/g/expenses/bill-id/attachments', file: { uri: 'file:///staged.png' } };
  const events: string[] = [], expense = { id: 'bill-id' }; let fail = true;
  const env: Record<string, any> = { categoryIcon, expenseCategory, changedBalance, useExpenseIcons: () => ({}), animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, selected: { group: {} }, session: {}, owner: 'owner', groupId: 'g', expenseId: null, reviewCommand: null,
    perform: (action: any) => action(), draftWrites: { current: Promise.resolve() }, getDatabase: async () => ({}),
    expensePayload: (value: any) => value, command: (_method: string, _path: string, body: any) => body,
    queue: async (body: any, _replacing: unknown, attachment: unknown) => { assert.equal(body.id, 'bill-id'); assert.equal(attachment, file); events.push('queue bill and file'); if (fail) throw Error('Disk full'); },
    saveDraft: async () => { events.push('clear bill draft'); }, setDraft() {}, setReviewCommand() {}, setReviewInput() {}, navigate() {}, isOnline: () => false };
  const save = appAction('saveExpense', env);
  await assert.rejects(save(expense, file), /Disk full/); assert.deepEqual(events, ['queue bill and file']);
  fail = false; await save(expense, file); assert.deepEqual(events, ['queue bill and file', 'queue bill and file']);
});

const notificationToggle = (tree: any, label: string) => nodes(tree).find(node => node.type === 'NotificationSwitch' && node.props.label === label)!;

function notificationPanel(initial: { expense_updates: boolean; email_reminders: boolean } | null) {
 const changes:any[]=[],busy:boolean[]=[];const push:any={state:{configured:true,enabled:true,ready:true,working:false,saving:false,pending:false,permission:'granted',error:''},enable:async()=>true,disable:async()=>{},refresh:async()=>{}};
 const channels:any={state:{value:initial?{email_notifications:initial.expense_updates&&initial.email_reminders,email_available:true,legacy_muted:!initial.expense_updates,statement_enabled:initial.email_reminders,statement_frequency:'monthly'}:null,pending:false,saving:false,error:''},change:async(patch:any)=>{changes.push(patch);channels.state={...channels.state,value:{...channels.state.value,...patch},pending:true};},retry:async()=>true};
 const app=harness('src/AccountNotifications.tsx','AccountNotifications');const props={session:{token:'synthetic'},push,channels,busy:false,onBusyChange:(value:boolean)=>busy.push(value)};return{app,props,changes,busy};
}

test('Delete group removes routine caption but retains blocked reason, busy/canLeave and restore controls', () => {
  const app = harness('src/GroupMembershipActions.tsx', 'GroupMembershipActions'); let leaves = 0, restores = 0;
  const props = { hidden: false, busy: false, canLeave: true, onLeave: () => leaves++, onRestore: () => restores++ };
  let tree = app.render(props); assert.ok(!nodes(tree).some(node => node.type === 'Text'));
  find(tree, 'title', 'Delete group').props.onPress(); assert.equal(leaves, 1);
  tree = app.render({ ...props, canLeave: false, blockedReason: 'Settle your balance before deleting this group.' });
  assert.equal(find(tree, 'title', 'Delete group').props.disabled, true);
  assert.ok(nodes(tree).some(node => node.type === 'Text' && node.children.includes('Settle your balance before deleting this group.')));
  assert.equal(find(app.render({ ...props, busy: true }), 'title', 'Delete group').props.disabled, true);
  tree = app.render({ ...props, hidden: true }); find(tree, 'title', 'Restore to my list').props.onPress(); assert.equal(restores, 1);
});

const inviteGroup = { id: 'imported-group', name: 'Imported trip', owner_id: 1, version: 1, participants: [{ id: 'owner', name: 'Om', user_id: 1 }, { id: 'imported-person', name: 'Asha' }], balances: { owner: '500', 'imported-person': '-500' }, expenses: [{ id: 'existing-bill' }], settlements: [], invites: [] };
function memberPanel(onAction: (path: string, body: any) => Promise<any>, group: any = inviteGroup) {
  let ids = 0;
  const app = harness('src/MembersScreen.tsx', 'MemberSettings', { ...members, Avatar: 'Avatar', IconAction: 'IconAction', Disclosure: 'Disclosure', GroupMembershipActions: 'GroupMembershipActions', EmailField: 'EmailField', SendInviteDialog: 'SendInviteDialog',
    Crypto: { randomUUID: () => `command-${++ids}` }, setTimeout: () => 0, clearTimeout() {} });
  const props = { group, selfId: 'owner', busy: false, onAction, onMembership() {} };
  const row = (tree: any) => nodes(tree).find(node => node.props.person?.id === 'imported-person' && node.props.onInvite)!;
  const dialog = (tree: any) => nodes(tree).find(node => node.props.onEmail && node.props.onSave && 'person' in node.props)!;
  app.render(props); app.commit();
  return { app, props, row, dialog, open(email: string) { row(app.render(props)).props.onInvite(); nodes(app.render(props)).find(node => node.type === 'PersonInviteDialog')!.props.onEmail(); dialog(app.render(props)).props.onEmail(email); return dialog(app.render(props)); } };
}

test('Existing imported person email saves before invitation, uses the refreshed callback and preserves ID/history with stale original group props', async () => {
  const calls: any[] = []; let finish!: (value: any) => void;
  const panel = memberPanel(async (path, body) => { calls.push({ path, body }); return new Promise(resolve => { finish = resolve; }); });
  panel.open(' ASHA@Example.invalid ').props.onSave(); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/participants/imported-person/contact');
  assert.deepEqual(calls[0].body, { command_id: 'command-1', email: 'asha@example.invalid' });
  assert.equal(panel.dialog(panel.app.render(panel.props)).props.working, true);
  const freshAction = async (path: string, body: any) => { calls.push({ path, body, fresh: true }); return { id: inviteGroup.id, version: 3, linked_participant_ids: [], invite: { id: body.command_id, state: 'sent', retry_after: 60 } }; };
  const before = JSON.stringify(inviteGroup); panel.app.render({ ...panel.props, onAction: freshAction });
  finish({ id: inviteGroup.id, version: 2 }); await tick();
  assert.equal(calls.length, 1, 'saving a contact does not send');
  nodes(panel.app.render({ ...panel.props, onAction: freshAction })).find(node => node.type === 'SendInviteDialog')!.props.onSend(); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[1].path, '/participants/imported-person/email-invite'); assert.equal(calls[1].fresh, true);
  assert.equal(JSON.stringify(inviteGroup), before);
  const tree = panel.app.render(panel.props); assert.equal(panel.dialog(tree).props.person, undefined);
  assert.equal(nodes(tree).some(node => node.type === 'Text' && node.children.includes('Invitation sent')), false);
  assert.equal(nodes(tree).find(node => node.type === 'SendInviteDialog')!.props.visible, false, 'the explicit Send action already authorized this invitation');
  panel.app.unmount();
});

test('Unknown contact save retries the same command and never sends before accepted contact acknowledgment', async () => {
  const calls: any[] = []; const panel = memberPanel(async (path, body) => { calls.push({ path, body }); if (calls.length === 1) throw Error('Response lost'); return path.endsWith('/contact') ? { id: inviteGroup.id, version: 2 } : { id: inviteGroup.id, version: 3, linked_participant_ids: [], invite: { id: body.command_id, state: 'sending', retry_after: 60 } }; });
  panel.open('bad address').props.onSave(); await tick(); assert.equal(calls.length, 0);
  panel.dialog(panel.app.render(panel.props)).props.onEmail('asha@example.invalid'); panel.dialog(panel.app.render(panel.props)).props.onSave(); await tick();
  assert.equal(calls.length, 1); assert.ok(panel.dialog(panel.app.render(panel.props)).props.person);
  assert.match(panel.dialog(panel.app.render(panel.props)).props.feedback.text, /Response lost/);
  assert.equal(panel.dialog(panel.app.render(panel.props)).props.feedback.error, true);
  panel.dialog(panel.app.render(panel.props)).props.onSave(); await tick(); assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls.length, 2, 'accepted contact still needs Send confirmation');
  nodes(panel.app.render(panel.props)).find(node => node.type === 'SendInviteDialog')!.props.onSend(); await tick();
  assert.equal(calls.length, 3); const feedback = nodes(panel.app.render(panel.props)).find(node => node.type === 'SendInviteDialog')!.props;
  assert.match(feedback.error, /Could not confirm.*press Send to check/);
  assert.doesNotMatch(feedback.error, /Invitation sent to/); panel.app.unmount();
});

test('Failed invitation retains its UUID across explicit retry and reload', async () => {
  const calls: any[] = []; let fail = true;
  const action = async (path: string, body: any) => { calls.push({ path, body }); return path.endsWith('/contact') ? { id: inviteGroup.id, version: 2 } : { id: inviteGroup.id, version: 3, linked_participant_ids: [], invite: { id: body.command_id, state: fail ? 'failed' : 'sent', retry_after: 0 } }; };
  const panel = memberPanel(action); panel.open('asha@example.invalid').props.onSave(); await tick();
  const prompt = () => nodes(panel.app.render(panel.props)).find(node => node.type === 'SendInviteDialog')!;
  assert.equal(calls.length, 1); prompt().props.onSend(); await tick();
  const invitationId = calls[1].body.command_id; assert.match(prompt().props.error, /Could not send/);
  fail = false; prompt().props.onSend(); await tick(); assert.deepEqual(calls[2], calls[1]); assert.equal(prompt().props.visible, false); panel.app.unmount();
  const savedGroup = { ...inviteGroup, participants: [inviteGroup.participants[0], { ...inviteGroup.participants[1], email: 'asha@example.invalid' }], invites: [{ id: invitationId, participant_id: 'imported-person', intended_email: 'asha@example.invalid', send_state: 'sending', revoked: false, approved: false }] };
  const reload = memberPanel(action, savedGroup); reload.row(reload.app.render(reload.props)).props.onInvite();
  nodes(reload.app.render(reload.props)).find(node => node.type === 'PersonInviteDialog')!.props.onEmail();
  nodes(reload.app.render(reload.props)).find(node => node.type === 'SendInviteDialog')!.props.onSend(); await tick();
  assert.equal(calls.at(-1).body.command_id, invitationId); assert.ok(calls.every(call => call.path.includes('imported-person'))); reload.app.unmount();
});

test('Invitation never follows unaccepted contact, unmounted account or newly archived/claimed/removed group person', async () => {
  for (const change of ['unaccepted', 'unmounted', 'archived', 'claimed', 'removed', 'owner', 'email']) {
    const calls: string[] = []; let finish!: (value: any) => void;
    const panel = memberPanel(async path => { calls.push(path); return new Promise(resolve => { finish = resolve; }); });
    panel.open('asha@example.invalid').props.onSave(); await tick();
    if (change === 'unmounted') panel.app.unmount();
    else if (change !== 'unaccepted') panel.app.render({ ...panel.props, group: { ...inviteGroup, archived: change === 'archived', owner_id: change === 'owner' ? 2 : 1, participants: [inviteGroup.participants[0], { ...inviteGroup.participants[1], user_id: change === 'claimed' ? 2 : null, removed: change === 'removed', email: change === 'email' ? 'other@example.invalid' : '' }] } });
    finish({ id: change === 'unaccepted' ? 'wrong-group' : inviteGroup.id, version: 2 }); await tick();
    assert.equal(calls.length, 1, change); panel.app.unmount();
  }
});

test('Person dialog keeps invite permissions and nonzero removal guard with the person', () => {
  const panel = memberPanel(async () => ({})); panel.row(panel.app.render(panel.props)).props.onInvite();
  const dialog = nodes(panel.app.render(panel.props)).find(node => node.type === 'PersonInviteDialog')!;
  assert.equal(dialog.props.canInvite, true); assert.match(dialog.props.removeReason, /Settle their balance/);
  for (const patch of [{ archived: true }, { owner_id: 2 }]) {
    const tree = panel.app.render({ ...panel.props, group: { ...inviteGroup, ...patch } });
    assert.equal(nodes(tree).find(node => node.type === 'PersonInviteDialog')!.props.canInvite, false);
  }
  panel.app.unmount();
});


function statementPanel() {
  let saved = { enabled: false, frequency: 'monthly', next_at: null, delivery: null } as any;
  const writes: any[] = [], busy: boolean[] = [], timers = new Map<number, () => void>();
  let reads = 0, nextTimer = 0;
  let failSend = false;
  const app = harness('src/BalanceStatements.tsx', 'BalanceStatements', {
    setInterval: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval(id: number) { timers.delete(id); },
    AppState: { currentState: 'active' }, accountOwner: () => 'owner', getDatabase: async () => ({}),
    sendStatementRequest: async (_db: any, _owner: string, createId: () => string, send: (id: string) => Promise<any>) => send(createId()),
    request: async (_session: any, path: string, method = 'GET', value?: any) => {
      if (method === 'GET') { reads++; return structuredClone(saved); }
      writes.push({ path, method, value });
      if (path.endsWith('/send')) {
        if (failSend) throw new Error('Unknown response. Try again.');
        saved.delivery = { id: 'statement', state: 'pending', error: '' }; return saved.delivery;
      }
      saved = { ...saved, ...value, next_at: value.enabled ? '2026-11-01T00:00:00Z' : null }; return saved;
    },
  });
  const channels:any={state:{value:{email_notifications:true,statement_enabled:false,statement_frequency:'monthly'},pending:false,saving:false,error:''},change:async(patch:any)=>{channels.state.value={...channels.state.value,...patch,statement_enabled:true}},retry:async()=>true};
  const props = { session: { token: 'session' }, visible: true, channels, busy: false, onBusyChange: (value: boolean) => busy.push(value) };
  return { app, props, writes, busy, timers, reads: () => reads, fail: (value: boolean) => { failSend = value; } };
}

test('uncertain statement send retries the same command and blocks double taps', async () => {
  const panel = statementPanel(), { app, props } = panel;
  app.render(props); app.commit(); await tick(); let tree = app.render(props);
  panel.fail(true); const send = find(tree, 'title', 'Email statement now'); send.props.onPress(); send.props.onPress();
  await tick(); assert.equal(panel.writes.length, 1); tree = app.render(props);
  assert.ok(nodes(tree).some(node => node.type === 'ErrorText'));
  panel.fail(false); find(tree, 'title', 'Email statement now').props.onPress(); await tick();
  assert.equal(panel.writes.length, 2); assert.deepEqual(panel.writes[0], panel.writes[1]);
  assert.deepEqual(panel.busy, []);
  app.unmount();
});

test('statement feedback uses plain language for scheduled, sent and failed email', () => {
  const app = harness('src/BalanceStatements.tsx', 'StatementDelivery');
  const text = (tree: any): string => nodes(tree).flatMap(node => node.children).filter(child => typeof child === 'string').join(' ');
  assert.match(text(app.render({ delivery: { state: 'pending', error: '' } })), /will be emailed/);
  assert.match(text(app.render({ delivery: { state: 'accepted', error: '' } })), /has been emailed/);
  assert.match(text(app.render({ delivery: { state: 'failed', error: 'too_big' } })), /too large/);
  assert.match(text(app.render({ delivery: { state: 'held', error: 'delivery_unknown' } })), /Check your inbox/);
});


test('statement polling stops when hidden/unmounted and makes no native background requests', async () => {
  const panel = statementPanel(), { app, props } = panel;
  app.render(props); app.commit(); await tick(); let tree = app.render(props);
  find(tree, 'title', 'Email statement now').props.onPress(); await tick(); tree = app.render(props); app.commit();
  assert.equal(find(tree, 'title', 'Email statement now').props.disabled, true);
  assert.equal(panel.timers.size, 1);
  app.env.AppState.currentState = 'background'; const reads = panel.reads();
  panel.timers.forEach(fn => fn()); await tick(); assert.equal(panel.reads(), reads);
  app.env.AppState.currentState = 'active'; panel.timers.forEach(fn => fn()); await tick(); assert.ok(panel.reads() > reads);
  app.env.Platform.OS = 'web'; app.env.document = { visibilityState: 'hidden' }; const webReads = panel.reads();
  panel.timers.forEach(fn => fn()); await tick(); assert.equal(panel.reads(), webReads);
  app.render({ ...props, visible: false }); app.commit(); assert.equal(panel.timers.size, 0);
  app.unmount(); assert.equal(panel.timers.size, 0);
});

test('shared radio keeps Paper on native and a labelled standard input on web', () => {
  let choices = 0;
  const props = { label: 'Weekly', value: 'weekly', group: 'statement-frequency', selected: true, disabled: false, onPress: () => choices++ };
  const web = harness('src/RadioChoice.web.tsx', 'RadioChoice', { appFontFamily: '"Stack Sans Text", system-ui, sans-serif', useUI: () => ({ palette: {} }) }).render(props);
  const input = nodes(web).find(node => node.type === 'input')!;
  assert.equal(web.type, 'label'); assert.equal(input.props.type, 'radio'); assert.equal(input.props.checked, true); assert.equal(input.props.name, props.group);
  input.props.onChange(); assert.equal(choices, 1);
  const native = harness('src/RadioChoice.tsx', 'RadioChoice', { RadioButton: { Item: 'RadioItem' } }).render(props);
  assert.equal(native.type, 'RadioItem'); assert.equal(native.props.status, 'checked'); assert.equal(native.props.value, props.value);
});


test('notification body uses spare desktop height while retaining compact phones and the native cap', () => {
  for (const [os, height, expected] of [['web', 900, 520], ['web', 667, 443], ['web', 500, 276], ['native', 900, 400]] as const) {
    const { app, props } = notificationPanel({ expense_updates: true, email_reminders: true });
    app.env.Platform.OS = os; app.env.useWindowDimensions = () => ({ height });
    const tree = app.render(props);
    assert.equal(nodes(tree).find(node => node.type === 'DialogScrollBody')!.props.maxHeight, expected);
    app.unmount();
  }
});


test('One member action opens name, email and removal controls inside a dialog', () => {
  const app = harness('src/PersonInviteDialog.tsx', 'PersonInviteDialog', { SettingsRow: 'SettingsRow' });
  let edits = 0, invitations = 0;
  const tree = app.render({ person: { id: 'other', name: 'Asha' }, invites: [], busy: false, canInvite: true, canRename: true, canRemove: true, removeReason: 'Settle their balance before removing them.', onRename() { edits++; }, onEmail() { invitations++; } });
  find(tree, 'label', 'Edit name').props.onPress(); find(tree, 'label', 'Send email invite').props.onPress();
  assert.equal(edits, 1); assert.equal(invitations, 1); assert.equal(find(tree, 'label', 'Remove person').props.disabled, true);
});


test('balance sheet hides changed calculations, ignores late closed loads, and stays read-only', async () => {
  let resolve!: (value: any) => void, restores = 0, closes = 0;
  const group = { id: 'g', name: 'Trip', version: 1, participants: [{ id: 'A', name: 'Riya' }, { id: 'B', name: 'Asha' }], expenses: [{ id: 'bill', description: 'Lunch', total: '501', paid: { B: '501' }, shares: { A: '501' }, date: '2026-10-19', deleted: false }], settlements: [], balances: { A: '-501', B: '501' }, transfers: [{ sender: 'A', recipient: 'B', amount: '501' }], activity: [] };
  const selection = { group, accepted: group, selfId: 'A', commands: [], transfer: group.transfers[0], restoreFocus: () => restores++, load: () => new Promise(done => { resolve = done; }) };
  const app = harness('src/BalanceExplanationDialog.tsx', 'BalanceExplanation', { explainTransfer, balanceKey, changedBalance: 'This balance changed.', Disclosure: 'Disclosure' });
  const props = { selection, currentKey: balanceKey(group as any, []), onClose: () => closes++ };
  let tree = app.render(props); app.commit();
  assert.equal(nodes(tree).find(node => node.type === 'BottomSheet')!.props.visible, true);
  assert.ok(nodes(tree).some(node => node.type === 'Text' && node.children.includes('Loading the full breakdown…')));
  resolve({ group, saved: true }); await tick(); tree = app.render(props); app.commit();
  assert.ok(nodes(tree).some(node => typeof node.type === 'function' && node.type.name === 'ExplanationBody'));
  assert.ok(!nodes(tree).some(node => ['Pay', 'Record', 'Record payment'].includes(node.props.title)));
  const changed = app.render({ ...props, currentKey: 'newer group' }); app.commit();
  assert.ok(!nodes(changed).some(node => typeof node.type === 'function' && node.type.name === 'ExplanationBody'));
  assert.ok(nodes(changed).some(node => node.props.accessibilityRole === 'alert'));
  find(tree, 'doneAccessibilityLabel', 'Close explanation').props.onDismiss(); assert.equal(closes, 1); assert.equal(restores, 1);
  assert.doesNotThrow(() => app.render({ ...props, selection: null }), 'closing renders safely before effects clear the loaded result');
  app.commit();
  const next = { ...selection };
  app.render({ ...props, selection: next }); app.commit();
  const old = resolve;
  app.render({ ...props, selection: null }); app.commit();
  old({ group, saved: false }); await tick();
  tree = app.render({ ...props, selection: null });
  assert.equal(nodes(tree).find(node => node.type === 'BottomSheet')!.props.visible, false);
  assert.ok(!nodes(tree).some(node => typeof node.type === 'function' && node.type.name === 'ExplanationBody'));
  app.unmount();
});

test('running balance expands in the same dialog and collapses accessibly', () => {
  const app = harness('src/BalanceExplanationDialog.tsx', 'InlineDetails', { useUI: () => ({ ui: {}, palette: {} }) });
  const props = { title: 'Show running balance', expandedTitle: 'Hide running balance', children: 'Running history' };
  let tree = app.render(props), toggle = find(tree, 'accessibilityRole', 'button');
  assert.equal(toggle.props.accessibilityState.expanded, false);
  assert.ok(!nodes(tree).some(node => node.children.includes('Running history')));
  toggle.props.onPress(); tree = app.render(props); toggle = find(tree, 'accessibilityRole', 'button');
  assert.equal(toggle.props.accessibilityLabel, 'Hide running balance');
  assert.equal(toggle.props.accessibilityState.expanded, true);
  assert.ok(nodes(tree).some(node => node.children.includes('Running history')));
  assert.ok(!nodes(tree).some(node => node.type === 'KeyboardDialog'));
  toggle.props.onPress(); tree = app.render(props);
  assert.equal(find(tree, 'accessibilityRole', 'button').props.accessibilityState.expanded, false);
});

test('quick answer shows the other person\'s share when you paid an unequal bill', () => {
  const group = { id: 'friend', version: 1, name: 'Friend', participants: [{ id: 'A', name: 'Riya' }, { id: 'B', name: 'Asha' }], expenses: [{ id: 'bill', description: 'Lunch', total: '1000', paid: { A: '1000' }, shares: { A: '667', B: '333' }, split: { mode: 'exact', values: { A: '667', B: '333' } }, date: '2026-10-28', deleted: false }], settlements: [], balances: { A: '333', B: '-333' }, transfers: [{ sender: 'B', recipient: 'A', amount: '333' }], activity: [] };
  const value = explainTransfer(group as any, group as any, 'A', group.transfers[0]);
  const app = harness('src/BalanceExplanationDialog.tsx', 'ExplanationBody', { IconBadge: 'IconBadge', balanceColor: () => '', useUI: () => ({ ui: {}, palette: {} }) });
  const tree = app.render({ value, selfId: 'A' });
  assert.ok(nodes(tree).some(node => node.children.includes('Asha owes you')));
  assert.ok(nodes(tree).some(node => node.children.includes("Asha's share")));
  assert.ok(!nodes(tree).some(node => node.children.includes('Your share')));
  assert.ok(!nodes(tree).some(node => node.type === 'DetailDialog'));
  const partial = { ...group, expenses: [{ ...group.expenses[0], total: '2500', paid: { A: '500', B: '2000' }, shares: { A: '1250', B: '1250' } }], balances: { A: '-750', B: '750' }, transfers: [{ sender: 'A', recipient: 'B', amount: '750' }] };
  const partialTree = app.render({ value: explainTransfer(partial as any, partial as any, 'A', partial.transfers[0]), selfId: 'A' });
  assert.ok(nodes(partialTree).some(node => node.children.includes('Effect on your balance')));
  assert.ok(nodes(partialTree).some(node => node.children.includes('Your share ') && node.children.includes('₹12.50')));
});

test('payment address stays selectable, copies the full ID and recovers from clipboard denial', async () => {
  const copied: string[] = [];
  let denied = false;
  const app = harness('src/PaymentPanels.tsx', 'PaymentAddress', { copyText: async (value: string) => { if (denied) throw Error('Denied'); copied.push(value); } });
  const props = { name: 'Asha', vpa: `${'long'.repeat(12)}@example` };
  let tree = app.render(props);
  assert.ok(nodes(tree).some(node => node.props.selectable && node.children.includes(props.vpa)));
  find(tree, 'accessibilityLabel', "Copy Asha's UPI ID").props.onPress(); await tick();
  assert.deepEqual(copied, [props.vpa]); assert.ok(find(app.render(props), 'title', 'Copied'));
  const changed = { name: 'Noor', vpa: 'noor@example' };
  tree = app.render(changed); assert.ok(find(tree, 'title', 'Copy'), 'copy feedback belongs to the displayed address');
  denied = true; find(tree, 'title', 'Copy').props.onPress(); await tick();
  tree = app.render(changed);
  assert.ok(nodes(tree).some(node => node.type === 'ErrorText' && node.props.live));
  assert.ok(nodes(tree).some(node => node.props.selectable && node.children.includes(changed.vpa)));
  denied = false; find(tree, 'title', 'Copy').props.onPress(); await tick();
  tree = app.render(changed); assert.ok(find(tree, 'title', 'Copied')); assert.ok(!nodes(tree).some(node => node.type === 'ErrorText'));
});

test('payment page shows the other person’s address in both directions and the frozen payee on return', () => {
  const paymentGroup = { ...group, transfers: [], participants: [
    { id: 'self', name: 'Riya', profile_photo: { id: 'self-photo' }, payment_profile: { vpa: 'own@example' } },
    { id: 'other', name: 'Asha', profile_photo: { id: 'other-photo' }, payment_profile: { vpa: 'asha@example' } },
  ] };
  const env = { useMemo: (fn: () => unknown) => fn(), useUI: () => ({ ui: {}, palette: {} }), isPersonalPayment, paymentReturnNeedsConfirmation,
    PaymentAddress: 'PaymentAddress', PaymentHelpDialog: 'PaymentHelpDialog', LoadingSpinner: 'LoadingSpinner', UPIAppChooser: 'UPIAppChooser', WebPaymentQuote: 'WebPaymentQuote' };
  for (const incoming of [false, true]) {
    const props = { group: paymentGroup, selfId: 'self', busy: true, returnPayment: null,
      initial: { sender: incoming ? 'other' : 'self', recipient: incoming ? 'self' : 'other', amount: '500' } };
    const tree = harness('src/SettleForm.tsx', 'SettleForm', env).render(props);
    const portraits = nodes(tree).filter(node => node.type === 'Avatar');
    assert.deepEqual(portraits.map(node => node.props.name), incoming ? ['Asha', 'Riya'] : ['Riya', 'Asha']);
    assert.deepEqual(portraits.map(node => node.props.photo.id), incoming ? ['other-photo', 'self-photo'] : ['self-photo', 'other-photo']);
    assert.ok(nodes(tree).some(node => node.type === 'Icon' && node.props.name === 'direction'));
    const address = nodes(tree).find(node => node.type === 'PaymentAddress')!;
    assert.equal(address.props.name, 'Asha'); assert.equal(address.props.vpa, 'asha@example');
    assert.equal(address.props.disabled, undefined, 'copy remains available while financial actions are busy');
    const missing = harness('src/SettleForm.tsx', 'SettleForm', env).render({ ...props, group: { ...paymentGroup, participants: paymentGroup.participants.map(person => person.id === 'other' ? { ...person, payment_profile: null } : person) } });
    assert.ok(!nodes(missing).some(node => node.type === 'PaymentAddress'), 'never substitutes the signed-in person’s address');
  }
  const tree = harness('src/SettleForm.tsx', 'SettleForm', env).render({ group: paymentGroup, selfId: 'self', busy: false,
    returnPayment: { groupId: 'g', sender: 'self', recipient: 'other', payeeName: 'Original Asha', vpa: 'frozen@example', amount: '500', launch: 'opened', decision: null } });
  const address = nodes(tree).find(node => node.type === 'PaymentAddress')!;
  assert.equal(address.props.name, 'Original Asha'); assert.equal(address.props.vpa, 'frozen@example');
});

test('QR payment page uses the same address row and retains a separate copy-payment-link action', () => {
  const links: string[] = [], quote = { recipient: 'Asha', vpa: 'frozen@example', amount: '500' };
  const tree = harness('src/PaymentPanels.tsx', 'WebPaymentQuote', { PaymentAddress: 'PaymentAddress', QRCode: 'QRCode' }).render({ quote, url: 'upi://pay?synthetic', disabled: false, onCopy: (value: string) => links.push(value) });
  const address = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'PaymentAddress')!;
  assert.equal(address.props.name, quote.recipient); assert.equal(address.props.vpa, quote.vpa);
  find(tree, 'title', 'Copy payment link').props.onPress(); assert.deepEqual(links, ['upi://pay?synthetic']);
  assert.ok(!find(tree, 'title', 'Copy UPI address'), 'the ID has only one copy action');
});

test('clipboard uses the native write boundary on phones and awaits browser success or failure', async () => {
  const copied: string[] = [];
  const native = harness('src/clipboard.ts', 'copyText', { Clipboard: { setString: (value: string) => copied.push(value) } });
  await native.render('native@example'); assert.deepEqual(copied, ['native@example']);
  let finish!: () => void;
  const web = harness('src/clipboard.web.ts', 'copyText', { navigator: { clipboard: { writeText: (value: string) => new Promise<void>(resolve => { copied.push(value); finish = resolve; }) } } });
  let complete = false; const pending = web.render('web@example').then(() => { complete = true; });
  await tick(); assert.equal(complete, false); finish(); await pending;
  assert.deepEqual(copied, ['native@example', 'web@example']);
  web.env.navigator.clipboard.writeText = async () => { throw Error('Denied'); };
  await assert.rejects(web.render('denied@example'), /Denied/);
  web.env.navigator.clipboard = undefined;
  await assert.rejects(web.render('unsupported@example'));
});

test('feedback has one field, blocks blank/double submission and keeps its form and reports Sent only after acknowledgment', async () => {
  const sent: any[] = [];
  let finish!: () => void, closes = 0;
  const app = harness('src/FeedbackDialog.tsx', 'FeedbackDialog', { DialogFocus: 'DialogFocus', CancelDialogActions: 'CancelDialogActions' });
  const props = { visible: true, onClose: () => closes++, onSubmit: (body: any) => { sent.push(body); return new Promise<void>(resolve => { finish = resolve; }); } };
  let tree = app.render(props); app.commit();
  assert.equal(nodes(tree).filter(node => node.type === 'TextField').length, 1);
  assert.equal(find(tree, 'title', 'Send feedback').props.disabled, true);
  find(tree, 'label', 'Your feedback').props.onChangeText('  Make lunch easier  ');
  tree = app.render(props);
  find(tree, 'title', 'Send feedback').props.onPress(); find(tree, 'title', 'Send feedback').props.onPress();
  assert.equal(sent.length, 1); assert.equal(sent[0].text, 'Make lunch easier');
  tree = app.render(props); assert.equal(find(tree, 'title', 'Sending').props.disabled, true);
  nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.onDismiss(); assert.equal(closes, 0);
  assert.ok(!nodes(tree).some(node => node.type?.name === 'FeedbackThanks'));
  finish(); await tick(); tree = app.render(props);
  const sentButton = find(tree, 'title', 'Sent');
  assert.ok(sentButton.props.disabled); assert.ok(nodes(tree).some(node => node.type === 'TextField'));
  nodes(tree).find(node => node.type === 'CancelDialogActions')!.props.onCancel(); assert.equal(closes, 1);
  assert.equal(find(app.render(props), 'label', 'Your feedback').props.value, '');
});

test('uncertain feedback preserves the exact submission through close/reopen and retries without changing accounts', async () => {
  const sent: any[] = [];
  let first = true;
  const app = harness('src/FeedbackDialog.tsx', 'FeedbackDialog', { DialogFocus: 'DialogFocus', CancelDialogActions: 'CancelDialogActions' });
  const props = { visible: true, onClose() {}, onSubmit: async (body: any) => { sent.push(body); if (first) { first = false; throw Error('Response lost'); } } };
  let tree = app.render(props); app.commit();
  find(tree, 'label', 'Your feedback').props.onChangeText('Synthetic feedback');
  find(app.render(props), 'title', 'Send feedback').props.onPress(); await tick();
  tree = app.render(props);
  assert.ok(nodes(tree).some(node => node.type === 'ErrorText'));
  assert.equal(find(tree, 'label', 'Your feedback').props.editable, false);
  nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.onDismiss();
  app.render({ ...props, visible: false }); tree = app.render(props);
  find(tree, 'title', 'Send feedback').props.onPress(); await tick();
  assert.equal(sent.length, 2); assert.equal(sent[1], sent[0]);
  assert.ok(find(app.render(props), 'title', 'Sent').props.disabled);
  app.unmount();
});

test('header keeps Feedback rightmost without a global spinner or empty slot', () => {
  let opens = 0;
  const env = { IconAction: 'IconAction', ActivityIndicator: 'ActivityIndicator', radii: { navigation: 20, surface: 16 }, pageWidthStyle: {}, useUI: () => ({ palette: {} }) };
  const app = harness('src/AppNavigation.tsx', 'ScreenHeader', env), props = { title: 'Groups', busy: false, onFeedback: () => opens++ };
  let tree = app.render(props);
  find(tree, 'label', 'Feedback').props.onPress(); assert.equal(opens, 1);
  assert.ok(!nodes(tree).some(node => node.type === 'ActivityIndicator'));
  assert.ok(!nodes(tree).some(node => node.props.style?.width === 44 && node.props.style?.height === 44));
  assert.equal(tree.children.filter(Boolean).at(-1).props.label, 'Feedback');
  tree = app.render({ ...props, busy: true });
  assert.ok(find(tree, 'label', 'Feedback')); find(tree, 'label', 'Feedback').props.onPress(); assert.equal(opens, 2);
  assert.equal(nodes(tree).filter(node => node.type === 'ActivityIndicator').length, 0);
  assert.equal(tree.children.filter(Boolean).at(-1).props.label, 'Feedback');
  assert.ok(!find(app.render({ title: 'Payment', busy: false }), 'label', 'Feedback'));
});

test('Payment failed opens frozen-address help without answering or changing the payment', () => {
  let writes = 0;
  const env = { useMemo: (fn: () => unknown) => fn(), useUI: () => ({ ui: {}, palette: {} }), isPersonalPayment, paymentReturnNeedsConfirmation,
    PaymentAddress: 'PaymentAddress', PaymentHelpDialog: 'PaymentHelpDialog', LoadingSpinner: 'LoadingSpinner', UPIAppChooser: 'UPIAppChooser' };
  const app = harness('src/SettleForm.tsx', 'SettleForm', env);
  const props = { group: { ...group, transfers: [] }, selfId: 'self', busy: false,
    returnPayment: { groupId: 'g', sender: 'self', recipient: 'other', payeeName: 'Original payee', vpa: 'original@example', amount: '500', launch: 'opened', decision: null, reviewRequested: true },
    onSave: () => writes++, onResolveReturn: () => writes++, onReturnPaymentChange: () => writes++ };
  let tree = app.render(props);
  assert.ok(find(tree, 'title', 'Yes, I paid')); assert.ok(find(tree, 'title', 'No'));
  find(tree, 'title', 'Payment failed').props.onPress(); tree = app.render(props);
  const help = nodes(tree).find(node => node.type === 'PaymentHelpDialog')!;
  assert.equal(help.props.visible, true); assert.equal(help.props.vpa, 'original@example'); assert.equal(help.props.name, 'Original payee');
  help.props.onClose(); assert.equal(nodes(app.render(props)).find(node => node.type === 'PaymentHelpDialog')!.props.visible, false);
  assert.equal(writes, 0);
  const dialog = harness('src/PaymentPanels.tsx', 'PaymentHelpDialog', { DialogFocus: 'DialogFocus' }).render({ visible: true, name: 'Original payee', vpa: 'original@example', onClose() {} });
  assert.deepEqual(nodes(dialog).filter(node => node.type === 'Button').map(node => node.props.title), ['Close payment help']);
  assert.ok(nodes(dialog).some(node => typeof node.type === 'function' && node.type.name === 'PaymentAddress' && node.props.vpa === 'original@example'));
});

test('Google Pay info pill opens address help without selecting an app or preparing a payment', () => {
  let chosen = 0;
  const app = harness('src/PaymentPanels.tsx', 'UPIAppChooser', { TouchableRipple: 'TouchableRipple', radii: { button: 8 }, useUI: () => ({ palette: {} }), UPIAppIcon: 'UPIAppIcon', CancelDialogActions: 'CancelDialogActions' });
  const props = { apps: [{ id: 'google-pay', name: 'Google Pay' }, { id: 'upi', name: 'Other UPI app' }], recipient: { name: 'Asha', vpa: 'asha@example' }, disabled: false, onChoose: () => chosen++, onDismiss() {} };
  let tree = app.render(props); app.commit();
  const pill = find(tree, 'accessibilityLabel', 'Why Google Pay might fail');
  assert.ok(pill); pill.props.onPress(); tree = app.render(props);
  const help = nodes(tree).find(node => node.type?.name === 'PaymentHelpDialog')!;
  assert.equal(help.props.visible, true); assert.equal(help.props.kind, 'google-pay'); assert.equal(help.props.vpa, props.recipient.vpa); assert.equal(chosen, 0);
  help.props.onClose(); tree = app.render(props);
  const launch = find(tree, 'accessibilityLabel', 'Google Pay');
  const row = nodes(tree).find(node => node.children.includes(launch) && node.children.some((child: any) => child?.props?.accessibilityLabel === 'Why Google Pay might fail'))!;
  assert.ok(row && !row.props.onPress, 'main and info are sibling actions in one noninteractive visual surface');
  assert.ok(!nodes(pill).slice(1).some(node => node.props.onPress), 'no nested interactive control');
  launch.props.onPress(); assert.equal(chosen, 1);
  const locked = app.render({ ...props, disabled: true });
  assert.equal(find(locked, 'accessibilityLabel', 'Google Pay').props.disabled, true);
  assert.equal(find(locked, 'accessibilityLabel', 'Why Google Pay might fail').props.disabled, true);
  app.unmount();
});

test('UPI setup follows name, can be skipped, validates format and waits for save confirmation', async () => {
  let skips = 0, saves = 0, finish!: () => void;
  const app = harness('src/UPISetupDialog.tsx', 'UPISetupDialog', { DialogFocus: 'DialogFocus', NameOnlyForm: 'NameOnlyForm' });
  const props = { visible: true, busy: false, needsName: false, onSaveName: async () => {}, onSkip: () => skips++, onSave: async (value: string) => { assert.equal(value, 'name@example'); saves++; await new Promise<void>(resolve => { finish = resolve; }); } };
  let tree = app.render({ ...props, needsName: true }); app.commit();
  assert.ok(nodes(tree).some(node => node.type === 'NameOnlyForm'));
  assert.ok(!nodes(tree).some(node => node.type === 'TextField'));
  tree = app.render(props); find(tree, 'title', 'Skip UPI setup').props.onPress(); assert.equal(skips, 1); assert.equal(saves, 0);
  assert.equal(find(tree, 'title', 'Save UPI ID').props.disabled, true);
  find(tree, 'label', 'UPI ID (optional)').props.onChangeText(' name@example ');
  tree = app.render(props); find(tree, 'title', 'Save UPI ID').props.onPress(); find(tree, 'title', 'Save UPI ID').props.onPress();
  assert.equal(saves, 1); assert.equal(skips, 1);
  finish(); await tick(); assert.equal(skips, 2);
  app.unmount();
});

test('profile read prompts once only when missing UPI, never overwrites another account or known address', async () => {
  const session = { baseUrl: 'https://synthetic.invalid', userId: '1', token: 'session-a' }, activeSessionRef = { current: session };
  const owner = `${session.baseUrl}|1`, prompts: boolean[] = [], addresses: string[] = [];
  let me = { display_name: 'Asha', payment_profile: null as null | { vpa: string } };
  const route = {}; const env: Record<string, any> = { categoryIcon, expenseCategory, changedBalance, useExpenseIcons: () => ({}), animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, navigation: { ref: { getRootState: () => route } }, profileRevision: { current: 0 }, profilePromptSafe: { current: true }, request: async () => me, rememberName: async () => {}, activeSessionRef, ownerRef: { current: owner }, accountOwner: (value: any) => `${value.baseUrl}|${value.userId}`, setVpa: (value: string) => addresses.push(value), setUpiSetup: (value: boolean) => prompts.push(value), upiPrompts: { current: new Set() } };
  const read = appAction('readProfile', env);
  await read(session); await read(session); assert.deepEqual(prompts, [true]);
  me = { ...me, payment_profile: { vpa: 'known@example' } }; await read(session);
  assert.deepEqual(prompts, [true], 'a background read never closes an open setup dialog'); assert.equal(addresses.at(-1), 'known@example');
  activeSessionRef.current = { ...session, token: 'session-b' }; await read(session);
  assert.equal(addresses.length, 3);
});


test('Failed optional UPI save retains the address and never dismisses as saved', async () => {
  let skips = 0;
  const app = harness('src/UPISetupDialog.tsx', 'UPISetupDialog', { DialogFocus: 'DialogFocus', NameOnlyForm: 'NameOnlyForm' });
  const props = { visible: true, busy: false, needsName: false, onSaveName: async () => {}, onSkip: () => skips++, onSave: async () => { throw Error('Offline'); } };
  let tree = app.render(props); app.commit();
  find(tree, 'label', 'UPI ID (optional)').props.onChangeText('name@example');
  tree = app.render(props); find(tree, 'title', 'Save UPI ID').props.onPress(); await tick(); tree = app.render(props);
  assert.equal(skips, 0); assert.equal(find(tree, 'label', 'UPI ID (optional)').props.value, 'name@example');
  assert.ok(nodes(tree).some(node => node.type === 'ErrorText'));
  app.unmount();
});

test('Shared Button forwards Paper dialog spacing without changing disabled or press behavior', () => {
  const source = ts.createSourceFile('ui.tsx', readFileSync(new URL('../src/ui.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(source) === 'Button'))!;
  const code = ts.transpile(declaration.getText(source).replace(/^export /, ''), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  const env = { tapHaptic() {}, animateLayout() {}, React: { ...React, forwardRef: (render: any) => render }, useState: () => [false, () => {}], View: 'View', Text: 'Text', Pressable: 'Pressable', useUI: () => ({ palette: {}, ui: {} }), usePressFeedback: () => ({ pressedStyle: {} }), PaperButton: 'PaperButton', Icon: 'Icon', radii: { button: 8 }, Platform: { OS: 'ios' } };
  const Button = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${code};return Button;}`)(withSharedUI(env));
  const injected = [{ marginRight: 8 }], onPress = () => {};
  for (const disabled of [false, true]) {
    const element = Button({ title: 'Cancel', kind: 'text', compact: true, style: injected, disabled, onPress });
    assert.ok(element.props.style({ pressed: false }).includes(injected), 'preserve Dialog.Actions child spacing');
    element.props.onPress({}); assert.equal(element.props.disabled, disabled);
    assert.equal(element.props.accessibilityLabel, 'Cancel');
  }
});










function billDiscardDialog(env: Record<string, any>) {
  const source = ts.createSourceFile('AppStack.tsx', readFileSync(new URL('../src/AppStack.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.JsxElement | undefined;
  function visit(node: ts.Node) { if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'KeyboardDialog') expression = node; ts.forEachChild(node, visit); }
  visit(source); assert.ok(expression);
  const code = ts.transpile(`const dialog = ${expression!.getText(source)}`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  return new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${code};return dialog;}`)(withSharedUI({ React, Dialog, PersonInviteDialog: 'PersonInviteDialog', useToast: () => () => {}, DetailDialog: 'DetailDialog', setDiscarding() {}, draftDiscard: { current: null }, discarding: false, discardLock: { current: false }, blocked: false, localBlocked: false, pending: env.discardBill ? { type: 'GO_BACK' } : null, setPending: (value: unknown) => env.setDiscardBill(!!value), KeyboardDialog: 'KeyboardDialog', BottomSheet: 'BottomSheet', DialogFocus: 'DialogFocus', CancelDialogActions: 'CancelDialogActions', Button: 'Button', ...env, navigation: { isFocused: () => true, dispatch: () => env.navigate('group') } }));
}

test('Back asks to discard the bill, Cancel retains the form and Discard leaves with the trash action', async () => {
  let open = false; const screens: string[] = [];
  const env = { screen: 'expense', session: {}, navigation: { back: () => { open = true; } }, setDiscardBill: (value: boolean) => { open = value; }, navigate: (value: string) => screens.push(value) };
  appAction('back', env)(); assert.equal(open, true); assert.deepEqual(screens, []);
  const tree = billDiscardDialog({ ...env, discardBill: open });
  assert.ok(nodes(tree).some(node => node.children.includes('Do you want to discard the draft?')));
  nodes(tree).find(node => node.type === 'CancelDialogActions')!.props.onCancel();
  assert.equal(open, false); assert.deepEqual(screens, [], 'Cancel keeps the same form mounted');
  const discard = find(tree, 'title', 'Discard'); assert.equal(discard.props.kind, 'danger'); assert.equal(discard.props.icon, 'remove');
  discard.props.onPress(); await tick(); assert.deepEqual(screens, ['group']);
});

test('unmount retains a recoverable staged file and a submitted file stays with its queued bill', async () => {
  for (const submit of [false, true]) {
    const cleared: any[] = [], app = harness('src/ExpenseForm.tsx', 'ExpenseForm', { clearStagedMedia: async (file: any) => { cleared.push(file); } });
    const props = { group, selfId: 'self', busy: false, onSave: async () => {} };
    let tree = app.render(props); app.commit();
    const attachment = { id: 'file', file: { uri: 'file:///synthetic.png' } };
    nodes(tree).find(node => node.type === 'DraftAttachment')!.props.onChange(attachment);
    payerFields(app, props).onChange({ amount: '10', description: 'Lunch' });
    tree = app.render(props);
    if (submit) { find(tree, 'title', 'Save bill').props.onPress(); await tick(); }
    app.unmount(); await tick(); assert.deepEqual(cleared, []);
  }
});


test('actual bill save transfers file ownership at commit, retaining exact queued work after load failure and discard/reopen', async () => {
  for (const phase of ['before commit', 'after commit']) {
    const folder = mkdtempSync(join(tmpdir(), 'bill-ownership-')), database = join(folder, 'cache.sqlite'), file = join(folder, 'staged.png'), otherFile = join(folder, 'other.png');
    writeFileSync(file, 'synthetic attachment bytes'); writeFileSync(otherFile, 'other account bytes');
    let raw = new DatabaseSync(database), failing = true;
    try {
      const base = sqliteAdapter(raw); await migrate(base);
      const db = { ...base, withExclusiveTransactionAsync: (task: Parameters<typeof base.withExclusiveTransactionAsync>[0]) => base.withExclusiveTransactionAsync(async tx => { await task(tx); if (phase === 'before commit' && failing) throw Error('SQLite commit failed'); }) };
      const session = { baseUrl: 'https://ownership.invalid', userId: '1', email: 'one@example.invalid', token: 'synthetic' }, owner = accountOwner(session), other = { ...session, userId: '2' };
      const attachment = { id: 'file-id', path: '/groups/g/expenses/bill-id/attachments', file: { uri: pathToFileURL(file).href, name: 'receipt.png', type: 'image/png', size: 26 } };
      await enqueue(base, accountOwner(other), { command_id: 'other-command', group_id: 'g', method: 'POST', path: '/groups/g/expenses', body: { id: 'other-bill' }, state: 'pending', error: null });
      await saveMediaUpload(base, other, { ...attachment, id: 'other-file', file: { ...attachment.file, uri: pathToFileURL(otherFile).href } });
      const otherBefore = JSON.stringify({ commands: await pendingCommands(base, accountOwner(other)), media: await pendingMediaUpload(base, other, attachment.path) });
      let discardOpen = false, completion: Promise<unknown> | undefined; const screens: string[] = [];
      const env: Record<string, any> = { categoryIcon, expenseCategory, changedBalance, useExpenseIcons: () => ({}), animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, selected: { group: { ...group, version: 1 } }, session, owner, groupId: 'g', expenseId: null, reviewCommand: null,
        perform: (action: any) => action(), draftWrites: { current: Promise.resolve() }, getDatabase: async () => db,
        expensePayload, uuid: () => 'bill-command', enqueueExpenseWithMedia, enqueue, enqueueBill, replaceCommand,
        requireConnectionForTemporaryStorage() {}, load: async () => { if (phase === 'after commit' && failing) throw Error('Projection read failed'); },
        setReviewCommand() {}, setReviewInput() {}, navigate: (screen: string) => screens.push(screen), isOnline: () => false };
      env.command = appAction('command', env); env.queue = appAction('queue', env); env.saveExpense = appAction('saveExpense', env);
      const app = harness('src/ExpenseForm.tsx', 'ExpenseForm', { clearStagedMedia: async (value: any) => { unlinkSync(fileURLToPath(value.uri)); } });
      const props = { group, selfId: 'self', busy: false, onSave: (...args: any[]) => { const saving = env.saveExpense(...args); completion = saving.then(() => {}, () => {}); return saving; } };
      let tree = app.render(props); app.commit();
      await nodes(tree).find(node => node.type === 'DraftAttachment')!.props.onChange(attachment);
      payerFields(app, props).onChange({ amount: '10.00', description: 'Saved bill' });
      find(app.render(props), 'title', 'Save bill').props.onPress(); await Promise.resolve(); await completion; await tick();
      tree = app.render(props);
      assert.equal(existsSync(file), true, 'a failed save never clears the recoverable file');
      assert.equal((await pendingCommands(base, owner)).length, phase === 'before commit' ? 0 : 1);
      assert.equal(!!await pendingMediaUpload(base, session, attachment.path), phase === 'after commit');
      const backEnv = { screen: 'expense', session: {}, navigation: { back: () => { discardOpen = true; } }, setDiscardBill: (value: boolean) => { discardOpen = value; }, navigate: env.navigate };
      appAction('back', backEnv)();
      nodes(billDiscardDialog({ ...backEnv, discardBill: discardOpen })).find(node => node.type === 'CancelDialogActions')!.props.onCancel();
      assert.equal(discardOpen, false); assert.deepEqual(screens, []); assert.equal(existsSync(file), true);
      assert.equal(find(app.render(props), 'label', 'Amount (₹)').props.value, '10.00', 'Cancel keeps the current form and file');
      if (phase === 'before commit') {
        assert.equal(!!find(tree, 'title', 'Save bill').props.disabled, false, 'failed persistence remains recoverable');
        failing = false; find(tree, 'title', 'Save bill').props.onPress(); await Promise.resolve(); await completion; await tick();
      }
      const snapshot = async (connection: any) => JSON.stringify({ commands: await pendingCommands(connection, owner), media: await pendingMediaUpload(connection, session, attachment.path) });
      const queued = await snapshot(base); assert.equal((await pendingCommands(base, owner))[0].command_id, 'bill-command');
      appAction('back', backEnv)(); find(billDiscardDialog({ ...backEnv, discardBill: discardOpen }), 'title', 'Discard').props.onPress();
      app.unmount(); await tick();
      assert.equal(existsSync(file), true, 'discard must not delete an attachment owned by the committed queue');
      if (phase === 'after commit') assert.equal(find(tree, 'title', 'Save bill').props.disabled, true, 'the form cannot modify a file already owned by the queue');
      assert.equal(readFileSync(file, 'utf8'), 'synthetic attachment bytes');
      raw.close(); raw = new DatabaseSync(database); const reopened = sqliteAdapter(raw); await migrate(reopened);
      assert.equal(await snapshot(reopened), queued, 'command body, IDs, media metadata and owner survive SQLite reopen exactly');
      assert.equal(JSON.stringify({ commands: await pendingCommands(reopened, accountOwner(other)), media: await pendingMediaUpload(reopened, other, attachment.path) }), otherBefore);
      assert.equal(existsSync(otherFile), true);
    } finally { raw.close(); rmSync(folder, { recursive: true, force: true }); }
  }
});


async function unmountBeforeBillCommit(commits: boolean) {
  const folder = mkdtempSync(join(tmpdir(), 'bill-inflight-')), database = join(folder, 'cache.sqlite'), file = join(folder, 'staged.png'), bytes = 'pending save attachment';
  writeFileSync(file, bytes); let raw = new DatabaseSync(database);
  let entered!: () => void, release!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; }), decision = new Promise<void>(resolve => { release = resolve; });
  try {
    const base = sqliteAdapter(raw); await migrate(base);
    const db = { ...base, withExclusiveTransactionAsync: (task: Parameters<typeof base.withExclusiveTransactionAsync>[0]) => base.withExclusiveTransactionAsync(async tx => {
      await task(tx); entered(); await decision; if (!commits) throw Error('Commit failed');
    }) };
    const session = { baseUrl: 'https://inflight.invalid', userId: '7', email: 'seven@example.invalid', token: 'synthetic' }, owner = accountOwner(session);
    const attachment = { id: 'file-id', path: '/groups/g/expenses/bill-id/attachments', file: { uri: pathToFileURL(file).href, name: 'receipt.png', type: 'image/png', size: Buffer.byteLength(bytes) } };
    const env: Record<string, any> = { categoryIcon, expenseCategory, changedBalance, useExpenseIcons: () => ({}), animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, selected: { group: { ...group, version: 1 } }, session, owner, groupId: 'g', expenseId: null, reviewCommand: null,
      perform: (action: any) => action(), draftWrites: { current: Promise.resolve() }, getDatabase: async () => db,
      expensePayload, uuid: () => 'inflight-command', enqueueExpenseWithMedia, enqueue, enqueueBill, replaceCommand,
      requireConnectionForTemporaryStorage() {}, load: async () => {}, setReviewCommand() {}, setReviewInput() {}, navigate() {}, isOnline: () => false };
    env.command = appAction('command', env); env.queue = appAction('queue', env); env.saveExpense = appAction('saveExpense', env);
    let completion: Promise<unknown> | undefined, cleanups = 0;
    const app = harness('src/ExpenseForm.tsx', 'ExpenseForm', { clearStagedMedia: async (value: any) => { cleanups++; unlinkSync(fileURLToPath(value.uri)); } });
    const props = { group, selfId: 'self', busy: false, onSave: (...args: any[]) => { const pending = env.saveExpense(...args); completion = pending.then(() => {}, () => {}); return pending; } };
    const tree = app.render(props); app.commit();
    await nodes(tree).find(node => node.type === 'DraftAttachment')!.props.onChange(attachment);
    payerFields(app, props).onChange({ amount: '10.00', description: 'Pending bill' });
    find(app.render(props), 'title', 'Save bill').props.onPress(); await saving;
    const snapshot = async (connection: any) => JSON.stringify({ commands: await pendingCommands(connection, owner), media: await pendingMediaUpload(connection, session, attachment.path) });
    const queuedBeforeCommit = await snapshot(base);
    app.unmount(); await tick();
    const existedWhilePending = existsSync(file), cleanupsWhilePending = cleanups;
    release(); await completion; await tick();
    assert.equal(existedWhilePending, true, 'forced unmount must keep bytes until the save outcome is known');
    assert.equal(cleanupsWhilePending, 0, 'cleanup cannot run while enqueue is still pending');
    raw.close(); raw = new DatabaseSync(database); const reopened = sqliteAdapter(raw); await migrate(reopened);
    if (commits) {
      assert.equal(await snapshot(reopened), queuedBeforeCommit, 'late commit keeps the exact command, media intent and owner after reopen');
      assert.equal(readFileSync(file, 'utf8'), bytes); assert.equal(cleanups, 0);
    } else {
      assert.deepEqual(await pendingCommands(reopened, owner), []); assert.equal(await pendingMediaUpload(reopened, session, attachment.path), null);
      assert.equal(existsSync(file), true, 'a failed enqueue leaves the unsaved draft attachment recoverable after unmount'); assert.equal(cleanups, 0);
    }
  } finally { release(); raw.close(); rmSync(folder, { recursive: true, force: true }); }
}

test('forced unmount before enqueue commit preserves the file when the pending save later commits', () => unmountBeforeBillCommit(true));
test('forced unmount before enqueue failure retains the recoverable draft file', () => unmountBeforeBillCommit(false));

test('first-split UPI copy stays optional and saves only a valid address', async () => {
  let dismissed = 0, saved = '';
  const app = harness('src/UPISetupDialog.tsx', 'UPISetupDialog', { DialogFocus: 'DialogFocus', NameOnlyForm: 'NameOnlyForm' });
  const props = { visible: true, busy: false, needsName: false, afterFirstSplit: true, onSaveName: async () => {}, onSave: async (value: string) => { saved = value; }, onSkip: () => dismissed++ };
  let tree = app.render(props); app.commit();
  assert.ok(JSON.stringify(tree).includes('Your money needs directions.'));
  assert.ok(JSON.stringify(tree).includes('UPI bhej na.'));
  assert.equal(find(tree, 'title', 'Add UPI ID').props.disabled, true);
  find(tree, 'title', 'Set up later').props.onPress(); assert.equal(dismissed, 1); assert.equal(saved, '');
  find(tree, 'label', 'UPI ID (optional)').props.onChangeText('friend@bank');
  tree = app.render(props); find(tree, 'title', 'Add UPI ID').props.onPress(); await tick();
  assert.equal(saved, 'friend@bank'); assert.equal(dismissed, 2);
  const name = app.render({ ...props, needsName: true }); assert.ok(JSON.stringify(name).includes('Your name')); assert.ok(!JSON.stringify(name).includes('Your money needs directions.'));
  app.unmount();
});

test('a pending automatic payment review leaves amount, people and Record usable without a spinner', async () => {
  let finishReview!: () => void, finishSave!: () => void, saves = 0;
  let confirmation: any[] = [];
  const env = { useMemo: (fn: () => unknown) => fn(), useUI: () => ({ ui: {}, palette: {} }), isPersonalPayment, paymentReturnNeedsConfirmation, addSettlement: () => {},
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Alert: { alert: (_title: string, _body: string, actions: any[]) => confirmation = actions },
    PaymentAddress: 'PaymentAddress', PaymentHelpDialog: 'PaymentHelpDialog', UPIAppChooser: 'UPIAppChooser', WebPaymentQuote: 'WebPaymentQuote' };
  const app = harness('src/SettleForm.tsx', 'SettleForm', env);
  const props = { group: { ...group, transfers: [], balances: { self: '20000', other: '-20000' } }, selfId: 'self', busy: false,
    initial: { sender: 'other', recipient: 'self', amount: '20000' },
    onReviewAttempt: () => new Promise<void>(resolve => finishReview = resolve),
    onSave: () => { saves++; return new Promise<void>(resolve => finishSave = resolve); } };
  app.render(props); app.commit(); let tree = app.render(props);
  assert.equal(nodes(tree).find(n => n.type === 'AmountField')!.props.editable, true);
  assert.equal(nodes(tree).find(n => n.type === 'DetailDialog')!.props.busy, false);
  const record = nodes(tree).find(n => n.props.title?.startsWith('Record '))!;
  assert.equal(record.props.disabled, false); assert.ok(!nodes(tree).some(n => n.type === 'LoadingSpinner'));
  record.props.onPress(); confirmation.find(action => action.text === 'Record payment').onPress();
  confirmation.find(action => action.text === 'Record payment').onPress(); assert.equal(saves, 1);
  tree = app.render(props); assert.ok(find(tree, 'title', 'Recording…').props.disabled);
  finishSave(); await tick(); tree = app.render(props);
  assert.equal(nodes(tree).find(n => n.type === 'AmountField')!.props.editable, true);
  finishReview(); await tick(); app.unmount();
});

test('background payment review failure is quiet and leaves manual recording available', async () => {
  const app = harness('src/SettleForm.tsx', 'SettleForm', {
    useMemo: (fn: () => unknown) => fn(), useUI: () => ({ ui: {}, palette: {} }), isPersonalPayment, paymentReturnNeedsConfirmation,
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    PaymentAddress: 'PaymentAddress', PaymentHelpDialog: 'PaymentHelpDialog', UPIAppChooser: 'UPIAppChooser', WebPaymentQuote: 'WebPaymentQuote',
  });
  const props = { group: { ...group, transfers: [] }, selfId: 'self', busy: false,
    initial: { sender: 'other', recipient: 'self', amount: '20000' }, onReviewAttempt: async () => { throw Error('Offline'); } };
  app.render(props); app.commit(); await tick(); const tree = app.render(props);
  assert.equal(nodes(tree).find(n => n.props.title?.startsWith('Record '))!.props.disabled, false);
  assert.ok(!nodes(tree).some(n => n.type === 'LoadingSpinner' || n.type === 'ErrorText'));
  app.unmount();
});

test('Appearance keeps its divider when ProfileSettings continues into the Me list', () => {
  const app = harness('src/ProfileSettings.tsx', 'ProfileSettings', {
    colorFamilies: [{ value: 'orchid', label: 'Orchid' }], isDarkOnly: () => false,
    useUI: () => ({ ui: {}, appearance: 'system', colorFamily: 'orchid', currency: 'INR' }),
  });
  const tree = app.render({ name: 'Asha', vpa: '', busy: false, onSaveName() {}, onSaveUPI() {}, onAppearance() {}, onColorFamily() {}, onCurrency() {} });
  assert.equal(nodes(tree).find(node => node.type === 'SettingsRow' && node.props.label === 'Appearance')!.props.divider, true);
});


test('attachment reveal commits the loaded layout in one animated update and respects reduced motion', async () => {
  for (const enabled of [true, false]) {
    const animations: boolean[] = []; let finish!: (value: any) => void;
    const app = harness('src/BillAttachments.tsx', 'BillAttachments', {
      useUI: () => ({ ui: {}, motion: { enabled } }), animateLayout: (value: boolean) => animations.push(value),
      accountOwner: () => 'owner', getDatabase: async () => ({}), pendingMediaUpload: async () => null,
      request: () => new Promise(resolve => { finish = resolve; }), PrivateMediaImage: 'PrivateMediaImage', RemoveMediaMenu: 'RemoveMediaMenu', mediaSize: () => '1 KB',
    });
    const props = { session: { token: 'owner' }, groupId: 'g', expenseId: 'e', busy: false, onBusyChange() {} };
    app.render(props); app.commit(); await tick();
    assert.ok(nodes(app.render(props)).some(node => node.children.includes('Loading attachments…')));
    finish({ attachments: [{ id: 'receipt', name: 'Receipt.pdf', content_type: 'application/pdf', size: 1000 }], can_modify: true });
    await tick(); const tree = app.render(props);
    assert.deepEqual(animations, [enabled]);
    assert.ok(!nodes(tree).some(node => node.children.includes('Loading attachments…')));
    assert.ok(find(tree, 'accessibilityLabel', 'Open PDF 1 of 1'));
    assert.ok(find(tree, 'accessibilityLabel', 'Add attachment'));
    app.unmount();
  }
});

for (const section of ['PayerFields','SplitFields']) test(`${section} bulk selection switches only all-selected to Clear All`,()=>{
 const participants=[{id:'a',name:'Asha'},{id:'b',name:'Bharat'},{id:'c',name:'Charu'}];
 let draft:any={amount:'120',payerIds:['a'],multiplePayers:true,payerAmounts:{a:'120'},participantIds:['a'],splitValues:{},mode:'equal'};
 const render=()=>{
  const tree=harness('src/ExpenseForm.tsx',section).render({participants,draft,disabled:false,preserveRemoved:false,label:(id:string)=>id,onChange:(patch:any)=>{draft={...draft,...patch};},onToggle:()=>{},onAdjust:()=>{},status:''});
  const selection=nodes(tree).find(node=>typeof node.type==='function'&&node.type.name==='SelectionButton')!;
  return selection.type(selection.props);
 };
 let toggle=render();assert.equal(toggle.props.title,'Select All');toggle.props.onPress();
 const key=section==='PayerFields'?'payerIds':'participantIds';assert.deepEqual(draft[key],['a','b','c']);
 if(section==='PayerFields')assert.equal(draft.payerAmounts.a,'120','keep the sole payer contribution before showing multiple payers');
 toggle=render();assert.equal(toggle.props.title,'Clear All');toggle.props.onPress();assert.deepEqual(draft[key],[]);
 toggle=render();assert.equal(toggle.props.title,'Select All');toggle.props.onPress();assert.deepEqual(draft[key],['a','b','c']);
});

test('bulk actions preserve locked removed members and saved amounts',()=>{
 const app=harness('src/ExpenseForm.tsx','SelectionButton');let selected=['a','b','removed'];
 const props={participants:[{id:'a'},{id:'b'},{id:'removed',removed:true}],selected,disabled:false,label:'payers',onChange:(ids:string[])=>{selected=ids;}};
 let button=app.render(props);assert.equal(button.props.title,'Clear All');button.props.onPress();assert.deepEqual(selected,['removed']);
 button=app.render({...props,selected});assert.equal(button.props.title,'Select All');button.props.onPress();assert.deepEqual(selected,['removed','a','b']);
 button=app.render({...props,selected,disabled:true});button.props.onPress();assert.deepEqual(selected,['removed','a','b']);
});

test('sheet triggers and share controls do not start an implicit global layout transaction', () => {
  const source=ts.createSourceFile('ui.tsx',readFileSync(new URL('../src/ui.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const declaration=source.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(value=>value.name.getText(source)==='Button'))!;
  const code=ts.transpile(declaration.getText(source).replace(/^export /,''),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
  let animations=0,presses=0;
  const env={tapHaptic(){},React:{...React,forwardRef:(render:any)=>render},useState:()=>[false,()=>{}],View:'View',Text:'Text',Pressable:'Pressable',Icon:'Icon',Platform:{OS:'ios'},
    useUI:()=>({palette:{},ui:{},motion:{enabled:true,active:true}}),usePressFeedback:()=>({}),animateLayout:()=>animations++};
  const Button=new Function('env',`with(env){${code};return Button;}`)(env);
  for(const title of ['Split between','Clear All','Increase shares for Anishk']) {
    Button({title,kind:'plain',onPress:()=>presses++}).props.onPress({});
  }
  Button({title:'Done',disabled:true,onPress:()=>presses++}).props.onPress({});
  assert.equal(presses,3);assert.equal(animations,0,'Button must not animate mounting or reparenting controls in the native sheet');
});


test('Record screen reminders use current incoming debt, guard eligibility and block duplicate taps', async () => {
  const debt = { sender: 'other', recipient: 'self', amount: '50000' };
  const paymentGroup = { ...group, archived: false, transfers: [debt], participants: [
    { id: 'self', name: 'Riya', user_id: 1 }, { id: 'other', name: 'Asha', user_id: 2 },
  ] };
  const env = { useMemo: (fn: () => unknown) => fn(), useUI: () => ({ ui: {}, palette: {} }), isPersonalPayment, paymentReturnNeedsConfirmation,
    PaymentAddress: 'PaymentAddress', PaymentHelpDialog: 'PaymentHelpDialog', UPIAppChooser: 'UPIAppChooser', WebPaymentQuote: 'WebPaymentQuote' };
  const calls: unknown[] = []; let finish!: () => void;
  const props = { group: paymentGroup, initial: debt, selfId: 'self', busy: false, returnPayment: null,
    onRemind: (value: unknown) => { calls.push(value); return new Promise<void>(resolve => { finish = resolve; }); } };
  const app = harness('src/SettleForm.tsx', 'SettleForm', env);
  let tree = app.render(props);
  nodes(tree).find(node => node.type === 'AmountField')!.props.onChangeText('1.00');
  tree = app.render(props);
  const remind = find(tree, 'title', 'Remind');
  assert.equal(remind.props.icon, 'notifications');
  remind.props.onPress(); remind.props.onPress();
  assert.deepEqual(calls, [debt], 'edited payment amount never changes the canonical reminder');
  tree = app.render(props);
  assert.equal(find(tree, 'title', 'Sending…').props.disabled, true);
  assert.equal(nodes(tree).find(node => node.props.title?.startsWith('Record '))!.props.disabled, true);
  finish(); await tick();
  assert.equal(find(app.render(props), 'title', 'Remind').props.disabled, false);
  for (const changes of [
    { onRemind: undefined }, { group: { ...paymentGroup, archived: true } },
    { group: { ...paymentGroup, transfers: [] } },
    { group: { ...paymentGroup, participants: paymentGroup.participants.map(p => p.id === 'other' ? { ...p, removed: true } : p) } },
    { group: { ...paymentGroup, participants: paymentGroup.participants.map(p => p.id === 'other' ? { ...p, user_id: null } : p) } },
    { initial: { ...debt, sender: 'self', recipient: 'other' }, group: { ...paymentGroup, transfers: [{ ...debt, sender: 'self', recipient: 'other' }] } },
  ]) {
    const tree = harness('src/SettleForm.tsx', 'SettleForm', env).render({ ...props, ...changes });
    assert.equal(find(tree, 'title', 'Remind'), undefined);
  }
  tree = app.render({ ...props, busy: true });
  find(tree, 'title', 'Remind').props.onPress(); assert.equal(calls.length, 1);
  tree = app.render({ ...props, onRemind: async () => { throw Error('Reconnect and sync before sending a reminder.'); } });
  find(tree, 'title', 'Remind').props.onPress(); await tick();
  tree = app.render(props);
  assert.ok(nodes(tree).some(node => node.type === 'ErrorText' && node.children.includes('Reconnect and sync before sending a reminder.')));
  assert.equal(find(tree, 'title', 'Remind').props.disabled, false);
});


test('direct breakdown uses signed expandable contributions and labels payments without inventing a bill share', () => {
  const expenses = [
    { id: 'lunch', description: 'Lunch', total: '1000', paid: { A: '1000' }, shares: { A: '500', B: '500' }, category: 'food', date: '2026-10-28', deleted: false },
    { id: 'taxi', description: 'Taxi', total: '200', paid: { B: '200' }, shares: { A: '200' }, category: 'transport', date: '2026-10-28', deleted: false },
  ];
  const settlements = [{ id: 'paid', sender: 'B', recipient: 'A', amount: '100', date: '2026-10-29' }];
  const group: any = { id: 'pair', version: 1, name: 'Trip', simplify_debts: false, participants: [{ id: 'A', name: 'Me' }, { id: 'B', name: 'Asha' }], expenses, settlements, balances: { A: '200', B: '-200' }, transfers: directTransfers(expenses as any, settlements), activity: [] };
  const value = explainTransfer(group, group, 'A', group.transfers[0]);
  const app = harness('src/BalanceExplanationDialog.tsx', 'ExplanationBody', { categoryIcon, expenseCategory, useUI: () => ({ ui: {}, palette: {} }) });
  const tree = app.render({ value, selfId: 'A' });
  assert.ok(nodes(tree).some(node => node.children.includes('Asha owes you')));
  assert.ok(nodes(tree).some(node => node.children.includes(formatMoney('200'))));
  const rows = nodes(tree).filter(node => typeof node.type === 'function' && node.type.name === 'InlineDetails');
  assert.deepEqual(rows.map(row => row.props.amount), ['500', '-200', '-100']);
  assert.equal(rows[0].props.icon, categoryIcon('food'));
  assert.equal(rows[2].props.title, 'Recorded payment');
  assert.ok(!nodes(rows[2]).some(node => node.children.includes('Your share: ')));
  assert.ok(!nodes(rows[1]).some(node => node.children.some(value => typeof value === 'string' && value.includes('for this bill'))));
  assert.ok(nodes(rows[2]).some(node => node.children.includes('Reduces this payment by ₹1.00')));
  const disclosure = harness('src/BalanceExplanationDialog.tsx', 'InlineDetails', { useUI: () => ({ ui: {}, palette: {} }) });
  let row = disclosure.render({ ...rows[1].props, children: rows[1].children });
  assert.ok(nodes(row).some(node => node.children.includes('−')));
  assert.ok(!nodes(row).some(node => node.children.includes('Your share') && node.children.includes('₹2.00')));
  find(row, 'accessibilityRole', 'button').props.onPress();
  row = disclosure.render({ ...rows[1].props, children: rows[1].children });
  assert.equal(find(row, 'accessibilityRole', 'button').props.accessibilityState.expanded, true);
  assert.ok(nodes(row).some(node => node.children.includes('Your share') && node.children.includes('₹2.00')));
});


test('rejected attachments explain recovery and suppress a futile retry after reopening', async () => {
  for (const rejection of [undefined, 'Animated images cannot be attached. Save a still image.']) {
    const saved = { id: 'file', path: '/groups/g/expenses/e/attachments', file: { name: 'IMG_1340.jpeg' }, rejection };
    const app = harness('src/BillAttachments.tsx', 'BillAttachments', {
      accountOwner: () => 'owner', pendingMediaUpload: async () => saved,
      request: async () => ({ attachments: [], can_modify: true }),
    });
    const props = { session: { token: 'owner' }, groupId: 'g', expenseId: 'e', busy: false, onBusyChange() {} };
    app.render(props); app.commit(); await tick(); const tree = app.render(props);
    const message = nodes(tree).flatMap(node => node.children).filter(value => typeof value === 'string').join(' ');
    assert.match(message, /saved on this device/);
    assert.ok(find(tree, 'title', 'Remove file'));
    assert.equal(!!find(tree, 'title', 'Retry upload'), !rejection);
    assert.match(message, rejection ? /still image.*Remove it to choose another file/ : /Retry when online/);
    app.unmount();
  }
});


test('new bills replace the sole payer and expose multiple people only as an explicit option', async () => {
  const saves: any[] = [], app = harness('src/ExpenseForm.tsx', 'ExpenseForm');
  const props = { group, selfId: 'self', busy: false, onSave: async (value: any) => saves.push(value) };
  let fields = payerContent(app.render(props)); fields.props.onChange({ amount: '100', description: 'Lunch' });
  fields = payerContent(app.render(props));
  let closed = 0;
  let tree = harness('src/ExpenseForm.tsx', 'PayerFields').render({ ...fields.props, onDone: () => closed++ });
  assert.equal(nodes(tree).filter(node => node.props.accessibilityRole === 'radio').length, 2);
  assert.equal(nodes(tree).filter(node => node.type === 'TextField').length, 0);
  assert.ok(find(tree, 'label', 'Multiple people'));
  find(tree, 'accessibilityLabel', 'Jordan').props.onPress();
  fields = payerContent(app.render(props)); assert.deepEqual(fields.props.draft.payerIds, ['other']); assert.equal(closed, 1);
  find(app.render(props), 'title', 'Save bill').props.onPress(); await tick();
  assert.equal(saves.length, 1); assert.equal(saves[0].paid.other, '10000'); assert.equal(saves[0].paid.self ?? '0', '0');
});

test('multiple payer mode preserves entered amounts even with one selected and validates their sum', async () => {
  const saves: any[] = [], app = harness('src/ExpenseForm.tsx', 'ExpenseForm');
  const props = { group, selfId: 'self', busy: false, onSave: async (value: any) => saves.push(value) };
  payerContent(app.render(props)).props.onChange({ amount: '100', description: 'Lunch' });
  const renderFields = () => harness('src/ExpenseForm.tsx', 'PayerFields').render(payerContent(app.render(props)).props);
  find(renderFields(), 'label', 'Multiple people').props.onPress();
  assert.equal(payerContent(app.render(props)).props.draft.payerAmounts.self, '100');
  assert.equal(nodes(renderFields()).filter(node => node.type === 'TextField' && node.props.editable).length, 1);
  payerContent(app.render(props)).props.onChange({ payerAmounts: { self: '60' } });
  find(app.render(props), 'title', 'Save bill').props.onPress(); await tick(); assert.equal(saves.length, 0);
  payerContent(app.render(props)).props.onToggle('other');
  assert.equal(payerContent(app.render(props)).props.draft.payerAmounts.self, '60');
  payerContent(app.render(props)).props.onChange({ payerAmounts: { self: '60', other: '40' } });
  find(app.render(props), 'title', 'Save bill').props.onPress(); await tick();
  assert.equal(saves.length, 1); assert.deepEqual(saves[0].paid, { self: '6000', other: '4000' });
});

test('single payer selection closes its actual shared people sheet', () => {
  let choose!: () => void;
  const app = harness('src/BillPeople.tsx', 'BillPeople');
  const props = { title: 'Who paid?', sheetTitle: 'Choose payer', icon: 'pay', summary: 'Jordan', inline: false, disabled: false, children: (close: () => void) => { choose = close; return React.createElement('Input', {}); } };
  let tree = app.render(props); find(tree, 'accessibilityLabel', 'Who paid?. Jordan').props.onPress();
  tree = app.render(props); assert.equal(nodes(tree).find(node => node.type === 'PeopleSheet')!.props.visible, true);
  choose(); tree = app.render(props); assert.equal(nodes(tree).find(node => node.type === 'PeopleSheet')!.props.visible, false);
});

test('receipt tile opens the attachment sheet and keeps confirmed counts separate from pending files', async () => {
 for (const pending of [null, { id:'pending',file:{name:'Pending.jpg',uri:'file:///pending.jpg'} }]) {
  const app=harness('src/BillAttachments.tsx','BillAttachments',{accountOwner:()=> 'owner',pendingMediaUpload:async()=>pending,request:async()=>({attachments:[{id:'receipt',name:'Receipt.jpg',content_type:'image/jpeg',size:1000}],can_modify:true}),PrivateMediaImage:'PrivateMediaImage',RemoveMediaMenu:'RemoveMediaMenu',mediaSize:()=> '1 KB'});
  const props={session:{token:'owner'},groupId:'g',expenseId:'e',busy:false,onBusyChange(){}};
  app.render(props);app.commit();await tick();let tree=app.render(props);
  const action=find(tree,'accessibilityLabel',pending?'Attachments, 1 saved file, needs attention':'Attachments, 1 file');
  assert.ok(action);assert.equal(action.props.disabled,false);assert.equal(nodes(tree).find(n=>n.type==='PrivateMediaImage'&&n.props.size===80)!.props.interactive,false);
  assert.equal(nodes(tree).find(n=>n.type==='BottomSheet')!.props.visible,false);
  action.props.onPress();tree=app.render(props);assert.equal(nodes(tree).find(n=>n.type==='BottomSheet')!.props.visible,true);
  assert.ok(find(tree,'accessibilityLabel','Open Photo 1 of 1'));
  if(pending)assert.ok(nodes(tree).some(n=>n.type==='Text'&&n.children.includes('!')));
  nodes(tree).find(n=>n.type==='BottomSheet')!.props.onDismiss();assert.equal(nodes(app.render(props)).find(n=>n.type==='BottomSheet')!.props.visible,false);assert.ok(!find(tree,'title','Done'));app.unmount();
 }
});

test('empty receipt tile opens source choices before the file picker; cancellation and busy states do not reveal a sheet', async () => {
 let picks=0;
 const app=harness('src/BillAttachments.tsx','BillAttachments',{Platform:{OS:'web'},accountOwner:()=> 'owner',pendingMediaUpload:async()=>null,request:async()=>({attachments:[],can_modify:true}),pickMedia:async()=>{picks++;return null;}});
 const props={session:{token:'owner'},groupId:'g',expenseId:'e',busy:false,onBusyChange(){}};
 app.render(props);app.commit();await tick();let tree=app.render(props);
 find(tree,'accessibilityLabel','Add attachment').props.onPress();assert.equal(picks,0);find(app.render(props),'title','Choose file').props.onPress();await tick();tree=app.render(props);assert.equal(picks,1);assert.equal(nodes(tree).find(n=>n.type==='BottomSheet')!.props.visible,false);
 find(app.render({...props,busy:true}),'accessibilityLabel','Add attachment').props.onPress();await tick();assert.equal(picks,1);app.unmount();
});

test('rejected picker input opens recovery feedback without increasing the confirmed attachment count', async () => {
 const app=harness('src/BillAttachments.tsx','BillAttachments',{Platform:{OS:'web'},accountOwner:()=> 'owner',pendingMediaUpload:async()=>null,request:async()=>({attachments:[],can_modify:true}),pickMedia:async()=>{throw Error('Choose a still image.');}});
 const props={session:{token:'owner'},groupId:'g',expenseId:'e',busy:false,onBusyChange(){}};
 app.render(props);app.commit();await tick();find(app.render(props),'accessibilityLabel','Add attachment').props.onPress();find(app.render(props),'title','Choose file').props.onPress();await tick();const tree=app.render(props);
 assert.equal(nodes(tree).find(n=>n.type==='BottomSheet')!.props.visible,true);assert.ok(find(tree,'accessibilityLabel','Attachments, 0 saved files, needs attention'));
 assert.ok(nodes(tree).some(n=>n.children.includes('Choose a still image.')));app.unmount();
});


test('direct bill breakdown shows the actual debtor share in both directions and keeps net debt separate', () => {
  const expenses: any[] = [
    { id: 'wine', description: 'Wine', total: '221500', paid: { A: '221500' }, shares: { A: '73833', B: '73834', C: '73833' }, split: {mode:'equal',values:{A:'1',B:'1',C:'1'}}, date:'2026-11-02', deleted:false },
    { id: 'offset', description: 'Offset', total: '10000', paid: { B:'10000' }, shares: { A:'10000' }, split:{mode:'exact',values:{A:'10000'}}, date:'2026-11-02', deleted:false },
  ];
  const group:any = {id:'pair',version:1,name:'Trip',simplify_debts:false,participants:[{id:'A',name:'Om'},{id:'B',name:'Anishk'},{id:'C',name:'Dev'}],expenses,settlements:[],balances:{A:'137667',B:'-63834',C:'-73833'},transfers:directTransfers(expenses,[]),activity:[]};
  for (const selfId of ['A','B']) {
    const value=explainTransfer(group,group,selfId,group.transfers.find((t:any)=>t.sender==='B'));
    const tree=harness('src/BalanceExplanationDialog.tsx','ExplanationBody',{categoryIcon,expenseCategory,useUI:()=>({ui:{},palette:{}})}).render({value,selfId});
    const rows=nodes(tree).filter(n=>typeof n.type==='function'&&n.type.name==='InlineDetails');
    assert.ok(nodes(rows[0]).some(n=>n.children.includes(selfId==='A'?"Anishk's share":'Your share')&&n.children.includes('₹738.34')));
    assert.ok(!nodes(rows[0]).some(n=>n.children.some(value=>typeof value==='string'&&value.includes('for this bill'))));
    assert.ok(nodes(rows[1]).some(n=>n.children.includes(selfId==='A'?'Your share':"Om's share")&&n.children.includes('₹100.00')));
    assert.ok(!nodes(rows[1]).some(n=>n.children.some(value=>typeof value==='string'&&value.includes('for this bill'))));
  }
  const partial={...expenses[0],total:'20000',paid:{A:'10000',B:'10000'},shares:{A:'5000',B:'15000'}};
  const mixed:any={...group,expenses:[partial],balances:{A:'5000',B:'-5000',C:'0'},transfers:directTransfers([partial],[])};
  const tree=harness('src/BalanceExplanationDialog.tsx','ExplanationBody',{categoryIcon,expenseCategory,useUI:()=>({ui:{},palette:{}})}).render({value:explainTransfer(mixed,mixed,'A',mixed.transfers[0]),selfId:'A'});
  assert.ok(nodes(tree).some(n=>n.children.includes("Anishk's share")&&n.children.includes('₹150.00')));
  assert.ok(nodes(tree).some(n=>n.children.includes('Anishk owes you ₹50.00 for this bill')));
});


test('balance breakdown uses the same resolved automatic icons and manual choices as bill rows', () => {
 const bills:any[]=[{id:'a',description:'Lunch',total:'1000',paid:{A:'1000'},shares:{B:'1000'},date:'2026-11-03',deleted:false,category:'general',category_auto:true},{id:'b',description:'Coffee',total:'500',paid:{A:'500'},shares:{B:'500'},date:'2026-11-03',deleted:false,category:'coffee',category_auto:false}];
 const group:any={id:'icons',version:1,name:'Trip',simplify_debts:false,participants:[{id:'A',name:'Me'},{id:'B',name:'Aditya'}],expenses:bills,settlements:[],balances:{A:'1500',B:'-1500'},transfers:directTransfers(bills,[]),activity:[]};
 const value=explainTransfer(group,group,'A',group.transfers[0]);const icons={[categoryKey('icons','a','Lunch')]:'food',[categoryKey('icons','b','Coffee')]:'transport'};
 const app=harness('src/BalanceExplanationDialog.tsx','ExplanationBody',{categoryIcon,expenseCategory,useUI:()=>({ui:{},palette:{}})});
 const tree=app.render({value,selfId:'A',categoryIcons:icons});const rows=nodes(tree).filter(n=>typeof n.type==='function'&&n.type.name==='InlineDetails');
 assert.deepEqual(rows.map(row=>row.props.icon),['food','coffee']);
});


test('balance sheet loads category hints for its own full bill set and stops on stale selection', async () => {
 const bill:any={id:'older',description:'Older lunch',total:'100',paid:{A:'100'},shares:{B:'100'},date:'2026-11-03',deleted:false,category:'general',category_auto:true};
 const group:any={id:'g',version:1,name:'Trip',simplify_debts:false,participants:[{id:'A',name:'Me'},{id:'B',name:'Aditya'}],expenses:[bill],settlements:[],balances:{A:'100',B:'-100'},transfers:directTransfers([bill],[]),activity:[]};
 const session={userId:'one',token:'synthetic'};const calls:any[]=[];
 const app=harness('src/BalanceExplanationDialog.tsx','BalanceExplanation',{explainTransfer,balanceKey,useExpenseIcons:(...args:any[])=>{calls.push(args);return{}},useUI:()=>({ui:{},palette:{}})});
 const props={selection:{group,accepted:group,commands:[],selfId:'A',transfer:group.transfers[0],restoreFocus(){}},currentKey:balanceKey(group,[]),onClose(){},session,online:true,active:true};
 app.render(props);app.commit();await tick();app.render(props);const last=calls.at(-1)!;assert.equal(last[0],session);assert.equal(last[1][0].id,'older');assert.equal(last[2],true);assert.equal(last[4],true);
 app.render({...props,currentKey:'stale'});assert.deepEqual(calls.at(-1)![1],[]);assert.equal(calls.at(-1)![2],false);app.unmount();
});


const galleryItems = [
 {id:'photo-one',name:'IMG_1456.jpg',content_type:'image/jpeg',size:593000},
 {id:'pdf-two',name:'scan-original.pdf',content_type:'application/pdf',size:1200000},
 {id:'photo-three',name:'IMG_1457.jpg',content_type:'image/jpeg',size:430000},
];
test('gallery selects and opens the exact private attachment, contains the preview and hides file metadata',()=>{
 let selected='',opened:any;const moves:any[]=[];
 const app=harness('src/AttachmentGallery.tsx','AttachmentGallery',{PrivateMediaImage:'PrivateMediaImage',useWindowDimensions:()=>({width:390,height:844,fontScale:1}),useUI:()=>({palette:{},ui:{},motion:{enabled:true}})});
 const tree=app.render({session:{token:'owner'},items:galleryItems,selectedId:'pdf-two',disabled:false,onSelect:(id:string)=>selected=id,onOpen:(item:any)=>opened=item,onAdd(){}});
 assert.equal(find(tree,'accessibilityLabel','Select PDF 2 of 3').props.accessibilityState.selected,true);
 find(tree,'accessibilityLabel','Select Photo 3 of 3').props.onPress();assert.equal(selected,'photo-three');
 find(tree,'accessibilityLabel','Open PDF 2 of 3').props.onPress();assert.equal(opened,galleryItems[1]);
 const preview=nodes(tree).find(n=>n.type==='PrivateMediaImage'&&n.props.resizeMode==='contain')!;assert.equal(preview.props.media,galleryItems[1]);assert.equal(preview.props.interactive,false);
 const labels=nodes(tree).flatMap(n=>[...n.children,n.props.accessibilityLabel,n.props.label]).filter(v=>typeof v==='string').join(' ');assert.doesNotMatch(labels,/IMG_|scan-original|593|KB|MB/);
 const strip=nodes(tree).find(n=>n.type==='ScrollView'&&n.props.horizontal)!;strip.props.ref.current={scrollTo:(v:any)=>moves.push(v)};app.commit();assert.equal(moves[0].animated,true);
});
test('gallery shrinks its preview for large text and keeps selected thumbnails reachable with reduced motion',()=>{
 const moves:any[]=[];const app=harness('src/AttachmentGallery.tsx','AttachmentGallery',{PrivateMediaImage:'PrivateMediaImage',useWindowDimensions:()=>({width:320,height:568,fontScale:1.8}),useUI:()=>({palette:{},ui:{},motion:{enabled:false}})});
 const tree=app.render({session:{},items:galleryItems,selectedId:'photo-three',disabled:false,onSelect(){},onOpen(){}});
 assert.equal(nodes(tree).find(n=>n.type==='PrivateMediaImage'&&n.props.resizeMode==='contain')!.props.size,120);
 const strip=nodes(tree).find(n=>n.type==='ScrollView'&&n.props.horizontal)!;strip.props.ref.current={scrollTo:(v:any)=>moves.push(v)};strip.props.onContentSizeChange();assert.deepEqual(moves,[{x:152,animated:false}]);
});
test('removing the selected gallery attachment confirms without filenames and selects its next neighbour',async()=>{
 let confirmation:any;const removed:string[]=[];const props={session:{token:'owner'},groupId:'g',expenseId:'e',busy:false,onBusyChange(){}};
 const app=harness('src/BillAttachments.tsx','BillAttachments',{accountOwner:()=> 'owner',pendingMediaUpload:async()=>null,request:async(_session:any,path:string,method:string)=>{if(method==='DELETE'){removed.push(path);return {};}return {attachments:galleryItems,can_modify:true};},PrivateMediaImage:'PrivateMediaImage',RemoveMediaMenu:'RemoveMediaMenu',clearMediaPreview:async()=>{},Alert:{alert:(...args:any[])=>confirmation=args}});
 app.render(props);app.commit();await tick();let tree=app.render(props);find(tree,'accessibilityLabel','Select PDF 2 of 3').props.onPress();tree=app.render(props);
 find(tree,'accessibilityLabel','Options for PDF 2 of 3').props.onPress();assert.equal(confirmation[1],'Remove this PDF from the bill?');confirmation[2].find((v:any)=>v.text==='Remove attachment').onPress();await tick();tree=app.render(props);
 assert.ok(find(tree,'accessibilityLabel','Open Photo 2 of 2'));assert.deepEqual(removed,['/groups/g/expenses/e/attachments/pdf-two']);assert.ok(!find(tree,'title','Done'));app.unmount();
});
test('pending and read-only gallery states preserve recovery while preventing new uploads or removal',async()=>{
 for(const readOnly of [false,true]){
  const pending={id:'waiting',file:{name:'PRIVATE_NAME.jpg',uri:'file:///pending.jpg',type:'image/jpeg',size:777000}};
  const app=harness('src/BillAttachments.tsx','BillAttachments',{accountOwner:()=> 'owner',pendingMediaUpload:async()=>pending,request:async()=>({attachments:galleryItems,can_modify:true}),PrivateMediaImage:'PrivateMediaImage',RemoveMediaMenu:'RemoveMediaMenu'});
  const props={session:{token:'owner'},groupId:'g',expenseId:'e',readOnly,busy:false,onBusyChange(){}};app.render(props);app.commit();await tick();const tree=app.render(props);
  assert.ok(!find(tree,'accessibilityLabel','Add attachment'));assert.equal(find(tree,'title','Retry upload').props.disabled,readOnly);
  const local=nodes(tree).find(n=>n.type==='LocalAttachment'&&!n.props.thumbnailOnly)!;assert.equal(local.props.title,'Photo waiting to upload');assert.equal(local.props.subtitle,'Saved on this device');
  assert.equal(!!find(tree,'accessibilityLabel','Options for Photo 1 of 3'),!readOnly);app.unmount();
 }
});


test('gallery keeps the initial visible attachment when refreshed rows arrive in a different order',async()=>{
 let items=galleryItems,opened:any;const app=harness('src/BillAttachments.tsx','BillAttachments',{accountOwner:()=> 'owner',pendingMediaUpload:async()=>null,request:async()=>({attachments:items,can_modify:true}),PrivateMediaImage:'PrivateMediaImage',openPrivateMedia:async(_:any,item:any)=>opened=item});
 const props={session:{token:'owner'},groupId:'g',expenseId:'e',revision:1,busy:false,onBusyChange(){}};app.render(props);app.commit();await tick();assert.ok(find(app.render(props),'accessibilityLabel','Open Photo 1 of 3'));
 items=[galleryItems[2],galleryItems[1],galleryItems[0]];const next={...props,revision:2};app.render(next);app.commit();await tick();const tree=app.render(next);find(tree,'accessibilityLabel','Open Photo 3 of 3').props.onPress();await tick();assert.equal(opened.id,'photo-one');app.unmount();
});


test('notification dialog removes the master and summary follows each independent local choice',()=>{
 const panel=notificationPanel({expense_updates:true,email_reminders:true}),{app,props}=panel;
 for(const[push,email,summary]of [[true,true,'Push and email'],[true,false,'Push'],[false,true,'Email'],[false,false,'Off']]as const){props.push.state.configured=push;props.channels.state.value.email_notifications=email;const tree=app.render(props);assert.equal(nodes(tree).find(n=>n.type==='SettingsRow'&&n.props.label==='Notifications')!.props.value,summary);assert.equal(notificationToggle(tree,'Notifications'),undefined);assert.equal(nodes(tree).filter(n=>n.type==='PushSettings').length,1);assert.equal(notificationToggle(tree,'Email notifications').props.checked,email);assert.equal(nodes(tree).some(n=>n.type==='BalanceStatements'),email)}app.unmount();
});
test('Email toggles immediately and remains responsive with pending sync, without changing Push',async()=>{
 const panel=notificationPanel({expense_updates:true,email_reminders:false}),{app,props}=panel;notificationToggle(app.render(props),'Email notifications').props.onChange(true);assert.equal(notificationToggle(app.render(props),'Email notifications').props.checked,true);assert.equal(notificationToggle(app.render(props),'Email notifications').props.disabled,false);props.channels.state.error='Saved on this device. Will sync when connected.';let tree=app.render(props);assert.equal(notificationToggle(tree,'Email notifications').props.checked,true);assert.ok(nodes(tree).some(n=>n.type==='Button'&&n.props.title==='Retry sync'));notificationToggle(tree,'Email notifications').props.onChange(false);tree=app.render(props);assert.equal(notificationToggle(tree,'Email notifications').props.checked,false);assert.deepEqual(panel.changes,[{email_notifications:true},{email_notifications:false}]);assert.equal(props.push.state.configured,true);assert.deepEqual(panel.busy,[]);app.unmount();
});
test('unknown preferences show loading or explicit failure rather than a fabricated Off summary',()=>{
 const panel=notificationPanel(null),{app,props}=panel;let tree=app.render(props);assert.equal(nodes(tree).find(n=>n.type==='SettingsRow')!.props.value,undefined);assert.equal(notificationToggle(tree,'Email notifications'),undefined);props.channels.state.error='Could not load notification settings. Try again.';tree=app.render(props);assert.ok(nodes(tree).some(n=>n.type==='ErrorText'));app.unmount();
});
test('Push UI uses the durable local choice through saving and network failure, and keeps permission feedback distinct',async()=>{
 const push:any={state:{ready:true,configured:false,enabled:false,working:true,pending:false,saving:false,permission:'granted',error:''},enable:()=>{push.state.configured=true;push.state.pending=true;return new Promise(()=>{})},disable:()=>{push.state.configured=false;return Promise.resolve()},refresh:async()=>{}};
 const app=harness('src/PushSettings.tsx','PushSettings',{Notifications:{setNotificationHandler(){}},Linking:{openSettings:async()=>{}}});const props={push,busy:false};notificationToggle(app.render(props),'Push notifications').props.onChange(true);let tree=app.render(props);assert.equal(notificationToggle(tree,'Push notifications').props.checked,true);assert.equal(notificationToggle(tree,'Push notifications').props.disabled,false);push.state.error='Offline';tree=app.render(props);assert.equal(notificationToggle(tree,'Push notifications').props.checked,true);notificationToggle(tree,'Push notifications').props.onChange(false);assert.equal(notificationToggle(app.render(props),'Push notifications').props.checked,false);push.state.permission='denied';push.state.configured=true;tree=app.render(props);assert.equal(notificationToggle(tree,'Push notifications').props.disabled,false);const status=harness('src/PushSettings.tsx','PushStatus',{Notifications:{setNotificationHandler(){}},Linking:{openSettings:async()=>{}}}).render(props);assert.ok(find(status,'title','Open phone settings'));app.unmount();
});
test('statements use a frequency sheet without a third toggle, and manual send preserves subscription state',async()=>{
 const panel=statementPanel(),{app,props}=panel;app.render(props);app.commit();await tick();let tree=app.render(props);assert.equal(notificationToggle(tree,'Balance statements'),undefined);assert.equal(nodes(tree).find(n=>n.type==='SettingsRow'&&n.props.label==='Frequency')!.props.value,'Not scheduled');find(tree,'title','Email statement now').props.onPress();await tick();assert.equal(props.channels.state.value.statement_enabled,false);nodes(tree).find(n=>n.type==='SettingsRow'&&n.props.label==='Frequency')!.props.onPress();tree=app.render(props);assert.equal(nodes(tree).find(n=>n.type==='KeyboardDialog'&&n.props.label==='Statement frequency')!.props.visible,true);find(tree,'label','Weekly').props.onPress();tree=app.render(props);assert.equal(props.channels.state.value.statement_frequency,'weekly');assert.equal(nodes(tree).find(n=>n.type==='SettingsRow'&&n.props.label==='Frequency')!.props.value,'Weekly');app.unmount();
});

test('breakdown links open the matching bill, while amount colors follow the viewer in both directions', () => {
  const expenses = [
    { id: 'lunch', description: 'Lunch', total: '1000', paid: { A: '1000' }, shares: { A: '500', B: '500' }, category: 'food', date: '2026-10-28', deleted: false },
    { id: 'taxi', description: 'Taxi', total: '200', paid: { B: '200' }, shares: { A: '200' }, category: 'transport', date: '2026-10-28', deleted: false },
  ];
  const group: any = { id: 'pair', version: 1, name: 'Trip', simplify_debts: false, participants: [{ id: 'A', name: 'Me' }, { id: 'B', name: 'Asha' }], expenses, settlements: [], balances: { A: '300', B: '-300' }, transfers: directTransfers(expenses as any, []), activity: [] };
  const palette = { positive: 'green', negative: 'red' }, opened: any[] = [];
  for (const selfId of ['A', 'B']) {
    const value = explainTransfer(group, group, selfId, group.transfers[0]);
    const app = harness('src/BalanceExplanationDialog.tsx', 'ExplanationBody', { useUI: () => ({ ui: {}, palette }) });
    const rows = nodes(app.render({ value, selfId, onOpenBill: (bill: any) => opened.push(bill.id) })).filter(node => node.type?.name === 'InlineDetails');
    assert.deepEqual(rows.map(row => row.props.amountEffect), selfId === 'A' ? ['500', '-200'] : ['-500', '200']);
    for (const [index, row] of rows.entries()) {
      const disclosure = harness('src/BalanceExplanationDialog.tsx', 'InlineDetails', { useUI: () => ({ ui: {}, palette }) });
      let tree = disclosure.render(row.props);
      const amount = nodes(tree).find(node => node.type === 'Text' && node.children.includes(index === 0 ? '+' : '−'))!;
      assert.equal(amount.props.style[1].color, selfId === 'A' ? index === 0 ? 'green' : 'red' : index === 0 ? 'red' : 'green');
      assert.match(find(tree, 'accessibilityRole', 'button').props.accessibilityLabel, /adds to what you (are owed|owe)/);
      assert.equal(find(tree, 'title', 'Open bill'), undefined);
      find(tree, 'accessibilityRole', 'button').props.onPress(); tree = disclosure.render(row.props);
      find(tree, 'title', 'Open bill').props.onPress();
    }
  }
  assert.deepEqual(opened, ['lunch', 'taxi', 'lunch', 'taxi']);
});

test('disclosure animates both ways, survives interrupted closing, and skips animation for reduced motion', () => {
  let enabled = true;
  const animations: any[] = [];
  const animationEnv = { ...Animated, timing(value: any, options: any) {
    const entry: any = { options, stopped: false, start(done: any) { this.done = done; }, stop() { this.stopped = true; this.done?.({ finished: false }); }, finish() { value.setValue(options.toValue); this.done?.({ finished: true }); } };
    animations.push(entry); return entry;
  } };
  const app = harness('src/BalanceExplanationDialog.tsx', 'InlineDetails', { Animated: animationEnv, Easing: { cubic: 'cubic', out: (value: any) => value }, useUI: () => ({ ui: {}, palette: {}, motion: { enabled } }) });
  const props = { title: 'Lunch', children: 'Bill details', onOpenBill() {} };
  let tree = app.render(props); app.commit();
  find(tree, 'accessibilityRole', 'button').props.onPress(); tree = app.render(props); app.commit();
  nodes(tree).find(node => node.props.onLayout)!.props.onLayout({ nativeEvent: { layout: { height: 96 } } });
  tree = app.render(props); app.commit();
  assert.equal(animations.at(-1).options.toValue, 1); assert.equal(animations.at(-1).options.duration, 180);
  animations.at(-1).finish();
  find(tree, 'accessibilityRole', 'button').props.onPress(); tree = app.render(props); app.commit();
  const closing = animations.at(-1); assert.equal(closing.options.toValue, 0);
  assert.equal(find(tree, 'title', 'Open bill').props.disabled, true);
  find(tree, 'accessibilityRole', 'button').props.onPress(); tree = app.render(props); app.commit();
  assert.equal(closing.stopped, true); animations.at(-1).finish();
  assert.ok(nodes(app.render(props)).some(node => node.children.includes('Bill details')));
  find(tree, 'accessibilityRole', 'button').props.onPress(); app.render(props); app.commit(); animations.at(-1).finish();
  assert.ok(!nodes(app.render(props)).some(node => node.children.includes('Bill details')));
  enabled = false; const count = animations.length;
  tree = app.render(props); app.commit(); find(tree, 'accessibilityRole', 'button').props.onPress(); tree = app.render(props); app.commit();
  assert.ok(nodes(tree).some(node => node.children.includes('Bill details'))); assert.equal(animations.length, count);
  find(tree, 'accessibilityRole', 'button').props.onPress(); app.render(props); app.commit();
  assert.equal(find(app.render(props), 'title', 'Open bill'), undefined);
  app.unmount();
});


test('Simplify shows the proposed payment and exact after-payment balance with history hidden behind disclosures', () => {
  const expenses = [
    { id: 'Dinner', description: 'Dinner', total: '1001', paid: { A: '1001' }, shares: { B: '1001' }, category: 'food', date: '2026-10-28', deleted: false },
    { id: 'Taxi', description: 'Taxi', total: '600', paid: { B: '600' }, shares: { C: '600' }, category: 'transport', date: '2026-10-28', deleted: false },
  ];
  const balances = { A: '1001', B: '-401', C: '-600' };
  const group: any = { id: 'group', version: 1, name: 'Trip', simplify_debts: true, participants: [{ id: 'A', name: 'Me' }, { id: 'B', name: 'Aditya' }, { id: 'C', name: 'Anish' }], expenses, settlements: [], balances, transfers: [{ sender: 'C', recipient: 'A', amount: '600' }, { sender: 'B', recipient: 'A', amount: '401' }], activity: [] };
  for (const selfId of ['A', 'C']) {
    const value = explainTransfer(group, group, selfId, group.transfers[0]);
    const app = harness('src/BalanceExplanationDialog.tsx', 'ExplanationBody', { useUI: () => ({ ui: {}, palette: {} }) });
    const tree = app.render({ value, selfId, onOpenBill() {} });
    const text = nodes(tree).flatMap(node => node.children).filter(child => typeof child === 'string');
    assert.ok(text.includes(selfId === 'A' ? 'Anish should pay you' : 'You should pay Me'));
    assert.ok(text.includes(selfId === 'A' ? 'After this payment, you would still be owed ₹4.01.' : 'This payment would settle your group balance.'));
    assert.ok(!text.includes('Recent changes to your balance'));
    const disclosures = nodes(tree).filter(node => node.type?.name === 'InlineDetails');
    assert.deepEqual(disclosures.map(row => row.props.title), ['How your balance adds up', 'Bills and payments (1)', 'Group payment plan']);
    const collapse = harness('src/BalanceExplanationDialog.tsx', 'InlineDetails');
    const closed = collapse.render({ ...disclosures[1].props, children: disclosures[1].children });
    assert.ok(!nodes(closed).some(node => node.type?.name === 'HistoryRecords'));
    assert.equal(find(closed, 'accessibilityRole', 'button').props.accessibilityState.expanded, false);
  }
  // Later plan steps are suggestions, not already recorded payments.
  const later = explainTransfer(group, group, 'A', group.transfers[1]);
  const tree = harness('src/BalanceExplanationDialog.tsx', 'ExplanationBody').render({ value: later, selfId: 'A', onOpenBill() {} });
  assert.ok(nodes(tree).some(node => node.children.includes('After this payment, you would still be owed ₹6.00.')));
});

test('simplified totals keep sent, received and starting balances distinct without changing records', () => {
  const expenses: any[] = [
    { id: 'Dinner', description: 'Dinner', total: '1001', paid: { A: '1001' }, shares: { B: '1001' }, date: '2026-10-28', deleted: false },
    { id: 'Taxi', description: 'Taxi', total: '600', paid: { B: '600' }, shares: { C: '600' }, date: '2026-10-28', deleted: false },
  ];
  const settlements = [{ id: 'sent', sender: 'A', recipient: 'C', amount: '100', date: '2026-10-29' }, { id: 'received', sender: 'C', recipient: 'A', amount: '50', date: '2026-10-30' }];
  const balances = { A: '851', B: '-301', C: '-550' };
  const group: any = { id: 'group', version: 1, name: 'Trip', simplify_debts: true, participants: [{ id: 'A', name: 'Me' }, { id: 'B', name: 'Aditya' }, { id: 'C', name: 'Anish' }], expenses, settlements, balances, transfers: [{ sender: 'C', recipient: 'A', amount: '550' }, { sender: 'B', recipient: 'A', amount: '301' }], opening_balance: { accepted: true, balances: { A: '-200', B: '100', C: '100' }, cutoff: '2026-10-01', source: 'Agreed' }, activity: [] };
  const before = JSON.stringify(group), value = explainTransfer(group, group, 'A', group.transfers[0]);
  const tree = harness('src/BalanceExplanationDialog.tsx', 'ExplanationBody').render({ value, selfId: 'A', onOpenBill() {} });
  const totals = nodes(tree).find(node => node.props.title === 'How your balance adds up')!;
  const text = nodes(totals).flatMap(node => node.children).filter(child => typeof child === 'string');
  for (const label of ['You paid for bills', 'Payments you sent', 'Payments you received', 'Agreed starting balance', 'You are owed', '₹8.51']) assert.ok(text.includes(label));
  assert.ok(nodes(totals).some(node => node.type === 'Text' && node.children.includes('−') && node.children.includes('₹2.00')));
  assert.ok(nodes(totals).some(node => node.type === 'Text' && node.children.includes('−') && node.children.includes('₹0.50')));
  assert.equal(JSON.stringify(group), before);

  const partialExpenses = [expenses[0], { ...expenses[1], total: '401', paid: { B: '401' }, shares: { A: '401' } }];
  // One person owes two creditors. Paying the first does not settle their group balance.
  const partial: any = { ...group, expenses: [{ ...partialExpenses[0], shares: { C: '1001' } }, partialExpenses[1]], settlements: [], opening_balance: undefined, balances: { A: '600', B: '401', C: '-1001' }, transfers: [{ sender: 'C', recipient: 'A', amount: '600' }, { sender: 'C', recipient: 'B', amount: '401' }] };
  const out = harness('src/BalanceExplanationDialog.tsx', 'ExplanationBody').render({ value: explainTransfer(partial, partial, 'C', partial.transfers[0]), selfId: 'C', onOpenBill() {} });
  assert.ok(nodes(out).some(node => node.children.includes('After this payment, you would still owe ₹4.01.')));
  const full = { ...partial, expenses: [expenses[0]], balances: { A: '1001', B: '-1001', C: '0' }, transfers: [{ sender: 'B', recipient: 'A', amount: '1001' }] };
  const incoming = harness('src/BalanceExplanationDialog.tsx', 'ExplanationBody').render({ value: explainTransfer(full, full, 'A', full.transfers[0]), selfId: 'A', onOpenBill() {} });
  assert.ok(nodes(incoming).some(node => node.children.includes('This payment would settle your group balance.')));
});
