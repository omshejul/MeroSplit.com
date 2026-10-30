import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { withSharedUI } from './componentHarness.ts';
import { DEFAULT_CURRENCY, setDefaultCurrency } from '../src/currency.ts';
import { formatMoney } from '../src/accounting.ts';

type Node = { type: any; props: Record<string, any>; children: any[] };
const nodes = (value: any): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
const text = (value: any): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('') : value?.children ? text(value.children) : '';
function fixture(extra: Record<string, any> = {}) {
  const events: any[] = [];
  const env = withSharedUI({ React: { Fragment: 'Fragment', createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) },
    StyleSheet: { hairlineWidth: 0.5 }, Platform: { OS: 'android', Version: 37 }, useUI: () => ({ ui: { row: {}, rowBody: {}, rowTitle: {}, amount: {}, body: {}, caption: {}, numeric: {}, notice: {}, warning: {}, input: {} }, palette: { line: '#ddd', soft: '#eee', accent: '#111', outline: '#888' }, dark: false }),
    Button: 'Button', View: 'View', Text: 'Text', Avatar: 'Avatar', AmountText: 'AmountText', Icon: 'Icon', RadioChoice: 'RadioChoice', Dialog: { Title: 'Title', Actions: 'Actions' }, KeyboardDialog: 'KeyboardDialog', LoadingSpinner: 'LoadingSpinner', Menu: 'Menu',
    Alert: { alert: (...args: any[]) => events.push(args) }, useHomeTabSwipe: (...args: any[]) => ({ swipe: args }), Animated: { View: 'AnimatedView' }, AppTabs: 'AppTabs',
    require: (name: string) => { events.push(name); return name === 'react-native-screens/experimental' ? { SafeAreaView: 'NativeSafeAreaView' } : name; }, ...extra });
  return { env, events, render: (name: string, props: any = {}) => env[name](props), find: (tree: any, predicate: (node: Node) => boolean) => nodes(tree).find(predicate)! };
}

test('ListRow renders the same content with or without an action and forwards interaction/ref contracts', () => {
  const f = fixture(); let clicked = 0; const ref = { current: null };
  const props = { ref, leading: 'Leading', trailing: 'Trailing', children: 'Name', accessibilityLabel: 'Open name', disabled: true, onPress: () => clicked++ };
  const button = f.render('ListRow', props); assert.equal(button.type, 'Button'); assert.equal(button.props.ref, ref); assert.equal(button.props.disabled, true); assert.equal(button.props.accessibilityLabel, 'Open name');
  assert.equal(text(button), 'LeadingNameTrailing'); button.props.onPress(); assert.equal(clicked, 1);
  const row = f.render('ListRow', { ...props, onPress: undefined }); assert.equal(row.type, 'View'); assert.equal(row.props.ref, ref); assert.equal(text(row), text(button));
});

test('PersonRow retains photo identity, custom title, subtitle and trailing action', () => {
  const f = fixture(), photo = { id: 'photo' }; const tree = f.render('PersonRow', { name: 'Asha', title: 'Asha (you)', photo, children: 'Organizer', trailing: 'Manage' });
  assert.equal(f.find(tree, n => n.type === 'Avatar').props.photo, photo); assert.equal(text(tree), 'Asha (you)OrganizerManage');
  assert.equal(nodes(f.render('PersonRow', { name: 'Asha', avatar: false })).some(n => n.type === 'Avatar'), false);
});

test('PersonChoice exposes checked/disabled amount labels and preserves native radio controls for single selection', () => {
  for (const role of ['checkbox', 'radio']) {
    const f = fixture(); let selected = 0;
    const row = f.render('PersonChoice', { person: { id: 'a', name: 'Asha' }, title: 'Asha', selected: true, disabled: true, amount: '₹0.00', role, onPress: () => selected++ });
    assert.equal(row.props.disabled, true);
    if (role === 'checkbox') { assert.equal(row.props.accessibilityRole, role); assert.equal(row.props.accessibilityState.checked, true); assert.equal(row.props.accessibilityLabel, 'Asha, ₹0.00'); }
    else { assert.equal(row.type, 'RadioChoice'); assert.equal(row.props.value, 'a'); assert.equal(row.props.selected, true); }
    row.props.onPress(); assert.equal(selected, 1);
  }
});

test('PersonSelectionList keeps stable IDs and labels through selection, including duplicate display names', () => {
  const f = fixture(), picked: string[] = [];
  const tree = f.render('PersonSelectionList', { people: [{ id: 'a', name: 'Sam' }, { id: 'b', name: 'Sam' }], selected: 'b', disabled: false, label: (p: any) => `${p.name} ${p.id}`, onSelect: (id: string) => picked.push(id) });
  const rows = nodes(tree).filter(n => n.type === 'RadioChoice'); assert.deepEqual(rows.map(r => [r.props.value, r.props.selected]), [['a', false], ['b', true]]); rows[0].props.onPress(); assert.deepEqual(picked, ['a']);
});

