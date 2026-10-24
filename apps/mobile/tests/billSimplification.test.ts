import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
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
  const env: Record<string, any> = { React, Dialog, View: 'View', ScrollView: 'ScrollView', KeyboardDialog: 'KeyboardDialog', Pressable: 'Pressable', Text: 'Text', Form: 'Form', SectionHeading: 'SectionHeading', Button: 'Button', Icon: 'Icon', SettingsRow: 'SettingsRow', BillPeople: 'BillPeople', DraftAttachment: 'DraftAttachment', LocalAttachment: 'LocalAttachment', AmountField: 'AmountField', TextField: 'TextField', DateField: 'DateField', ErrorText: 'ErrorText', Checkbox: { Item: 'Checkbox' }, RadioChoice: 'RadioChoice', Crypto: { randomUUID: () => 'bill-id' }, StyleSheet: { create: (value: any) => value }, Keyboard: { dismiss() {} }, useWindowDimensions: () => ({ height: 667 }), useSafeAreaInsets: () => ({ top: 20, bottom: 0 }), Platform: { OS: 'native' }, requestAnimationFrame: (fn: () => void) => fn(), useUI: () => ({ ui: {} }), formatMoney, integer, rupeesToPaise, validateExpense, ...extra,
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
