import { withSharedUI } from './componentHarness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }) };
const Dialog = Object.assign(() => {}, { Title: 'Title', Content: 'Content', ScrollArea: 'ScrollArea', Actions: 'Actions' });
let windowWidth = 375;
const env = { DialogContext: { Provider: 'DialogProvider' }, DialogFocus: 'DialogFocus', useContext: () => ({ bodyHeight: 440 }), motionDuration: { paperScale: 0.75 }, useWindowDimensions: () => ({ width: windowWidth, height: 667 }), Platform: { OS: 'native' }, DialogScrollBody: undefined as any, CancelDialogActions: undefined as any, React, Dialog, useEffect() {}, View: 'View', TouchableRipple: 'TouchableRipple', radii: { button: 8 }, Icon: 'Icon', UPIAppIcon: 'UPIAppIcon', CopyLinkIcon: 'CopyLinkIcon', Portal: 'Portal', KeyboardAvoidingView: 'KeyboardAvoidingView', KeyboardDialog: 'KeyboardDialog', ScrollView: 'ScrollView', Button: 'Button', Field: 'Field', FeedbackNote: 'FeedbackNote', Text: 'Text', s: { field: {} }, useUI: () => ({ ui: {}, palette: { surface: '#fff', line: '#ddd' }, motion: { enabled: true } }) };
function production(file: string, name: string) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  const code = declaration.getText(source).replace(/^export (default )?/, '');
  let cursor = 0; const states: any[] = [];
  const scope = { ...env, useSafeAreaInsets: () => ({ top: 20, bottom: 0 }),
    useState: (initial: any) => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (value: any) => { states[i] = value; }]; } };
  const render = new Function('env', `with(env) { ${ts.transpile(code, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return ${name}; }`)(withSharedUI(scope));
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
    if (!visible) {
      assert.equal(elements(tree).filter(node => node.type === Dialog).length, 0, 'hidden native dialogs do not retain an opacity-zero Paper modal');
      continue;
    }
    const dialog = one(tree, Dialog);
    assert.equal(dialog.props.visible, visible); assert.equal(dialog.props.onDismiss, dismiss); assert.equal(dialog.props.dismissable, false); assert.equal(dialog.props.theme.animation.scale, visible ? 0.75 : 0, 'closing content is removed without an exit delay');
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
  assert.equal(elements(tree).filter(node => node.type === Dialog).length, 0);
  for (const [height, callerCap, expected] of [[667, 647, 615], [433, 647, 381], [375, 355, 323], [300, 647, 248], [667, 400, 400], [667, 647, 615], [10, 647, 0]]) {
    one(tree, 'KeyboardAvoidingView').props.onLayout({ nativeEvent: { layout: { height } } });
    tree = render({ ...props, visible: true, maxHeight: callerCap });
    assert.equal(one(tree, Dialog).props.style.maxHeight, expected);
    assert.equal(elements(one(tree, Dialog)).find(node => node.type === Dialog.Actions), footer);
    assert.equal(elements(body).includes(footer), false);
  }
  one(tree, 'KeyboardAvoidingView').props.onLayout({ nativeEvent: { layout: { height: 667 } } });
  tree = render({ ...props, visible: true, maxHeight: undefined });
  assert.equal(one(tree, Dialog).props.style.maxHeight, 615, 'all dialogs remain bounded by the safe viewport');
});