test('PersonAmountRow preserves zero, negative and currency amounts, or a supplied balance description', () => {
  const f = fixture();
  for (const amount of ['0', '-1', '1001']) { const tree = f.render('PersonAmountRow', { name: 'Asha', amount }); assert.equal(f.find(tree, n => n.type === 'AmountText').props.amount, amount); }
  const label = f.render('PersonAmountRow', { name: 'Asha', amountLabel: 'Settled', avatar: false }); assert.equal(text(label), 'AshaSettled');
  try { setDefaultCurrency('USD'); assert.equal(formatMoney('1001'), '$10.01'); setDefaultCurrency('INR'); assert.equal(formatMoney('1001'), '₹10.01'); } finally { setDefaultCurrency(DEFAULT_CURRENCY); }
});

test('ChoiceGroup retains group name, selected value, note and disabled option controls', () => {
  const f = fixture(), choices: string[] = []; const tree = f.render('ChoiceGroup', { label: 'Currency', group: 'currency', note: 'Symbols only', options: [{ value: 'INR', label: 'Rupees' }, { value: 'USD', label: 'Dollars' }], selected: 'USD', disabled: true, onChoose: (v: string) => choices.push(v) });
  assert.equal(tree.props.role, 'radiogroup'); assert.equal(tree.props['aria-label'], 'Currency'); const radios = nodes(tree).filter(n => n.type === 'RadioChoice'); assert.deepEqual(radios.map(n => [n.props.group, n.props.selected, n.props.disabled]), [['currency', false, true], ['currency', true, true]]); radios[0].props.onPress(); assert.deepEqual(choices, ['INR']); assert.ok(text(tree).includes('Symbols only'));
});

test('FieldDialog guards dismissal while saving and keeps valid actions outside the scroll body', () => {
  const f = fixture(); let closed = 0, saved = 0; const base = { title: 'Name', visible: true, disabled: false, canSave: true, onClose: () => closed++, onSave: () => saved++, children: 'Input', error: 'Could not save' };
  const tree = f.render('FieldDialog', base); assert.equal(tree.props.visible, true); tree.props.onDismiss(); assert.equal(closed, 1);
  const save = f.find(tree, n => n.props.title === 'Save'); assert.equal(save.props.disabled, false); save.props.onPress(); assert.equal(saved, 1);
  assert.equal(nodes(f.find(tree, n => n.type === 'DialogScrollBody')).some(n => n.props.title === 'Save'), false);
  const busy = f.render('FieldDialog', { ...base, disabled: true }); busy.props.onDismiss(); assert.equal(closed, 1); assert.equal(busy.props.dismissable, false);
  assert.equal(f.find(f.render('FieldDialog', { ...base, canSave: false }), n => n.props.title === 'Save').props.disabled, true);
});

test('NoticeBanner keeps its message, tone and announcement role without another container', () => {
  const f = fixture(); for (const tone of ['success', 'warning', 'error']) { const tree = f.render('NoticeBanner', { tone, children: 'Retained message' }); assert.equal(tree.type, 'Text'); assert.equal(text(tree), 'Retained message'); assert.equal(tree.props.accessibilityRole, tone === 'error' ? 'alert' : undefined); }
});

test('ErrorState renders one explicit retry, preserves disabled state and supports errors without retry', () => {
  const f = fixture(); let retried = 0; const tree = f.render('ErrorState', { error: 'Offline', onRetry: () => retried++, retryLabel: 'Refresh', retryAccessibilityLabel: 'Refresh photo', disabled: true });
  const retry = f.find(tree, n => n.type === 'Button'); assert.equal(retry.props.title, 'Refresh'); assert.equal(retry.props.accessibilityLabel, 'Refresh photo'); assert.equal(retry.props.disabled, true); assert.equal(retried, 0); retry.props.onPress(); assert.equal(retried, 1);
  assert.equal(nodes(f.render('ErrorState', { error: 'Unavailable' })).some(n => n.type === 'Button'), false);
});

test('EmptyState preserves illustration and message; LoadingState exposes a spinner only when requested', () => {
  const f = fixture(); const empty = f.render('EmptyState', { message: 'No bills', illustration: 'Mascot' }); assert.equal(text(empty), 'MascotNo bills');
  const plain = f.render('LoadingState', { label: 'Loading files…' }); assert.equal(text(plain), 'Loading files…'); assert.equal(nodes(plain).some(n => n.type === 'LoadingSpinner'), false);
  assert.equal(f.find(f.render('LoadingState', { label: 'Opening', spinner: true }), n => n.type === 'LoadingSpinner').props.label, 'Opening');
});

