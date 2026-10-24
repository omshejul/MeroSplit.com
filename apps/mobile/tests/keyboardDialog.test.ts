import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }) };
const Dialog = Object.assign(() => {}, { Title: 'Title', Content: 'Content', ScrollArea: 'ScrollArea', Actions: 'Actions' });
let windowWidth = 375;
const env = { useWindowDimensions: () => ({ width: windowWidth }), Platform: { OS: 'native' }, DialogScrollBody: undefined as any, CancelDialogActions: undefined as any, React, Dialog, useEffect() {}, View: 'View', UPIAppDirectory: 'UPIAppDirectory', TouchableRipple: 'TouchableRipple', radii: { button: 8 }, Icon: 'Icon', UPIAppIcon: 'UPIAppIcon', Portal: 'Portal', KeyboardAvoidingView: 'KeyboardAvoidingView', KeyboardDialog: 'KeyboardDialog', ScrollView: 'ScrollView', Button: 'Button', Field: 'Field', FeedbackNote: 'FeedbackNote', Text: 'Text', s: { field: {} }, useUI: () => ({ ui: {}, palette: {} }) };
function production(file: string, name: string) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  const code = declaration.getText(source).replace(/^export (default )?/, '');
  let cursor = 0; const states: any[] = [];
  const scope = { ...env, useSafeAreaInsets: () => ({ top: 20, bottom: 0 }),
    useState: (initial: any) => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (value: any) => { states[i] = value; }]; } };
  const render = new Function('env', `with(env) { ${ts.transpile(code, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return ${name}; }`)(scope);
  return (props: any) => { cursor = 0; return render(props); };
}
env.DialogScrollBody = production('DialogParts.tsx', 'DialogScrollBody');
env.CancelDialogActions = production('DialogParts.tsx', 'CancelDialogActions');

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('children' in value)) return [];
  const node = value as Element;
  if (node.type === env.DialogScrollBody || node.type === env.CancelDialogActions) return elements((node.type as Function)({ ...node.props, children: node.children }));
  return [node, ...node.children.flatMap(elements)];
}
function one(tree: unknown, type: unknown) { const matches = elements(tree).filter(node => node.type === type); assert.equal(matches.length, 1); return matches[0]; }

test('hidden dialogs retain the height-measuring ancestor and keep scrolling content separate from actions', () => {
  const render = production('KeyboardDialog.tsx', 'KeyboardDialog');
  const body = React.createElement(Dialog.ScrollArea, {}, 'editable body');
  const footer = React.createElement(Dialog.Actions, {}, 'Cancel', 'Save');
  const dismiss = () => {};
  for (const visible of [false, true, false]) {
    const tree = render({ visible, onDismiss: dismiss, dismissable: false, children: [body, footer] });
    const boundary = one(tree, 'KeyboardAvoidingView');
    assert.equal(boundary.props.behavior, 'height', 'padding does not constrain Paper’s absolute-fill modal');
    assert.equal(boundary.props.style.flex, 1);
    const dialog = one(tree, Dialog);
    assert.equal(dialog.props.visible, visible); assert.equal(dialog.props.onDismiss, dismiss); assert.equal(dialog.props.dismissable, false);
    assert.equal(dialog.props.style.flexShrink, 1); assert.equal(dialog.props.style.marginVertical, 0);
    assert.equal(elements(dialog).find(node => node.type === Dialog.ScrollArea), body);
    assert.equal(elements(dialog).find(node => node.type === Dialog.Actions), footer);
  }
});

test('opted-in dialog cards track the measured keyboard viewport, safe area, rotation and a smaller caller cap', () => {
  const render = production('KeyboardDialog.tsx', 'KeyboardDialog');
  const body = React.createElement(Dialog.ScrollArea, {}, 'Inputs retain their values');
  const footer = React.createElement(Dialog.Actions, {}, 'Done');
  const props = { visible: false, onDismiss() {}, maxHeight: 647, children: [body, footer] };
  let tree = render(props);
  assert.equal(one(tree, Dialog).props.style.maxHeight, 647, 'the first hidden layout has a window/safe-area cap');
  for (const [height, callerCap, expected] of [[667, 647, 647], [433, 647, 413], [375, 355, 355], [300, 647, 280], [667, 400, 400], [667, 647, 647], [10, 647, 0]]) {
    one(tree, 'KeyboardAvoidingView').props.onLayout({ nativeEvent: { layout: { height } } });
    tree = render({ ...props, visible: true, maxHeight: callerCap });
    assert.equal(one(tree, Dialog).props.style.maxHeight, expected);
    assert.equal(elements(one(tree, Dialog)).find(node => node.type === Dialog.Actions), footer);
    assert.equal(elements(body).includes(footer), false);
  }
  tree = render({ ...props, maxHeight: undefined });
  assert.equal(one(tree, Dialog).props.style.maxHeight, undefined, 'non-opted-in callers retain their original layout');
});

