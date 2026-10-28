import { currencySymbol } from '../src/currency.ts';
import { explainTransfer, balanceKey } from '../src/balanceExplanation.ts';
import test from 'node:test';
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
import { formatMoney, integer, rupeesToPaise, validateExpense } from '../src/accounting.ts';
import { isPersonalPayment } from '../src/personalBalances.ts';
import { validUPIAddress } from '../src/upi.ts';
import { paymentReturnNeedsConfirmation } from '../src/paymentReturn.ts';

type Element = { type: any; props: Record<string, any>; children: any[] };
const React = { createElement: (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children }) };
const Dialog = Object.assign(() => {}, { Title: 'Title', Content: 'Content', Actions: 'Actions' });
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
const find = (tree: any, prop: string, value: string) => nodes(tree).find(node => node.props[prop] === value)!;
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function harness(file: string, name: string, extra: Record<string, any> = {}) {
  let cursor = 0, states: any[] = [], effects: (() => void)[] = [], cleanups: Record<number, () => void> = {};
  const deps: Record<number, any[]> = {};
  const draftDiscard = { current: null as null | (() => Promise<boolean>) };
  const env: Record<string, any> = { animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, cachedRead: () => undefined, getDatabase: async () => ({}), draftDiscard, ScreenDraftDiscard: {}, useContext: () => draftDiscard, expenseDraftStore: () => ({ read: () => ({ then: (done: (value: null) => void) => { done(null); return { catch() {} }; } }), write: async () => {} }), React, Dialog, PersonInviteDialog: 'PersonInviteDialog', useToast: () => () => {}, DetailDialog: 'DetailDialog', useScreenRemovalLock() {}, validUPIAddress, View: 'View', ScrollView: 'ScrollView', KeyboardDialog: 'KeyboardDialog', Pressable: 'Pressable', Text: 'Text', LoadingSpinner: 'LoadingSpinner', NotificationSwitch: 'NotificationSwitch', PushSettings: 'PushSettings', BalanceStatements: 'BalanceStatements', DialogScrollBody: 'DialogScrollBody', Form: 'Form', SectionHeading: 'SectionHeading', Button: 'Button', Icon: 'Icon', SettingsRow: 'SettingsRow', BillPeople: 'BillPeople', DraftAttachment: 'DraftAttachment', LocalAttachment: 'LocalAttachment', AmountField: 'AmountField', TextField: 'TextField', DateField: 'DateField', ErrorText: 'ErrorText', Checkbox: { Item: 'Checkbox' }, RadioChoice: 'RadioChoice', Crypto: { randomUUID: () => 'bill-id' }, StyleSheet: { create: (value: any) => value }, Keyboard: { dismiss() {} }, useWindowDimensions: () => ({ height: 667 }), useSafeAreaInsets: () => ({ top: 20, bottom: 0 }), Platform: { OS: 'native' }, requestAnimationFrame: (fn: () => void) => fn(), useUI: () => ({ ui: {} }), formatMoney, integer, rupeesToPaise, validateExpense, ...extra,
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = typeof initial === 'function' ? initial() : initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
    useEffect: (fn: () => any, values: any[]) => { const id = cursor++; if (!deps[id] || values.some((value, i) => value !== deps[id][i])) { effects.push(() => { cleanups[id]?.(); cleanups[id] = fn(); }); deps[id] = values; } },
  };
  const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const code = ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  const render = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${code}; return ${name};}`)(env);
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
  return new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${ts.transpile(fn.getText(source), { target: ts.ScriptTarget.ES2022 })};return ${name};}`)(env);
}

test('combined export flushes saved work and never shares a stale account result', async () => {
  const calls: any[] = [], notices: any[] = [], ownerRef = { current: 'owner-a' }, session = { token: 'session-a' };
  const data = { account_data_status: 'unavailable_offline' };
  const env: Record<string, any> = { animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, browse: async (_key: string, work: any) => work(() => true), owner: 'owner-a', ownerRef, session, activeSessionRef: { current: session },
    draftWrites: { current: Promise.resolve() }, flushChatWrites: async () => {}, getDatabase: async () => ({}), isOnline: () => false,
    portableExport: async () => data, setNotice: (...args: any[]) => notices.push(args), shareJson: async (...args: any[]) => calls.push(args) };
  await appAction('exportData', env)(); assert.deepEqual(calls, [['merosplit-data', data]]); assert.equal(notices.length, 1);
  env.portableExport = async () => { ownerRef.current = 'owner-b'; return data; };
  await appAction('exportData', env)(); assert.equal(calls.length, 1);
});