test('PaginationFooter never fetches on render, disables duplicate loads and offers retry only after failure', () => {
  const f = fixture(); let loads = 0, retries = 0; const paging = { canLoadMore: true, failed: false, loading: false, loadMore: () => loads++, retry: () => retries++ };
  const tree = f.render('PaginationFooter', { paging }); assert.equal(loads, 0); const load = f.find(tree, n => n.props.title === 'Load older'); load.props.onPress(); assert.equal(loads, 1);
  const waiting = f.render('PaginationFooter', { paging: { ...paging, loading: true }, loadingLabel: 'Loading…' }); assert.equal(f.find(waiting, n => n.type === 'Button').props.disabled, true);
  const failed = f.render('PaginationFooter', { paging: { ...paging, failed: true } }); assert.equal(nodes(failed).some(n => n.props.title === 'Load older'), false); f.find(failed, n => n.props.title === 'Retry').props.onPress(); assert.equal(retries, 1);
  assert.equal(nodes(f.render('PaginationFooter', { paging: { ...paging, canLoadMore: false } })).some(n => n.type === 'Button'), false);
});

test('AttachmentPicker uses files on web, Photo/Files on native, and never opens when disabled', () => {
  for (const OS of ['web', 'ios', 'android']) {
    const f = fixture({ Platform: { OS }, SettingsRow: 'SettingsRow' }), picked: boolean[] = []; const props = { disabled: false, onPick: (photo: boolean) => picked.push(photo) };
    f.render('AttachmentPicker', props).props.onPress();
    if (OS === 'web') assert.deepEqual(picked, [false]); else { const buttons = f.events[0][2]; assert.equal(buttons[0].style, 'cancel'); buttons[1].onPress(); buttons[2].onPress(); assert.deepEqual(picked, [true, false]); }
    picked.length = 0; f.render('AttachmentPicker', { ...props, disabled: true }).props.onPress(); assert.deepEqual(picked, []);
  }
});

test('AttachmentRow keeps the thumbnail, filename, metadata, open callback and independent options', () => {
  const f = fixture(); let opened = 0; const image = f.env.React.createElement('PrivateImage', { id: 'file' }); const tree = f.render('AttachmentRow', { title: 'Receipt.pdf', subtitle: 'PDF · 1 KB', label: 'Open receipt', thumbnail: image, disabled: false, onOpen: () => opened++, options: 'Remove menu' });
  assert.equal(f.find(tree, n => n.type === 'PrivateImage'), image); assert.ok(text(tree).includes('Receipt.pdfPDF · 1 KB')); f.find(tree, n => n.props.accessibilityLabel === 'Open receipt').props.onPress(); assert.equal(opened, 1); assert.ok(text(tree).endsWith('Remove menu'));
});

test('MediaPreviewFrame sizes every fallback and exposes manual retry without retrying on render', () => {
  const f = fixture(); let retried = 0; const preview = f.render('MediaPreviewFrame', { size: 48, borderRadius: 8, label: 'Preview unavailable', text: 'PDF' }); assert.equal(preview.props.style.width, 48); assert.equal(preview.props.style.borderRadius, 8); assert.equal(preview.props.accessibilityRole, 'image');
  const retry = f.render('MediaPreviewFrame', { label: 'Retry preview', text: 'Retry', onRetry: () => retried++ }); assert.equal(retried, 0); assert.equal(retry.props.accessibilityRole, 'button'); retry.props.onPress(); assert.equal(retried, 1);
});

test('OverflowMenu forwards open/dismiss/disabled state and preserves its action content', () => {
  const f = fixture(); let opened = 0, closed = 0; const tree = f.render('OverflowMenu', { open: true, label: 'Message options', disabled: true, onOpen: () => opened++, onClose: () => closed++, children: 'Report message' }); assert.equal(tree.props.visible, true); assert.equal(tree.props.anchor.props.disabled, true); tree.props.anchor.props.onPress(); tree.props.onDismiss(); assert.deepEqual([opened, closed], [1, 1]); assert.equal(text(tree), 'Report message');
});

test('ResendControls keep cooldown, pressed-action progress and alternate sign-in callbacks separate', () => {
  const f = fixture(); let sent = 0, alternate = 0, changed = 0; const base = { busy: false, resendSeconds: 5, onResend: () => sent++, onAlternative: () => alternate++, alternativeLabel: 'Use code', onChangeEmail: () => changed++ };
  assert.equal(f.find(f.render('ResendControls', base), n => n.props.title === 'Resend in 5s').props.disabled, true);
  const busy = nodes(f.render('ResendControls', { ...base, busy: true, sending: false })); assert.equal(busy.some(n => n.props.title === 'Sending…'), false);
  const ready = f.render('ResendControls', { ...base, resendSeconds: 0 }); f.find(ready, n => n.props.title === 'Resend code').props.onPress(); f.find(ready, n => n.props.title === 'Use code').props.onPress(); f.find(ready, n => n.props.title === 'Use another email').props.onPress(); assert.deepEqual([sent, alternate, changed], [1, 1, 1]);
});

