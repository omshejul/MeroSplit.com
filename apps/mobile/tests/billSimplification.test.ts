import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as members from '../src/members.ts';
import { formatMoney, integer, rupeesToPaise, validateExpense } from '../src/accounting.ts';

type Element = { type: any; props: Record<string, any>; children: any[] };
const React = { createElement: (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children }) };
const Dialog = Object.assign(() => {}, { Title: 'Title', Content: 'Content', Actions: 'Actions' });
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
const find = (tree: any, prop: string, value: string) => nodes(tree).find(node => node.props[prop] === value)!;
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function harness(file: string, name: string, extra: Record<string, any> = {}) {
  let cursor = 0, states: any[] = [], effects: (() => void)[] = [], cleanups: Record<number, () => void> = {};
  const deps: Record<number, any[]> = {};
  const env: Record<string, any> = { React, Dialog, View: 'View', ScrollView: 'ScrollView', KeyboardDialog: 'KeyboardDialog', Pressable: 'Pressable', Text: 'Text', NotificationSwitch: 'NotificationSwitch', PushSettings: 'PushSettings', BalanceStatements: 'BalanceStatements', DialogScrollBody: 'DialogScrollBody', Form: 'Form', SectionHeading: 'SectionHeading', Button: 'Button', Icon: 'Icon', SettingsRow: 'SettingsRow', BillPeople: 'BillPeople', DraftAttachment: 'DraftAttachment', LocalAttachment: 'LocalAttachment', AmountField: 'AmountField', TextField: 'TextField', DateField: 'DateField', ErrorText: 'ErrorText', Checkbox: { Item: 'Checkbox' }, RadioChoice: 'RadioChoice', Crypto: { randomUUID: () => 'bill-id' }, StyleSheet: { create: (value: any) => value }, Keyboard: { dismiss() {} }, useWindowDimensions: () => ({ height: 667 }), useSafeAreaInsets: () => ({ top: 20, bottom: 0 }), Platform: { OS: 'native' }, requestAnimationFrame: (fn: () => void) => fn(), useUI: () => ({ ui: {} }), formatMoney, integer, rupeesToPaise, validateExpense, ...extra,
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = typeof initial === 'function' ? initial() : initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
    useEffect: (fn: () => any, values: any[]) => { const id = cursor++; if (!deps[id] || values.some((value, i) => value !== deps[id][i])) { effects.push(() => { cleanups[id]?.(); cleanups[id] = fn(); }); deps[id] = values; } },
  };
  const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const code = ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  const render = new Function('env', `with(env){${code}; return ${name};}`)(env);
  return { render: (props: any) => { cursor = 0; return render(props); }, commit: () => { const pending = effects; effects = []; pending.forEach(fn => fn()); }, unmount: () => Object.values(cleanups).forEach(fn => fn?.()), env };
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
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const app = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AppContent') as ts.FunctionDeclaration;
  const fn = app.body!.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  return new Function('env', `with(env){${ts.transpile(fn.getText(source), { target: ts.ScriptTarget.ES2022 })};return ${name};}`)(env);
}