const group = { id: 'g', name: 'Example', expenses: [], participants: [{ id: 'self', name: 'Example' }, { id: 'other', name: 'Jordan' }] };

test('form keeps one selected payer changeable when other people are eligible and retains values through dialog close', async () => {
  const app = harness('src/ExpenseForm.tsx', 'ExpenseForm'), drafts: any[] = [], saves: any[] = [];
  const props = { group, selfId: 'self', busy: false, onSave: async (value: any) => saves.push(value), onDraftChange: (value: any) => drafts.push(value) };
  let tree = app.render(props);
  let paid = find(tree, 'title', 'Who paid?'); assert.equal(paid.props.inline, false);
  const fields = paid.children[0]; fields.props.onToggle('other');
  tree = app.render(props); paid = find(tree, 'title', 'Who paid?'); assert.equal(paid.props.summary, '2 people');
  paid.children[0].props.onChange({ payerAmounts: { self: '6.00', other: '4.00' }, amount: '10.00', description: 'Lunch' });
  tree = app.render(props); assert.deepEqual(find(tree, 'title', 'Who paid?').children[0].props.draft.payerAmounts, { self: '6.00', other: '4.00' });
  assert.equal(saves.length, 0); find(tree, 'title', 'Save bill').props.onPress(); await tick();
  assert.equal(saves.length, 1); assert.deepEqual(saves[0].paid, { self: '600', other: '400' });
  assert.equal(drafts.length, 0, 'typing and saving never autosave a form draft');
  const single = harness('src/ExpenseForm.tsx', 'ExpenseForm').render({ ...props, group: { ...group, participants: [group.participants[0]] } });
  assert.equal(find(single, 'title', 'Who paid?').props.inline, true); assert.equal(find(single, 'title', 'Split between').props.inline, true);
  assert.ok(find(single, 'label', 'Notes (optional)'));
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
  const selection = find(app.render(props), 'title', 'Who paid?').children[0];
  const tree = harness('src/ExpenseForm.tsx', 'PayerFields').render(selection.props);
  return { ...selection.props, fields: nodes(tree).filter(node => node.type === 'TextField') };
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
      stageMediaUpload: async () => { uploads++; throw Error('Upload boundary blocked'); }, PrivateMediaImage: 'PrivateMediaImage', RemoveMediaMenu: 'RemoveMediaMenu',
    });
    app.render(props); app.commit(); await tick(); return app;
  };
  const app = await make(); let tree = app.render(props); app.commit();
  assert.equal(reads, 1); assert.ok(nodes(tree).some(node => node.type === 'SectionHeading' && node.children.includes('Attachments')));
  find(tree, 'label', 'Add photo or PDF').props.onPress(); await tick(); assert.equal(picks, 1); assert.equal(uploads, 0); assert.equal(reads, 1);
  tree = app.render({ ...props, busy: true }); find(tree, 'label', 'Add photo or PDF').props.onPress(); await tick(); assert.equal(picks, 1);
  assert.ok(!find(app.render({ ...props, readOnly: true }), 'label', 'Add photo or PDF'));
  for (const [items, canModify, pending] of [[[], false, null], [[], true, { file: { name: 'Retained pending file' } }], [Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: 'Synthetic.pdf', content_type: 'application/pdf' })), true, null]] as any[]) {
    const guarded = await make(items, canModify, pending); assert.ok(!find(guarded.render(props), 'label', 'Add photo or PDF'));
  }
  assert.equal(picks, 1); assert.equal(uploads, 0);
});