// Run the pinned Paper Modal function with deferred native animations. This tests
// its real mount/effect path, without claiming to reproduce the native compositor.
function paperModal() {
  const path = '../node_modules/react-native-paper/src/components/Modal.tsx';
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'Modal')!;
  let cursor = 0, changed = false;
  const slots: any[] = [], effects: (() => void)[] = [], back: (() => boolean)[] = [];
  const same = (a: unknown[], b: unknown[]) => a?.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const state = (initial: any) => {
    const i = cursor++; if (!(i in slots)) slots[i] = initial;
    return [slots[i], (value: any) => { changed ||= !Object.is(slots[i], value); slots[i] = value; }];
  };
  const hooks = { ...React, useState: state,
    useCallback(fn: Function, deps: unknown[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn: () => (() => void) | undefined, deps: unknown[]) {
      const i = cursor++; if (slots[i] && same(slots[i].deps, deps)) return;
      effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
    },
  };
  const animations: any[] = [];
  const scope = { React: hooks, DEFAULT_DURATION: 220, useInternalTheme: () => ({ animation: { scale: 0.75 } }), useLatestCallback: (fn: Function) => fn,
    useSafeAreaInsets: () => ({ top: 20, bottom: 0 }), useAnimatedValue: (value: number) => state({ value })[0],
    Animated: { View: 'Animated.View', timing: (value: any, config: any) => ({ start: (done?: Function) => animations.push({ value, config, done }) }) },
    Easing: { out: (value: unknown) => value, cubic: 'cubic' }, StyleSheet: { absoluteFill: {} }, AnimatedPressable: 'AnimatedPressable', View: 'View', Surface: 'Surface', styles: {}, BackHandler: {},
    addEventListener(_target: unknown, _event: string, fn: () => boolean) { back.push(fn); return { remove() { back.splice(back.indexOf(fn), 1); } }; },
  };
  const modal = new Function('env', `with(env) { ${ts.transpile(declaration.getText(source), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return Modal; }`)(withSharedUI(scope));
  return {
    animations, back,
    render(props: any) {
      let tree: Element | null;
      do { cursor = 0; changed = false; tree = modal(props); effects.splice(0).forEach(effect => effect()); } while (changed);
      return tree;
    },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test('first native open and reopen paint opaque before any Paper animation completes', () => {
  const render = production('KeyboardDialog.tsx', 'KeyboardDialog');
  let modal: ReturnType<typeof paperModal> | undefined, dismissed = 0;
  const props = { onDismiss: () => dismissed++, children: 'autofocused input' };
  for (const visible of [false, true, false, true]) {
    const dialog = elements(render({ ...props, visible })).find(node => node.type === Dialog);
    if (!dialog) { modal?.unmount(); if (modal) assert.equal(modal.back.length, 0); modal = undefined; continue; }
    modal ??= paperModal();
    const tree = modal.render(dialog.props);
    if (!visible) continue;
    const surface = one(tree, 'Surface');
    assert.equal(surface.props.style[0].opacity.value, 1, 'the first mounted native surface must not depend on a hidden-to-visible native animation');
    assert.equal(modal.animations.length, 0);
    assert.equal(modal.back.length, 1); modal.back[0](); assert.equal(dismissed, 1);
    one(tree, 'AnimatedPressable').props.onPress(); assert.equal(dismissed, 2);
    dismissed = 0;
  }
  modal?.unmount();
});

test('a busy native dialog still consumes Back without dismissing or enabling the backdrop', () => {
  const render = production('KeyboardDialog.tsx', 'KeyboardDialog'), modal = paperModal();
  let dismissed = 0;
  const dialog = one(render({ visible: true, dismissable: false, onDismiss: () => dismissed++ }), Dialog);
  const tree = modal.render(dialog.props);
  assert.equal(modal.back[0](), true); assert.equal(dismissed, 0);
  assert.equal(one(tree, 'AnimatedPressable').props.disabled, true);
  assert.equal(one(tree, 'AnimatedPressable').props.onPress, undefined);
  modal.unmount(); assert.equal(modal.back.length, 0);
});

test('the pinned Paper hidden-to-visible path really retains opacity zero until its native animation updates', () => {
  const modal = paperModal(), onDismiss = () => {};
  assert.equal(modal.render({ visible: false, onDismiss }), null);
  const tree = modal.render({ visible: true, onDismiss });
  assert.equal(one(tree, 'Surface').props.style[0].opacity.value, 0);
  assert.equal(modal.animations.length, 1);
  assert.equal(modal.animations[0].config.useNativeDriver, true);
  assert.equal(modal.animations[0].config.toValue, 1);
  modal.unmount();
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
    const field = elements(tree).find(node => node.type === 'EmailField' && node.props.label === 'Email (optional)')!;
    assert.equal(elements(tree).find(node => node.type === 'TextField' && node.props.label === 'Name')!.props.autoFocus, true);
    assert.equal(field.props.value, base.email); assert.equal(field.props.onChangeText, onEmail); field.props.onChangeText('edited@example.invalid');
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
    assert.equal(one(render({ ...props, visible: false }), Dialog).props.visible, false, 'web retains its existing mounted dialog/focus lifecycle');
    for (const [width, expected] of [[1440, 480], [2000, 480], [540, 480], [375, 343]]) {
      windowWidth = width; const dialog = one(render(props), Dialog);
      assert.equal(dialog.props.style.width, expected); assert.equal(dialog.props.style.alignSelf, 'center');
      assert.ok(elements(dialog).some(node => node.type === 'DialogFocus' && node.children[0] === props.children));
    }
    env.Platform.OS = 'native'; const dialog = one(render(props), Dialog);
    assert.equal(dialog.props.style.width, 343); assert.equal(dialog.props.style.alignSelf, 'center');
  } finally { env.Platform.OS = 'native'; windowWidth = 375; }
});