test('Add person preserves drafts and action guards across hidden/open renders without conditionally mounting the keyboard boundary', () => {
  const render = production('MembersScreen.tsx', 'AddPersonDialog');
  let closed = 0, saved = 0, email = '';
  const onSave = () => saved++, onClose = () => closed++, onEmail = (value: string) => { email = value; };
  const base = { visible: false, disabled: false, working: false, archived: false, name: 'Noor', email: 'noor@example.invalid', onName() {}, onEmail, onClose, onSave, feedback: { section: 'add-person', text: 'Try again', error: true } };
  for (const visible of [false, true, false, true]) {
    const tree = render({ ...base, visible });
    assert.equal(tree.type, 'KeyboardDialog'); assert.equal(tree.props.visible, visible);
    const scroll = one(tree, 'ScrollView'), actions = one(tree, Dialog.Actions);
    assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled');
    assert.equal(elements(scroll).includes(actions), false, 'actions must remain outside the scrolling input body');
    const field = elements(tree).find(node => node.type === 'Field' && node.props.label === 'Email (optional)')!;
    assert.equal(field.props.value, base.email); assert.equal(field.props.onChange, onEmail); field.props.onChange('edited@example.invalid');
    const buttons = elements(actions).filter(node => node.type === 'Button');
    assert.equal(buttons[0].props.onPress, onClose); assert.equal(buttons[1].props.onPress, onSave);
  }
  assert.equal(email, 'edited@example.invalid'); assert.equal(saved, 0); assert.equal(closed, 0);
  render({ ...base, visible: true, disabled: true }).props.onDismiss(); assert.equal(closed, 0);
  render({ ...base, visible: true }).props.onDismiss(); assert.equal(closed, 1);
  for (const changed of [{ disabled: true }, { name: ' ' }, { archived: true }]) {
    const tree = render({ ...base, visible: true, ...changed });
    assert.equal(elements(tree).find(node => node.type === 'Button' && node.props.title === 'Add person')!.props.disabled, true);
  }
});

test('UPI chooser inherits the persistent boundary, dispatches the exact selected app on first handled tap, and retains Cancel', () => {
  const render = production('PaymentPanels.tsx', 'UPIAppChooser');
  const app = { id: 'gpay', name: 'Google Pay', url: 'gpay://upi/pay' };
  const chosen: unknown[] = []; let dismissed = 0;
  const props = { disabled: false, onChoose: (value: unknown) => chosen.push(value), onDismiss: () => dismissed++ };
  const hidden = render({ ...props, apps: null }); assert.equal(hidden.type, 'KeyboardDialog'); assert.equal(hidden.props.visible, false);
  const shown = render({ ...props, apps: [app] }); assert.equal(shown.type, hidden.type);
  assert.equal(one(shown, 'ScrollView').props.keyboardShouldPersistTaps, 'handled');
  const choose = elements(shown).find(node => node.type === 'Button' && node.props.title === app.name)!;
  choose.props.onPress(); assert.deepEqual(chosen, [app]); assert.equal(chosen[0], app);
  const cancel = elements(one(shown, Dialog.Actions)).find(node => node.type === 'Button')!;
  cancel.props.onPress(); assert.equal(dismissed, 1); assert.equal(chosen.length, 1);
  const busy = render({ ...props, apps: [app], disabled: true });
  assert.ok(elements(busy).filter(node => node.type === 'Button').every(node => node.props.disabled));
});


test('shared web dialog is centered and compact on desktop while retaining phone margins and native geometry', () => {
  const render = production('KeyboardDialog.tsx', 'KeyboardDialog');
  const props = { visible: true, onDismiss() {}, children: 'unchanged fields' };
  try {
    env.Platform.OS = 'web';
    for (const [width, expected] of [[1440, 520], [2000, 520], [540, 488], [375, 323]]) {
      windowWidth = width; const dialog = one(render(props), Dialog);
      assert.equal(dialog.props.style.width, expected); assert.equal(dialog.props.style.alignSelf, 'center');
      assert.equal(dialog.children[0], props.children);
    }
    env.Platform.OS = 'native'; const dialog = one(render(props), Dialog);
    assert.equal(dialog.props.style.width, undefined); assert.equal(dialog.props.style.alignSelf, undefined);
  } finally { env.Platform.OS = 'native'; windowWidth = 375; }
});