test('PDF and photo attachment rows reuse the same private thumbnail component and keep the file open action', () => {
  let opens = 0;
  for (const content_type of ['application/pdf', 'image/jpeg']) {
    const app = harness('src/BillAttachments.tsx', 'AttachmentRow', { PrivateMediaImage: 'PrivateMediaImage', mediaSize: () => '1 KB', useUI: () => ({ ui: {}, palette: {} }) });
    const item = { id: 'file', name: 'Synthetic attachment', content_type, size: 1000 };
    const tree = app.render({ session: {}, item, disabled: false, onOpen: () => opens++, options: null });
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
  let tree = app.render(props); const fields = find(tree, 'title', 'Who paid?').children[0];
  const controls = fields.type(fields.props);
  assert.equal(find(controls, 'title', 'Jordan (removed)').props.disabled, true);
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
  find(app.render(props), 'label', 'Add photo or PDF').props.onPress(); await tick();
  assert.deepEqual(events, ['pick', 'stage', 'persist file', 'clear picker']); assert.equal(value.file.uri, staged.uri);
  const tree = app.render({ ...props, value }); assert.equal(nodes(tree).find(node => node.type === 'LocalAttachment')!.props.file, staged);
  find(tree, 'title', 'Remove file').props.onPress(); await tick();
  assert.equal(value, undefined); assert.deepEqual(events.slice(-2), ['persist removal', 'clear staged']); assert.equal(error, '');
});

test('bill save preserves both draft and file if enqueue fails, then reuses the same bill/file IDs on retry', async () => {
  const file = { id: 'file-id', path: '/groups/g/expenses/bill-id/attachments', file: { uri: 'file:///staged.png' } };
  const events: string[] = [], expense = { id: 'bill-id' }; let fail = true;
  const env: Record<string, any> = { animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, selected: { group: {} }, session: {}, owner: 'owner', groupId: 'g', expenseId: null, reviewCommand: null,
    perform: (action: any) => action(), draftWrites: { current: Promise.resolve() }, getDatabase: async () => ({}),
    expensePayload: (value: any) => value, command: (_method: string, _path: string, body: any) => body,
    queue: async (body: any, _replacing: unknown, attachment: unknown) => { assert.equal(body.id, 'bill-id'); assert.equal(attachment, file); events.push('queue bill and file'); if (fail) throw Error('Disk full'); },
    saveDraft: async () => { events.push('clear bill draft'); }, setDraft() {}, setReviewCommand() {}, setReviewInput() {}, navigate() {}, isOnline: () => false };
  const save = appAction('saveExpense', env);
  await assert.rejects(save(expense, file), /Disk full/); assert.deepEqual(events, ['queue bill and file']);
  fail = false; await save(expense, file); assert.deepEqual(events, ['queue bill and file', 'queue bill and file']);
});

const notificationToggle = (tree: any, label: string) => nodes(tree).find(node => node.type === 'NotificationSwitch' && node.props.label === label)!;

function notificationPanel(initial: { expense_updates: boolean; email_reminders: boolean; notifications_enabled?: boolean; email_available?: boolean; push_device_ids?: string[] } | null) {
  let preferences = initial, loads = 0, pushCalls = 0;
  const changes: boolean[] = [], pending: { value: any; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  const push = { state: { enabled: true, installationId: 'this-device', optedIn: true, ready: true, working: false, permission: 'granted', error: '' }, enable: async () => { pushCalls++; push.state.enabled = true; return true; }, disable: async () => { pushCalls++; push.state.enabled = false; } };
  const app = harness('src/AccountNotifications.tsx', 'AccountNotifications', { AppState: { addEventListener: () => ({ remove() {} }) },
    request: async (_session: unknown, _path: string, method = 'GET', value?: any) => {
      if (method === 'GET') { loads++; if (!preferences) throw Error('offline'); return { ...preferences }; }
      return new Promise((resolve, reject) => pending.push({ value, resolve, reject }));
    } });
  const props = { session: { token: 'synthetic' }, push, busy: false, onBusyChange: (value: boolean) => changes.push(value) };
  return { app, props, pending, changes, get loads() { return loads; }, get pushCalls() { return pushCalls; }, get savedPreferences() { return preferences; },
    saved: (at: number) => { const next = pending[at].value; if (preferences?.email_reminders && !next.email_reminders && !push.state.enabled) next.expense_updates = false; preferences = { ...next, notifications_enabled: next.expense_updates && (next.email_reminders || push.state.enabled) }; pending[at].resolve({ ...preferences }); }, restore: () => { preferences = { expense_updates: false, email_reminders: true }; } };
}

test('master hides channels while off and each explicit ON shows both defaults immediately', async () => {
  const panel = notificationPanel({ expense_updates: false, email_reminders: true }), { app, props } = panel;
  app.render(props); app.commit(); await tick(); let tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
  assert.equal(notificationToggle(tree, 'Email notifications'), undefined);
  assert.ok(!nodes(tree).some(node => node.type === 'PushSettings'));
  notificationToggle(tree, 'Notifications').props.onChange(true); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, true);
  assert.equal(notificationToggle(tree, 'Notifications').props.disabled, true);
  assert.deepEqual(panel.pending[0].value, { expense_updates: true, email_reminders: true });
  panel.saved(0); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Email notifications').props.checked, true);
  assert.equal(nodes(tree).filter(node => node.type === 'PushSettings').length, 1);
  notificationToggle(tree, 'Email notifications').props.onChange(false); panel.saved(1); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, true);
  notificationToggle(tree, 'Notifications').props.onChange(false); panel.saved(2); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
  assert.equal(notificationToggle(tree, 'Email notifications'), undefined);
  notificationToggle(tree, 'Notifications').props.onChange(true); panel.saved(3); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Email notifications').props.checked, true, 'each master ON restores Email, not the previous manual OFF');
  assert.equal(panel.pushCalls, 0, 'an already valid push binding does not ask permission again');
  assert.deepEqual(panel.changes, [], 'notification saves do not lock the parent page');
  app.unmount();
});