test('combined export flushes saved work and never shares a stale account result', async () => {
  const calls: any[] = [], notices: any[] = [], ownerRef = { current: 'owner-a' }, session = { token: 'session-a' };
  const data = { account_data_status: 'unavailable_offline' };
  const env: Record<string, any> = { owner: 'owner-a', ownerRef, session, activeSessionRef: { current: session },
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
  assert.ok(drafts.every(draft => draft.schemaVersion === 1 && draft.groupId === 'g'));
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

test('people dialog opens/closes/reopens without changing its existing inputs and keeps Done outside scroll', () => {
  const app = harness('src/BillPeople.tsx', 'BillPeople'); const child = React.createElement('Input', { value: 'Preserved' });
  const props = { title: 'Who paid?', summary: '2 people', inline: false, disabled: false, children: child };
  let tree = app.render(props); app.commit();
  for (let i = 0; i < 2; i++) {
    nodes(tree).find(node => node.type === 'Pressable')!.props.onPress(); tree = app.render(props); app.commit();
    assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.visible, true);
    assert.equal(nodes(tree).find(node => node.type === 'ScrollView')!.props.keyboardShouldPersistTaps, 'handled');
    assert.ok(!nodes(nodes(tree).find(node => node.type === 'ScrollView')).some(node => node.props.title === 'Done'));
    assert.equal(nodes(tree).find(node => node.type === 'Input'), child);
    find(tree, 'title', 'Done').props.onPress(); tree = app.render(props); app.commit();
    assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.visible, false);
  }
});

test('people dialog adapts to short viewports and Done dismisses the keyboard while retaining inputs', () => {
  const viewport = { height: 667 }, safe = { top: 20, bottom: 0 }; let dismisses = 0;
  const people = harness('src/BillPeople.tsx', 'BillPeople', { useWindowDimensions: () => viewport, useSafeAreaInsets: () => safe, Keyboard: { dismiss: () => dismisses++ } });
  const child = React.createElement('Input', { value: '700.00' });
  const props = { title: 'Who paid?', icon: 'pay', summary: '2 people', inline: false, disabled: false, children: child };
  for (const [height, top, bottom] of [[667, 20, 0], [844, 47, 34], [375, 0, 21]]) {
    Object.assign(viewport, { height }); Object.assign(safe, { top, bottom });
    assert.equal(nodes(people.render(props)).find(node => node.type === 'KeyboardDialog')!.props.maxHeight, height - top - bottom);
  }
  let tree = people.render(props); people.commit(); nodes(tree).find(node => node.type === 'Pressable')!.props.onPress();
  tree = people.render(props); people.commit(); find(tree, 'title', 'Done').props.onPress();
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
  assert.ok(!nodes(tree).some(node => node.type === 'Pressable'), 'preview fallback must not nest a button in the file button');
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
    assert.equal(retry.type, 'Pressable'); assert.equal(retry.props.accessibilityRole, 'button');
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


test('opening a cached bill/payment fetches actor detail once, merges it into the rendered record and retains offline data', async () => {
  const calls: string[] = [], active = { token: 'synthetic' };
  const env = { isOnline: () => true, request: async (_session: any, path: string) => { calls.push(path); return path.includes('/expenses/') ? { id: 'bill', group_id: 'g', group_version: 4, added_by: 'Actual creator' } : { id: 'payment', group_version: 4, recorded_by_name: 'Actual recorder' }; } };
  const legacy = { id: 'g', version: 4, expenses: [{ id: 'bill' }], settlements: [{ id: 'payment' }] };
  const withBill = appAction('withBill', env), withPayment = appAction('withPayment', env);
  const bill = await withBill(active, legacy, 'bill'); assert.equal(bill.expenses[0].added_by, 'Actual creator');
  assert.equal(await withBill(active, bill, 'bill'), bill); assert.equal(calls.length, 1);
  const payment = await withPayment(active, legacy, 'payment'); assert.equal(payment.settlements[0].recorded_by_name, 'Actual recorder');
  assert.equal(await withPayment(active, payment, 'payment'), payment); assert.equal(calls.length, 2);
  env.isOnline = () => false;
  assert.equal(await withBill(active, legacy, 'bill'), legacy); assert.equal(await withPayment(active, legacy, 'payment'), legacy); assert.equal(calls.length, 2);
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
  const env: Record<string, any> = { selected: { group: {} }, session: {}, owner: 'owner', groupId: 'g', expenseId: null, reviewCommand: null,
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
  let preferences = initial, loads = 0, pushCalls = 0;
  const changes: boolean[] = [], pending: { value: any; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  const push = { state: { enabled: true, optedIn: true, ready: true, working: false, permission: 'granted', error: '' }, enable: () => { pushCalls++; }, disable: () => { pushCalls++; } };
  const app = harness('src/AccountNotifications.tsx', 'AccountNotifications', { AppState: { addEventListener: () => ({ remove() {} }) },
    request: async (_session: unknown, _path: string, method = 'GET', value?: any) => {
      if (method === 'GET') { loads++; if (!preferences) throw Error('offline'); return { ...preferences }; }
      return new Promise((resolve, reject) => pending.push({ value, resolve, reject }));
    } });
  const props = { session: { token: 'synthetic' }, push, busy: false, onBusyChange: (value: boolean) => changes.push(value) };
  return { app, props, pending, changes, get loads() { return loads; }, get pushCalls() { return pushCalls; },
    saved: (at: number) => { preferences = pending[at].value; pending[at].resolve({ ...preferences }); }, restore: () => { preferences = { expense_updates: false, email_reminders: true }; } };
}

test('Notifications master alone hides/reveals saved channels without requesting push permission or rewriting channel choices', async () => {
  const panel = notificationPanel({ expense_updates: false, email_reminders: true }), { app, props } = panel;
  app.render(props); app.commit(); await tick(); let tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, false);
  assert.ok(!nodes(tree).some(node => node.type === 'PushSettings' || node.props.label === 'Email notifications'));
  notificationToggle(tree, 'Notifications').props.onChange(true); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.disabled, true);
  assert.deepEqual(panel.pending[0].value, { expense_updates: true, email_reminders: true });
  assert.equal(panel.pushCalls, 0); assert.equal(props.push.state.optedIn, true);
  panel.saved(0); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Email notifications').props.checked, true);
  assert.equal(nodes(tree).filter(node => node.type === 'PushSettings').length, 1);
  notificationToggle(tree, 'Email notifications').props.onChange(false); panel.saved(1); await tick(); tree = app.render(props);
  notificationToggle(tree, 'Notifications').props.onChange(false); panel.saved(2); await tick(); tree = app.render(props);
  assert.ok(!nodes(tree).some(node => node.type === 'PushSettings' || node.props.label === 'Email notifications'));
  notificationToggle(tree, 'Notifications').props.onChange(true); panel.saved(3); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Email notifications').props.checked, false);
  assert.equal(props.push.state.optedIn, true); assert.equal(panel.pushCalls, 0);
  assert.deepEqual(panel.changes, [true, false, true, false, true, false, true, false]);
  app.unmount();
});

test('Notifications keeps confirmed state on failed save, locks duplicate writes and subcontrols, then permits retry', async () => {
  const panel = notificationPanel({ expense_updates: true, email_reminders: true }), { app, props } = panel;
  app.render(props); app.commit(); await tick(); let tree = app.render(props);
  const change = notificationToggle(tree, 'Notifications').props.onChange;
  change(false); change(false); assert.equal(panel.pending.length, 1); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Email notifications').props.disabled, true);
  assert.equal(nodes(tree).find(node => node.type === 'PushSettings')!.props.busy, true);
  panel.pending[0].reject(Error('offline')); await tick(); tree = app.render(props);
  assert.equal(notificationToggle(tree, 'Notifications').props.checked, true);
  assert.equal(notificationToggle(tree, 'Email notifications').props.checked, true);
  assert.ok(nodes(tree).some(node => node.type === 'ErrorText' && node.children.includes('Could not save notifications. Try again.')));
  tree = app.render({ ...props, busy: true }); notificationToggle(tree, 'Notifications').props.onChange(false); assert.equal(panel.pending.length, 1);
  tree = app.render(props); notificationToggle(tree, 'Notifications').props.onChange(false); panel.saved(1); await tick();
  assert.equal(notificationToggle(app.render(props), 'Notifications').props.checked, false);
  assert.equal(panel.pushCalls, 0); assert.equal(panel.changes.at(-1), false); app.unmount();
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
  const app = harness('src/MembersScreen.tsx', 'MemberSettings', { ...members, Avatar: 'Avatar', IconAction: 'IconAction', Disclosure: 'Disclosure', GroupMembershipActions: 'GroupMembershipActions', EmailField: 'EmailField',
    Crypto: { randomUUID: () => `command-${++ids}` }, setTimeout: () => 0, clearTimeout() {} });
  const props = { group, selfId: 'owner', busy: false, onAction, onMembership() {} };
  const row = (tree: any) => nodes(tree).find(node => node.props.person?.id === 'imported-person' && node.props.onAddEmail)!;
  const dialog = (tree: any) => nodes(tree).find(node => node.props.onEmail && node.props.onSave && 'person' in node.props)!;
  app.render(props); app.commit();
  return { app, props, row, dialog, open(email: string) { row(app.render(props)).props.onAddEmail(); dialog(app.render(props)).props.onEmail(email); return dialog(app.render(props)); } };
}

test('Existing imported person email saves before invitation, uses the refreshed callback and preserves ID/history with stale original group props', async () => {
  const calls: any[] = []; let finish!: (value: any) => void;
  const panel = memberPanel(async (path, body) => { calls.push({ path, body }); return new Promise(resolve => { finish = resolve; }); });
  panel.open(' ASHA@Example.invalid ').props.onSave(); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/participants/imported-person/contact');
  assert.deepEqual(calls[0].body, { command_id: 'command-1', email: 'asha@example.invalid' });
  const freshAction = async (path: string, body: any) => { calls.push({ path, body, fresh: true }); return { id: inviteGroup.id, version: 3, invite: { id: body.command_id, state: 'sent', retry_after: 60 } }; };
  const before = JSON.stringify(inviteGroup); panel.app.render({ ...panel.props, onAction: freshAction });
  finish({ id: inviteGroup.id, version: 2 }); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[1].path, '/participants/imported-person/email-invite'); assert.equal(calls[1].fresh, true);
  assert.equal(JSON.stringify(inviteGroup), before);
  const tree = panel.app.render(panel.props); assert.equal(panel.dialog(tree).props.person, undefined);
  assert.match(panel.row(tree).props.feedback.text, /Contact saved. Invitation sent to asha@example.invalid/); panel.app.unmount();
});

test('Unknown contact save retries the same command and never sends before accepted contact acknowledgment', async () => {
  const calls: any[] = []; const panel = memberPanel(async (path, body) => { calls.push({ path, body }); if (calls.length === 1) throw Error('Response lost'); return path.endsWith('/contact') ? { id: inviteGroup.id, version: 2 } : { id: inviteGroup.id, version: 3, invite: { id: body.command_id, state: 'sending', retry_after: 60 } }; });
  panel.open('bad address').props.onSave(); await tick(); assert.equal(calls.length, 0);
  panel.dialog(panel.app.render(panel.props)).props.onEmail('asha@example.invalid'); panel.dialog(panel.app.render(panel.props)).props.onSave(); await tick();
  assert.equal(calls.length, 1); assert.ok(panel.dialog(panel.app.render(panel.props)).props.person);
  panel.dialog(panel.app.render(panel.props)).props.onSave(); await tick(); assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls.length, 3); const feedback = panel.row(panel.app.render(panel.props)).props.feedback;
  assert.match(feedback.text, /Contact saved.*still being sent/); assert.doesNotMatch(feedback.text, /Invitation sent to/); panel.app.unmount();
});

test('Contact saved but invitation failed exposes original retry identity, and a reloaded pending invitation reuses the same UUID', async () => {
  const calls: any[] = []; let fail = true;
  const action = async (path: string, body: any) => { calls.push({ path, body }); return path.endsWith('/contact') ? { id: inviteGroup.id, version: 2 } : { id: inviteGroup.id, version: 3, invite: { id: body.command_id, state: fail ? 'failed' : 'sent', retry_after: 0 } }; };
  const panel = memberPanel(action); panel.open('asha@example.invalid').props.onSave(); await tick();
  const invitationId = calls[1].body.command_id;
  const savedGroup = { ...inviteGroup, participants: [inviteGroup.participants[0], { ...inviteGroup.participants[1], email: 'asha@example.invalid' }], invites: [{ id: invitationId, participant_id: 'imported-person', intended_email: 'asha@example.invalid', send_state: 'failed', revoked: false, approved: false }] };
  let tree = panel.app.render({ ...panel.props, group: savedGroup }); assert.match(panel.row(tree).props.feedback.text, /Contact saved.*could not be sent/);
  assert.equal(panel.row(tree).props.feedback.error, true); fail = false; panel.row(tree).props.onSend(); await tick();
  assert.equal(calls.length, 3); assert.deepEqual(calls[2], calls[1]); panel.app.unmount();
  const reload = memberPanel(action, { ...savedGroup, invites: [{ ...savedGroup.invites[0], send_state: 'sending' }] });
  reload.row(reload.app.render(reload.props)).props.onSend(); await tick();
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

test('Member email affordance excludes registered/self/removed/direct/nonorganizer/archive, preserving nonzero removal guard', () => {
  const app = harness('src/MembersScreen.tsx', 'MemberRow', { ...members, Avatar: 'Avatar', IconAction: 'IconAction' });
  const props = { group: inviteGroup, person: inviteGroup.participants[1], selfId: 'owner', organizer: true, disabled: false, working: false, feedback: null, cooldown: 0, contactChanged: false, onAddEmail() {}, onSend() {}, onRemove() {} };
  let tree = app.render(props); assert.equal(find(tree, 'accessibilityLabel', 'Add email and invite Asha').props.accessibilityRole, 'button');
  assert.equal(find(tree, 'label', 'Remove Asha').props.disabled, true);
  for (const patch of [{ person: { ...props.person, user_id: 2 } }, { person: { ...props.person, removed: true } }, { person: { ...props.person, email: 'saved@example.invalid' } }, { selfId: props.person.id }, { group: { ...inviteGroup, is_direct: true } }, { group: { ...inviteGroup, archived: true } }, { organizer: false }]) {
    tree = app.render({ ...props, ...patch }); assert.ok(!nodes(tree).some(node => node.props.accessibilityLabel === 'Add email and invite Asha'));
  }
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


test('member mail slot centers against the complete name/status block and matches the remove action size', () => {
  const app = harness('src/MembersScreen.tsx', 'MemberRow', { currentEmailInvite: () => null, Avatar: 'Avatar', IconAction: 'IconAction' });
  const person = { id: 'other', name: 'Asha' };
  const props = { group: { ...group, owner_id: 1, balances: { other: '-103400' } }, person, selfId: 'self', organizer: true, disabled: false, working: false, cooldown: 0, contactChanged: false, onAddEmail() {}, onSend() {}, onRemove() {} };
  const tree = app.render(props), name = find(tree, 'accessibilityLabel', 'Add email and invite Asha');
  assert.equal(name.props.style.flexDirection, 'row'); assert.equal(name.props.style.alignItems, 'center'); assert.equal(name.props.style.minHeight, 44);
  const slot = nodes(name).find(node => node.type === 'View' && node.props['aria-hidden'] === true)!;
  assert.equal(slot.props.style.width, 44); assert.equal(slot.props.style.height, 44); assert.equal(slot.props.style.flexShrink, 0);
  const icon = nodes(slot).find(node => node.type === 'Icon')!; assert.equal(icon.props.name, 'mail'); assert.equal(icon.props.size, 22);
  assert.equal(find(tree, 'label', 'Remove Asha').props.disabled, true);
  assert.ok(nodes(name).some(node => node.props.accessibilityLabel === 'Settle ₹1,034.00 first'));
});