test('BillSummary uses the shared amount control and retains heading, category and metadata', () => {
  const f = fixture(); const tree = f.render('BillSummary', { title: 'Dinner', amount: '1001', leading: 'Food icon', children: 'Date and people' }); assert.equal(f.find(tree, n => n.type === 'AmountText').props.amount, '1001'); assert.ok(text(tree).includes('Dinner')); assert.ok(text(tree).endsWith('Date and people'));
});

test('AppLogo uses one asset and respects the requested size without an extra accessible image', () => {
  const f = fixture({ Image: 'Image' }); const logo = f.render('AppLogo', { size: 40 }); assert.equal(logo.props.source, '../assets/brand/mark.png'); assert.equal(logo.props.style.width, 40); assert.equal(logo.props.accessible, false);
});

test('FloatingActionContainer keeps stack actions above the physical safe area and reports full height', () => {
  for (const OS of ['ios', 'android', 'web']) {
    const f = fixture({ Platform: { OS } }); let height = 0;
    const tree = f.render('FloatingActionContainer', { children: 'Add', onHeight: (value: number) => height = value });
    assert.equal(tree.type, 'BottomSafeArea'); assert.equal(tree.props.pointerEvents, 'box-none'); assert.equal(tree.props.style.position, 'absolute');
    tree.props.onLayout({ nativeEvent: { layout: { height: 80 } } }); assert.equal(height, 80);
  }
});

test('FallbackTabLayout renders only the selected screen and forwards tab selection and swipe state', () => {
  const f = fixture(); const rendered: string[] = []; const select = () => {}; const tree = f.render('FallbackTabLayout', { selected: 'Friends', busy: true, onSelect: select, render: (tab: string) => { rendered.push(tab); return 'People screen'; } }); assert.deepEqual(rendered, ['Friends']); const tabs = f.find(tree, n => n.type === 'AppTabs'); assert.equal(tabs.props.selected, 'Friends'); assert.equal(tabs.props.busy, true); assert.equal(tabs.props.onSelect, select);
});

function fields() {
  const f = fixture({ TextInput: 'TextInput', FieldLabel: 'FieldLabel', useId: () => 'field-id', StyleSheet: { create: (v: any) => v } });
  const source = ts.createSourceFile('FormFields.tsx', readFileSync(new URL('../src/FormFields.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(n => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n)).map(n => n.getText(source).replace(/^export /, '')).join('\n');
  return { ...f, actual: new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return {TextField, UPIAddressField, PersonDetailsFields};}`)(f.env) };
}

test('TextField keeps input identity/ref and can hide only its visible label inside a titled dialog', () => {
  const f = fields(), ref = { current: null }; const normal = f.actual.TextField({ label: 'Name', ref }); const input = f.find(normal, n => n.type === 'TextInput'); assert.equal(input.props.nativeID, 'field-id'); assert.equal(input.props.accessibilityLabel, 'Name'); assert.equal(input.props.ref, ref); assert.equal(nodes(normal).some(n => n.type === 'FieldLabel'), true);
  const hidden = f.actual.TextField({ label: 'Name', hideLabel: true, value: 'Draft' }); assert.equal(nodes(hidden).some(n => n.type === 'FieldLabel'), false); assert.equal(f.find(hidden, n => n.type === 'TextInput').props.value, 'Draft');
});

test('UPIAddressField centralizes keyboard/capitalization/length while preserving controlled input callbacks', () => {
  const f = fields(); const change = () => {}; const tree = f.actual.UPIAddressField({ label: 'UPI ID', value: 'asha@bank', onChangeText: change, editable: false }); assert.equal(tree.props.keyboardType, 'email-address'); assert.equal(tree.props.autoCapitalize, 'none'); assert.equal(tree.props.maxLength, 254); assert.equal(tree.props.onChangeText, change); assert.equal(tree.props.editable, false);
});

test('PersonDetailsFields preserve separate name and email values, labels, locks and callbacks', () => {
  const f = fields(), nameChanged = () => {}, emailChanged = () => {}; const tree = f.actual.PersonDetailsFields({ name: { label: 'Their name', value: 'Asha', onChangeText: nameChanged, autoFocus: true }, email: { label: 'Optional email', value: 'asha@example.invalid', onChangeText: emailChanged, editable: false } }); const children = nodes(tree); assert.equal(children.find(n => n.props.label === 'Their name')!.props.onChangeText, nameChanged); assert.equal(children.find(n => n.props.label === 'Optional email')!.props.onChangeText, emailChanged); assert.equal(children.find(n => n.props.label === 'Optional email')!.props.editable, false);
});