test('Notifications updates immediately, rolls back failures and prevents duplicate writes without locking the page', async () => {
  const panel = notificationPanel({ expense_updates: true, email_reminders: true }), { app, props } = panel;
  app.render(props); app.commit(); await tick(); let tree = app.render(props);
  const change = notificationToggle(tree, 'Notifications').props.onChange;
  change(false); change(false); assert.equal(panel.pending.length, 1); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
  assert.equal(notificationToggle(tree, 'Notifications').props.disabled, true);
  assert.equal(notificationToggle(tree, 'Email notifications'), undefined);
  assert.equal(find(tree, 'title', 'Close notifications').props.disabled, false);
  assert.deepEqual(panel.changes, []);
  panel.pending[0].reject(Error('offline')); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, true);
  assert.equal(notificationToggle(tree, 'Email notifications').props.checked, true);
  assert.ok(nodes(tree).some(node => node.type === 'ErrorText' && node.children.includes('Could not save notifications. Try again.')));
  tree = app.render({ ...props, busy: true }); notificationToggle(tree, 'Notifications').props.onChange(false); assert.equal(panel.pending.length, 1);
  tree = app.render(props); notificationToggle(tree, 'Notifications').props.onChange(false); panel.saved(1); await tick();
  assert.equal(notificationToggle(app.render(props), 'Notifications').props.checked, false);
  assert.equal(panel.pushCalls, 0); assert.deepEqual(panel.changes, []); app.unmount();
});

test('Unavailable notification preferences show error and Retry without inventing OFF state', async () => {
  const panel = notificationPanel(null), { app, props } = panel;
  app.render(props); app.commit(); await tick(); let tree = app.render(props);
  assert.ok(!nodes(tree).some(node => node.type === 'NotificationSwitch' || node.type === 'PushSettings'));
  assert.ok(nodes(tree).some(node => node.type === 'ErrorText'));
  panel.restore(); find(tree, 'title', 'Retry').props.onPress(); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
  assert.equal(panel.loads, 2); app.unmount();
});

test('Push UI retains permission denial, native enable action and parent/working locks; browser has no switch', async () => {
  let enabled = 0, settings = 0; const busyChanges: boolean[] = [];
  const push = { state: { enabled: false, working: false, ready: true, permission: 'ask', pendingOff: false, error: '' }, enable: async () => { enabled++; }, disable: async () => {}, refresh: async () => {} };
  const app = harness('src/PushSettings.tsx', 'PushSettings', { Notifications: { setNotificationHandler() {} }, Linking: { openSettings: async () => { settings++; } } });
  const props = { push, busy: false, onBusyChange: (value: boolean) => busyChanges.push(value) };
  notificationToggle(app.render(props), 'Push notifications').props.onChange(true); await tick();
  assert.equal(enabled, 1); assert.deepEqual(busyChanges, [true, false]);
  for (const held of [{ ...props, busy: true }, { ...props, push: { ...push, state: { ...push.state, working: true } } }]) {
    const row = notificationToggle(app.render(held), 'Push notifications'); assert.equal(row.props.disabled, true); row.props.onChange(true); await tick(); assert.equal(enabled, 1);
  }
  const denied = { ...props, push: { ...push, state: { ...push.state, permission: 'denied' } } };
  const tree = app.render(denied); assert.equal(notificationToggle(tree, 'Push notifications').props.disabled, true);
  find(tree, 'title', 'Open phone settings').props.onPress(); await tick(); assert.equal(settings, 1);
  const web = harness('src/PushSettings.web.tsx', 'PushSettings').render(props);
  assert.ok(!nodes(web).some(node => node.type === 'NotificationSwitch' || node.type === 'Switch'));
  assert.ok(nodes(web).some(node => node.type === 'Text' && node.children.some((text: any) => typeof text === 'string' && text.includes('Available in the mobile app. This browser refreshes while open.'))));
});

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
  const props = { session: { token: 'session' }, visible: true, emailEnabled: true, busy: false, onBusyChange: (value: boolean) => busy.push(value) };
  return { app, props, writes, busy, timers, reads: () => reads, fail: (value: boolean) => { failSend = value; } };
}

test('statements default off, reveal existing radio controls only when on, and manual send never subscribes', async () => {
  const panel = statementPanel(), { app, props } = panel;
  app.render(props); app.commit(); await tick(); let tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Balance statements').props.checked, false);
  assert.equal(nodes(tree).filter(node => node.type === 'RadioChoice').length, 0);
  find(tree, 'title', 'Email statement now').props.onPress(); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Balance statements').props.checked, false);
  assert.deepEqual(panel.writes[0].value, { command_id: 'bill-id' });
  notificationToggle(tree, 'Balance statements').props.onChange(true); await tick(); tree = app.render(props);
  assert.equal(nodes(tree).filter(node => node.type === 'RadioChoice').length, 2);
  assert.equal(find(tree, 'label', 'Monthly').props.selected, true);
  find(tree, 'label', 'Weekly').props.onPress(); await tick(); tree = app.render(props);
  assert.equal(find(tree, 'label', 'Weekly').props.selected, true);
  assert.deepEqual(panel.writes[2].value, { enabled: true, frequency: 'weekly' });
  app.unmount();
});

test('uncertain statement send retries the same command and blocks double taps', async () => {
  const panel = statementPanel(), { app, props } = panel;
  app.render(props); app.commit(); await tick(); let tree = app.render(props);
  panel.fail(true); const send = find(tree, 'title', 'Email statement now'); send.props.onPress(); send.props.onPress();
  await tick(); assert.equal(panel.writes.length, 1); tree = app.render(props);
  assert.ok(nodes(tree).some(node => node.type === 'ErrorText'));
  panel.fail(false); find(tree, 'title', 'Email statement now').props.onPress(); await tick();
  assert.equal(panel.writes.length, 2); assert.deepEqual(panel.writes[0], panel.writes[1]);
  assert.deepEqual(panel.busy, [true, false, true, false]);
  app.unmount();
});

test('statement feedback distinguishes queued, accepted, oversized and uncertain delivery', () => {
  const app = harness('src/BalanceStatements.tsx', 'StatementDelivery');
  const text = (tree: any): string => nodes(tree).flatMap(node => node.children).filter(child => typeof child === 'string').join(' ');
  assert.match(text(app.render({ delivery: { state: 'pending', error: '' } })), /queued/);
  assert.match(text(app.render({ delivery: { state: 'accepted', error: '' } })), /accepted for email delivery/);
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
  const web = harness('src/RadioChoice.web.tsx', 'RadioChoice', { useUI: () => ({ palette: {} }) }).render(props);
  const input = nodes(web).find(node => node.type === 'input')!;
  assert.equal(web.type, 'label'); assert.equal(input.props.type, 'radio'); assert.equal(input.props.checked, true); assert.equal(input.props.name, props.group);
  input.props.onChange(); assert.equal(choices, 1);
  const native = harness('src/RadioChoice.tsx', 'RadioChoice', { RadioButton: { Item: 'RadioItem' } }).render(props);
  assert.equal(native.type, 'RadioItem'); assert.equal(native.props.status, 'checked'); assert.equal(native.props.value, props.value);
});


test('notification body uses spare desktop height while retaining compact phones and the native cap', () => {
  for (const [os, height, expected] of [['web', 900, 560], ['web', 667, 443], ['web', 500, 276], ['native', 900, 440]] as const) {
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


test('balance dialog hides changed calculations, ignores late closed loads, and stays read-only', async () => {
  let resolve!: (value: any) => void, restores = 0, closes = 0;
  const group = { id: 'g', name: 'Trip', version: 1, participants: [{ id: 'A', name: 'Riya' }, { id: 'B', name: 'Asha' }], expenses: [{ id: 'bill', description: 'Lunch', total: '501', paid: { B: '501' }, shares: { A: '501' }, date: '2026-10-19', deleted: false }], settlements: [], balances: { A: '-501', B: '501' }, transfers: [{ sender: 'A', recipient: 'B', amount: '501' }], activity: [] };
  const selection = { group, accepted: group, selfId: 'A', commands: [], transfer: group.transfers[0], restoreFocus: () => restores++, load: () => new Promise(done => { resolve = done; }) };
  const app = harness('src/BalanceExplanationDialog.tsx', 'BalanceExplanation', { explainTransfer, balanceKey, changedBalance: 'This balance changed.', Disclosure: 'Disclosure' });
  const props = { selection, currentKey: balanceKey(group as any, []), onClose: () => closes++ };
  let tree = app.render(props); app.commit();
  assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.visible, true);
  assert.ok(nodes(tree).some(node => node.type === 'Text' && node.children.includes('Loading the full breakdown…')));
  resolve({ group, saved: true }); await tick(); tree = app.render(props); app.commit();
  assert.ok(nodes(tree).some(node => typeof node.type === 'function' && node.type.name === 'ExplanationBody'));
  assert.ok(!nodes(tree).some(node => ['Pay', 'Record', 'Record payment'].includes(node.props.title)));
  const changed = app.render({ ...props, currentKey: 'newer group' }); app.commit();
  assert.ok(!nodes(changed).some(node => typeof node.type === 'function' && node.type.name === 'ExplanationBody'));
  assert.ok(nodes(changed).some(node => node.props.accessibilityRole === 'alert'));
  find(tree, 'accessibilityLabel', 'Close explanation').props.onPress(); assert.equal(closes, 1); assert.equal(restores, 1);
  assert.doesNotThrow(() => app.render({ ...props, selection: null }), 'closing renders safely before effects clear the loaded result');
  app.commit();
  const next = { ...selection };
  app.render({ ...props, selection: next }); app.commit();
  const old = resolve;
  app.render({ ...props, selection: null }); app.commit();
  old({ group, saved: false }); await tick();
  tree = app.render({ ...props, selection: null });
  assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.visible, false);
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
    { id: 'self', name: 'Riya', payment_profile: { vpa: 'own@example' } },
    { id: 'other', name: 'Asha', payment_profile: { vpa: 'asha@example' } },
  ] };
  const env = { useMemo: (fn: () => unknown) => fn(), useUI: () => ({ ui: {}, palette: {} }), isPersonalPayment, paymentReturnNeedsConfirmation,
    PaymentAddress: 'PaymentAddress', PaymentHelpDialog: 'PaymentHelpDialog', LoadingSpinner: 'LoadingSpinner', UPIAppChooser: 'UPIAppChooser', WebPaymentQuote: 'WebPaymentQuote' };
  for (const incoming of [false, true]) {
    const props = { group: paymentGroup, selfId: 'self', busy: true, returnPayment: null,
      initial: { sender: incoming ? 'other' : 'self', recipient: incoming ? 'self' : 'other', amount: '500' } };
    const tree = harness('src/SettleForm.tsx', 'SettleForm', env).render(props);
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

test('master reflects usable channel combinations without changing saved choices or asking permission', async () => {
  for (const email of [false, true]) for (const push of [false, true]) {
    const panel = notificationPanel({ expense_updates: true, email_reminders: email });
    panel.props.push.state.enabled = push;
    panel.app.render(panel.props); panel.app.commit(); await tick();
    assert.equal(notificationToggle(panel.app.render(panel.props), 'Notifications').props.checked, email || push);
    assert.equal(panel.pending.length, 0); assert.equal(panel.pushCalls, 0);
    panel.app.unmount();
  }
  for (const ids of [['this-device'], ['other-device']]) {
    const panel = notificationPanel({ expense_updates: true, email_reminders: false, notifications_enabled: true, push_device_ids: ids });
    panel.props.push.state.enabled = false; panel.props.push.state.permission = 'denied';
    panel.app.render(panel.props); panel.app.commit(); await tick();
    assert.equal(notificationToggle(panel.app.render(panel.props), 'Notifications').props.checked, ids[0] === 'other-device');
    assert.equal(panel.pending.length, 0); panel.app.unmount();
  }
});

test('last channel OFF hides choices; master ON enables Email and explicitly attempts Push', async () => {
  const panel = notificationPanel({ expense_updates: true, email_reminders: true });
  panel.props.push.state.enabled = false;
  panel.app.render(panel.props); panel.app.commit(); await tick();
  notificationToggle(panel.app.render(panel.props), 'Email notifications').props.onChange(false);
  panel.saved(0); await tick(); let tree = panel.app.render(panel.props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
  assert.equal(notificationToggle(tree, 'Email notifications'), undefined);
  notificationToggle(tree, 'Notifications').props.onChange(true);
  assert.equal(panel.pending[1].value.email_reminders, true); assert.equal(panel.pushCalls, 0, 'permission/registration waits for preference save');
  panel.saved(1); await tick(); tree = panel.app.render(panel.props);
  assert.equal(panel.pushCalls, 1); assert.equal(panel.props.push.state.enabled, true);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, true);
  assert.equal(notificationToggle(tree, 'Email notifications').props.checked, true);
  panel.app.unmount();
});

test('denied or failed push enable keeps backend-confirmed Email on without pretending Push is enabled', async () => {
  for (const failed of [false, true]) {
    const panel = notificationPanel({ expense_updates: false, email_reminders: false }); let attempts = 0;
    panel.props.push.state.enabled = false; panel.props.push.state.permission = 'denied';
    panel.props.push.enable = async () => { attempts++; if (failed) throw Error('Push unavailable'); return false; };
    panel.app.render(panel.props); panel.app.commit(); await tick();
    notificationToggle(panel.app.render(panel.props), 'Notifications').props.onChange(true);
    panel.saved(0); await tick(); const tree = panel.app.render(panel.props);
    assert.equal(attempts, 1); assert.equal(panel.props.push.state.enabled, false);
    assert.equal(notificationToggle(tree, 'Notifications').props.checked, true);
    assert.equal(notificationToggle(tree, 'Email notifications').props.checked, true);
    if (failed) assert.ok(nodes(tree).some(node => node.type === 'ErrorText'));
    panel.app.unmount();
  }
});

test('failed master ON and unmount do not request push or expose unconfirmed choices', async () => {
  for (const unmount of [false, true]) {
    const panel = notificationPanel({ expense_updates: false, email_reminders: false });
    panel.props.push.state.enabled = false;
    panel.app.render(panel.props); panel.app.commit(); await tick();
    notificationToggle(panel.app.render(panel.props), 'Notifications').props.onChange(true);
    if (unmount) { panel.app.unmount(); panel.saved(0); } else panel.pending[0].reject(Error('Offline'));
    await tick(); assert.equal(panel.pushCalls, 0);
    if (!unmount) {
      const tree = panel.app.render(panel.props); assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
      assert.equal(notificationToggle(tree, 'Email notifications'), undefined); panel.app.unmount();
    }
  }
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
  const route = {}; const env: Record<string, any> = { animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, navigation: { ref: { getRootState: () => route } }, profileRevision: { current: 0 }, profilePromptSafe: { current: true }, request: async () => me, rememberName: async () => {}, activeSessionRef, ownerRef: { current: owner }, accountOwner: (value: any) => `${value.baseUrl}|${value.userId}`, setVpa: (value: string) => addresses.push(value), setUpiSetup: (value: boolean) => prompts.push(value), upiPrompts: { current: new Set() } };
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
  const env = { animateLayout() {}, React: { ...React, forwardRef: (render: any) => render }, useState: () => [false, () => {}], View: 'View', Text: 'Text', Pressable: 'Pressable', useUI: () => ({ palette: {}, ui: {} }), usePressFeedback: () => ({ pressedStyle: {} }), PaperButton: 'PaperButton', Icon: 'Icon', radii: { button: 8 }, Platform: { OS: 'ios' } };
  const Button = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${code};return Button;}`)(env);
  const injected = [{ marginRight: 8 }], onPress = () => {};
  for (const disabled of [false, true]) {
    const element = Button({ title: 'Cancel', kind: 'text', compact: true, style: injected, disabled, onPress });
    assert.ok(element.props.style({ pressed: false }).includes(injected), 'preserve Dialog.Actions child spacing');
    element.props.onPress({}); assert.equal(element.props.disabled, disabled);
    assert.equal(element.props.accessibilityLabel, 'Cancel');
  }
});


test('last Push OFF mutes the account and hides both choices, including another saved device', async () => {
  const panel = notificationPanel({ expense_updates: true, email_reminders: false, push_device_ids: ['this-device', 'other-device'] });
  panel.app.render(panel.props); panel.app.commit(); await tick();
  const pushRow = nodes(panel.app.render(panel.props)).find(node => node.type === 'PushSettings')!;
  panel.props.push.state.enabled = false;
  void pushRow.props.onChanged(false);
  assert.equal(panel.pending[0].value.expense_updates, false);
  panel.saved(0); await tick(); const tree = panel.app.render(panel.props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
  assert.equal(notificationToggle(tree, 'Email notifications'), undefined);
  panel.app.unmount();
});

test('master updates immediately during push registration and confirmed defaults survive reload', async () => {
  const panel = notificationPanel({ expense_updates: false, email_reminders: false }); let finish!: () => void;
  panel.props.push.state.enabled = false;
  panel.props.push.enable = () => new Promise<boolean>(resolve => { finish = () => { panel.props.push.state.enabled = true; resolve(true); }; });
  panel.app.render(panel.props); panel.app.commit(); await tick();
  notificationToggle(panel.app.render(panel.props), 'Notifications').props.onChange(true);
  panel.saved(0); await tick(); let tree = panel.app.render(panel.props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, true);
  assert.equal(notificationToggle(tree, 'Email notifications').props.checked, true);
  assert.ok(!nodes(tree).some(node => node.type === 'LoadingSpinner'));
  finish(); await tick(); tree = panel.app.render(panel.props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, true);
  const saved = panel.savedPreferences; panel.app.unmount();
  const reload = notificationPanel(saved); reload.app.render(reload.props); reload.app.commit(); await tick();
  assert.equal(notificationToggle(reload.app.render(reload.props), 'Notifications').props.checked, true);
  assert.equal(notificationToggle(reload.app.render(reload.props), 'Email notifications').props.checked, true);
  assert.equal(reload.pushCalls, 0, 'loading saved choices is not permission consent');
  reload.app.unmount();
});


test('server-revoked push IDs override stale local enabled state', async () => {
  const panel = notificationPanel({ expense_updates: true, email_reminders: false, email_available: true, push_device_ids: [], notifications_enabled: false });
  panel.props.push.state.enabled = true;
  panel.app.render(panel.props); panel.app.commit(); await tick();
  const tree = panel.app.render(panel.props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
  assert.equal(notificationToggle(tree, 'Email notifications'), undefined);
  assert.equal(panel.pushCalls, 0); panel.app.unmount();
});

test('explicit master ON refreshes server-confirmed channels after a new push registration', async () => {
  const panel = notificationPanel({ expense_updates: false, email_reminders: false, email_available: false, push_device_ids: [], notifications_enabled: false });
  panel.props.push.state.enabled = false;
  panel.props.push.enable = async () => {
    panel.props.push.state.enabled = true;
    Object.assign(panel.savedPreferences!, { email_available: false, push_device_ids: ['this-device'], notifications_enabled: true });
    return true;
  };
  panel.app.render(panel.props); panel.app.commit(); await tick();
  notificationToggle(panel.app.render(panel.props), 'Notifications').props.onChange(true);
  panel.saved(0); await tick();
  assert.equal(panel.loads, 2, 'new registration reads authoritative current device IDs');
  assert.equal(notificationToggle(panel.app.render(panel.props), 'Notifications').props.checked, true);
  assert.deepEqual(panel.savedPreferences!.push_device_ids, ['this-device']);
  panel.app.unmount();
});


test('stale current push binding stays off in the channel view and last local Email OFF hides channels', async () => {
  const panel = notificationPanel({ expense_updates: true, email_reminders: true, notifications_enabled: true, push_device_ids: ['other-device'] });
  panel.props.push.state.enabled = true;
  panel.app.render(panel.props); panel.app.commit(); await tick();
  let tree = panel.app.render(panel.props);
  const pushRow = nodes(tree).find(node => node.type === 'PushSettings')!;
  assert.equal(pushRow.props.push.state.enabled, false);
  assert.equal(pushRow.props.push.enable, panel.props.push.enable, 'existing permission and registration functions are preserved');
  notificationToggle(tree, 'Email notifications').props.onChange(false);
  assert.equal(panel.pending[0].value.expense_updates, false);
  panel.saved(0); await tick(); tree = panel.app.render(panel.props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
  assert.equal(notificationToggle(tree, 'Email notifications'), undefined);
  assert.ok(!nodes(tree).some(node => node.type === 'PushSettings'));
  panel.app.unmount();
});


function billDiscardDialog(env: Record<string, any>) {
  const source = ts.createSourceFile('AppStack.tsx', readFileSync(new URL('../src/AppStack.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.JsxElement | undefined;
  function visit(node: ts.Node) { if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'KeyboardDialog') expression = node; ts.forEachChild(node, visit); }
  visit(source); assert.ok(expression);
  const code = ts.transpile(`const dialog = ${expression!.getText(source)}`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  return new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${code};return dialog;}`)({ React, Dialog, PersonInviteDialog: 'PersonInviteDialog', useToast: () => () => {}, DetailDialog: 'DetailDialog', setDiscarding() {}, draftDiscard: { current: null }, discarding: false, discardLock: { current: false }, blocked: false, localBlocked: false, pending: env.discardBill ? { type: 'GO_BACK' } : null, setPending: (value: unknown) => env.setDiscardBill(!!value), KeyboardDialog: 'KeyboardDialog', DialogFocus: 'DialogFocus', CancelDialogActions: 'CancelDialogActions', Button: 'Button', ...env, navigation: { isFocused: () => true, dispatch: () => env.navigate('group') } });
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
      const env: Record<string, any> = { animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, selected: { group: { ...group, version: 1 } }, session, owner, groupId: 'g', expenseId: null, reviewCommand: null,
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
    const env: Record<string, any> = { animateLayout() {}, PeopleSheet: 'PeopleSheet', currencySymbol, selected: { group: { ...group, version: 1 } }, session, owner, groupId: 'g', expenseId: null, reviewCommand: null,
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
