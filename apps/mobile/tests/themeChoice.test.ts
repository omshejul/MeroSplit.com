import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { defaultColorFamily, colorFamilies, isColorFamily, isDarkOnly } from '../src/theme.ts';
import { validUPIAddress } from '../src/upi.ts';

type Element = { type: any; props: Record<string, any>; children: any[] };
const React = { Fragment: 'Fragment', createElement: (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children }) };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function source(file: string, names?: string[]) {
  const parsed = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const kept = parsed.statements.filter(node => !ts.isImportDeclaration(node) && !(ts.isExportDeclaration(node)) && (!names || ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '') || ts.isVariableStatement(node) && names?.some(name => node.getText(parsed).includes(`${name} =`))));
  return ts.transpile(kept.map(node => node.getText(parsed).replace(/^export (?:default )?/, '')).join('\n'), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
}
function hooks() {
  let cursor = 0; const states: any[] = [], effects: (() => void)[] = [], cleanups: (() => void)[] = [];
  return {
    reset: () => { cursor = 0; },
    commit: () => { effects.splice(0).forEach(fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); }); },
    unmount: () => cleanups.forEach(fn => fn()),
    env: {
      useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
      useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
      useEffect: (fn: () => any) => { const id = cursor++; if (!(id in states)) { states[id] = true; effects.push(fn); } },
      useCallback: (fn: any) => { const id = cursor++; return states[id] ??= fn; },
    },
  };
}
function savedChoice<T>(initial: T, read: () => Promise<T>, write: (value: T) => Promise<void>) {
  const h = hooks(), applied: T[] = [];
  const useSavedChoice = new Function('env', `with(env){${source('src/savedChoice.ts')};return useSavedChoice;}`)(h.env);
  const render = () => { h.reset(); return useSavedChoice(initial, read, write, (value: T) => applied.push(value)) as [T, (value: T) => Promise<void>]; };
  render(); h.commit();
  return { render, applied, unmount: h.unmount };
}

test('saved color loads after startup, and a choice made before the read finishes wins', async () => {
  const late = deferred<string>(), writes: string[] = [];
  const app = savedChoice('basic', () => late.promise, async value => { writes.push(value); });
  assert.equal(app.render()[0], 'basic', 'old installs start on Basic until storage answers');
  await app.render()[1]('rose'); late.resolve('cove'); await tick();
  assert.equal(app.render()[0], 'rose'); assert.deepEqual(writes, ['rose']); assert.deepEqual(app.applied, ['rose']);
  const ordinary = savedChoice('basic', async () => 'orchid', async () => {}); await tick();
  assert.equal(ordinary.render()[0], 'orchid');
});

test('writes stay ordered, the newest choice is shown, a failed write keeps the shown value and stops a late read', async () => {
  const first = deferred<void>(), order: string[] = [], read = deferred<string>();
  let fail = false;
  const app = savedChoice('basic', () => read.promise, async value => { order.push(`start ${value}`); if (value === 'cove') await first.promise; if (fail) throw new Error('Storage unavailable'); order.push(`done ${value}`); });
  const change = app.render()[1];
  const older = change('cove'), newer = change('orchid');
  await tick(); assert.deepEqual(order, ['start cove'], 'second write waits for the first');
  first.resolve(); await older; await newer;
  assert.deepEqual(order, ['start cove', 'done cove', 'start orchid', 'done orchid']);
  assert.equal(app.render()[0], 'orchid'); assert.deepEqual(app.applied, ['orchid']);
  fail = true; await assert.rejects(change('rose'), /Storage unavailable/); read.resolve('cove'); await tick();
  assert.equal(app.render()[0], 'orchid');
  const unmounted = deferred<string>(), gone = savedChoice('basic', () => unmounted.promise, async () => {});
  gone.unmount(); unmounted.resolve('rose'); await tick(); assert.equal(gone.render()[0], 'basic');
});

function storage(file: string, names: string[], env: Record<string, any>) {
  return new Function('env', `with(env){${source(file, names)};return { ${names.join(', ')} };}`)({ defaultColorFamily, isColorFamily, ...env });
}
test('native and browser keep color separate from the saved System, Light or Dark choice and recover unknown values', async () => {
  const secure = new Map<string, string>([['splitdumb.appearance', 'dark']]);
  const native = storage('src/native.ts', ['COLOR_FAMILY_KEY', 'savedColorFamily', 'saveColorFamily'], { SecureStore: { getItemAsync: async (key: string) => secure.get(key) ?? null, setItemAsync: async (key: string, value: string) => { secure.set(key, value); } } });
  assert.equal(await native.savedColorFamily(), 'orchid');
  await native.saveColorFamily('obsidian'); assert.equal(await native.savedColorFamily(), 'obsidian'); assert.equal(secure.get('splitdumb.appearance'), 'dark');
  secure.set('splitdumb.appearance', 'light'); await native.saveColorFamily('obsidian'); assert.equal(secure.get('splitdumb.appearance'), 'light', 'Obsidian never rewrites the saved mode');
  secure.set('splitdumb.appearance', 'dark');
  await native.saveColorFamily('cove'); assert.equal(await native.savedColorFamily(), 'cove');
  assert.equal(secure.get('splitdumb.appearance'), 'dark'); assert.equal(secure.get('splitdumb.colorFamily'), 'cove');
  await assert.rejects(native.saveColorFamily('ember'), /Choose a color/); assert.equal(secure.get('splitdumb.colorFamily'), 'cove');
  secure.set('splitdumb.colorFamily', 'corrupt'); assert.equal(await native.savedColorFamily(), 'orchid');
  const local = new Map<string, string>([['merosplit.web.appearance', 'light']]);
  let blocked = false;
  const web = storage('src/native.web.ts', ['COLOR_FAMILY_KEY', 'readPreference', 'writePreference', 'savedColorFamily', 'saveColorFamily'], { localStorage: { getItem: (key: string) => { if (blocked) throw new Error('blocked'); return local.get(key) ?? null; }, setItem: (key: string, value: string) => { if (blocked) throw new Error('blocked'); local.set(key, value); }, removeItem: (key: string) => local.delete(key) } });
  assert.equal(await web.savedColorFamily(), 'orchid');
  await web.saveColorFamily('obsidian'); assert.equal(await web.savedColorFamily(), 'obsidian'); assert.equal(local.get('merosplit.web.appearance'), 'light');
  await web.saveColorFamily('rose'); assert.equal(await web.savedColorFamily(), 'rose'); assert.equal(local.get('merosplit.web.appearance'), 'light');
  blocked = true; assert.equal(await web.savedColorFamily(), 'orchid', 'blocked site storage still opens on Orchid');
  await web.saveColorFamily('orchid');
});

test('Appearance dialog offers four colors and three modes, applies each at once and stays open until Done', async () => {
  const calls: string[] = [], focus: string[] = [];
  let states: any[] = [], cursor = 0;
  const env: Record<string, any> = { React, View: 'View', ScrollView: 'ScrollView', TextInput: 'TextInput', KeyboardDialog: 'KeyboardDialog', Dialog: { Title: 'Title', Content: 'Content', Actions: 'Actions' }, Text: 'Text', RadioChoice: 'RadioChoice', Button: 'Button', ErrorText: 'ErrorText', SettingsRow: 'SettingsRow', CancelDialogActions: 'CancelDialogActions', DialogScrollBody: 'DialogScrollBody',
    colorFamilies, isDarkOnly, validUPIAddress, Platform: { OS: 'ios' }, Keyboard: { dismiss() {} }, requestAnimationFrame: (fn: () => void) => fn(), useWindowDimensions: () => ({ height: 400 }),
    useUI: () => ({ ui: {}, inputColors: {}, appearance: 'system', colorFamily: 'cove' }),
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; }, useEffect: () => {} };
  const ProfileSettings = new Function('env', `with(env){${source('src/ProfileSettings.tsx')};return ProfileSettings;}`)(env);
  const props = { name: 'Asha', vpa: '', busy: false, onSaveName: async () => {}, onSaveUPI: async () => {}, onAppearance: async (value: string) => { calls.push(`mode ${value}`); }, onColorFamily: async (value: string) => { calls.push(`color ${value}`); } };
  // ChoiceGroup is a component; expand it like React would.
  const expand = (tree: any): any => { for (const node of nodes(tree)) node.children = node.children.map((child: any) => typeof child?.type === 'function' ? child.type(child.props) : child); return tree; };
  const render = () => { cursor = 0; return expand(ProfileSettings(props)); };
  let tree = render();
  const row = nodes(tree).find(node => node.type === 'SettingsRow' && node.props.label === 'Appearance')!;
  assert.equal(row.props.value, 'Cove · System'); row.props.rowRef.current = { focus: () => focus.push('row') }; row.props.onPress();
  tree = render();
  const dialog = nodes(tree).find(node => node.type === 'KeyboardDialog')!, body = nodes(tree).find(node => node.type === 'DialogScrollBody')!;
  assert.equal(dialog.props.maxHeight, 400, 'the card is bounded to the window, so the choices scroll on small or large-text screens');
  assert.equal(body.props.maxHeight, 440); assert.equal(nodes(body).filter(node => node.type === 'RadioChoice').length, 8);
  const actions = nodes(tree).find(node => node.type === 'Actions')!;
  assert.ok(!nodes(body).includes(actions) && nodes(actions).some(node => node.type === 'Button' && node.props.title === 'Done'), 'Done stays pinned outside the scroll body');
  const groups = nodes(tree).filter(node => node.props.role === 'radiogroup');
  assert.deepEqual(groups.map(node => node.props['aria-label']), ['Color', 'Mode']);
  const radios = nodes(tree).filter(node => node.type === 'RadioChoice');
  assert.deepEqual(radios.map(node => node.props.label), ['Basic', 'Cove', 'Orchid', 'Rose', 'Obsidian', 'System', 'Light', 'Dark']);
  assert.ok(radios.every(node => !node.props.disabled)); assert.ok(!nodes(tree).some(node => node.type === 'Text' && String(node.children).includes('always dark')));
  assert.deepEqual(radios.filter(node => node.props.selected).map(node => node.props.label), ['Cove', 'System']);
  assert.deepEqual([...new Set(radios.map(node => node.props.group))], ['color', 'mode']);
  radios.find(node => node.props.label === 'Rose')!.props.onPress(); await tick();
  tree = render(); nodes(tree).filter(node => node.type === 'RadioChoice').find(node => node.props.label === 'Dark')!.props.onPress(); await tick();
  assert.deepEqual(calls, ['color rose', 'mode dark']);
  tree = render(); assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.visible, true, 'choices do not close the dialog');
  assert.ok(!nodes(tree).some(node => node.type === 'CancelDialogActions'), 'nothing to cancel once applied');
  const done = nodes(tree).find(node => node.type === 'Button' && node.props.title === 'Done')!; done.props.onPress();
  tree = render(); assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.visible, false); assert.deepEqual(focus, ['row']);
  env.useUI = () => ({ ui: {}, inputColors: {}, appearance: 'light', colorFamily: 'basic' });
  assert.equal(nodes(render()).find(node => node.type === 'SettingsRow' && node.props.label === 'Appearance')!.props.value, 'Light', 'Basic keeps the released row text');

  // Obsidian: honest dark-only look; the saved mode stays selected but cannot change.
  calls.length = 0; env.useUI = () => ({ ui: {}, inputColors: {}, appearance: 'light', colorFamily: 'obsidian' });
  tree = render(); const obsidianRow = nodes(tree).find(node => node.type === 'SettingsRow' && node.props.label === 'Appearance')!;
  assert.equal(obsidianRow.props.value, 'Obsidian'); obsidianRow.props.onPress(); tree = render();
  const modeRadios = nodes(tree).filter(node => node.type === 'RadioChoice' && node.props.group === 'mode');
  assert.ok(modeRadios.every(node => node.props.disabled), 'Mode is unavailable while Obsidian is selected');
  assert.deepEqual(modeRadios.filter(node => node.props.selected).map(node => node.props.label), ['Light'], 'saved mode is retained for the other colors');
  assert.equal(nodes(tree).find(node => node.props.role === 'radiogroup' && node.props['aria-label'] === 'Mode')!.props['aria-disabled'], true);
  assert.ok(nodes(tree).some(node => node.type === 'Text' && node.children.includes('Obsidian is always dark. Other colors use this mode.')));
  assert.ok(nodes(tree).filter(node => node.type === 'RadioChoice' && node.props.group === 'color').every(node => !node.props.disabled));
  nodes(tree).find(node => node.type === 'RadioChoice' && node.props.label === 'Basic')!.props.onPress(); await tick();
  assert.deepEqual(calls, ['color basic'], 'leaving Obsidian writes only the color; the appearance key is untouched');
});

test('web Appearance starts on the selected color, keeps Tab inside Color, Mode and Done, and Escape restores the row', async () => {
  let states: any[] = [], cursor = 0, effects: (() => any)[] = [], deps: Record<number, any[]> = {}, active: any = null;
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const element = (name: string, group?: any) => ({ name, disabled: false, focus() { active = this; }, getAttribute: () => null, closest: () => group ?? null });
  const colorGroup = { contains: (value: any) => value?.name?.startsWith('color') }, modeGroup = { contains: (value: any) => value?.name?.startsWith('mode') };
  const color = element('color checked', colorGroup), otherColor = element('color other', colorGroup), mode = element('mode checked', modeGroup), done = element('done'), row = element('row');
  const env: Record<string, any> = { React, View: 'View', ScrollView: 'ScrollView', TextInput: 'TextInput', KeyboardDialog: 'KeyboardDialog', Dialog: { Title: 'Title', Content: 'Content', Actions: 'Actions' }, Text: 'Text', RadioChoice: 'RadioChoice', Button: 'Button', ErrorText: 'ErrorText', SettingsRow: 'SettingsRow', CancelDialogActions: 'CancelDialogActions', DialogScrollBody: 'DialogScrollBody',
    colorFamilies, isDarkOnly, validUPIAddress, Platform: { OS: 'web' }, Keyboard: { dismiss() {} }, requestAnimationFrame: (fn: () => void) => { fn(); return 1; }, cancelAnimationFrame() {}, useWindowDimensions: () => ({ height: 900 }),
    document: { get activeElement() { return active; }, addEventListener: (type: string, fn: any) => { (listeners[type] ??= []).push(fn); }, removeEventListener: (type: string, fn: any) => { listeners[type] = (listeners[type] ?? []).filter(value => value !== fn); } },
    useUI: () => ({ ui: {}, inputColors: {}, appearance: 'dark', colorFamily: 'orchid' }),
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
    useEffect: (fn: () => any, values: any[]) => { const id = cursor++; if (!deps[id] || values.some((value, i) => value !== deps[id][i])) { deps[id] = values; effects.push(fn); } } };
  const ProfileSettings = new Function('env', `with(env){${source('src/ProfileSettings.tsx')};return ProfileSettings;}`)(env);
  const cleanups: any[] = [];
  const render = () => { cursor = 0; const tree = ProfileSettings({ name: 'Asha', vpa: '', busy: false, onSaveName: async () => {}, onSaveUPI: async () => {}, onAppearance: async () => {}, onColorFamily: async () => {} }); return tree; };
  const commit = () => effects.splice(0).forEach(fn => cleanups.push(fn()));
  let tree = render(); commit();
  const appearance = nodes(tree).find(node => node.type === 'SettingsRow' && node.props.label === 'Appearance')!;
  appearance.props.rowRef.current = row; appearance.props.onPress();
  tree = render();
  const refs = nodes(tree).filter(node => node.type === 'View' && node.props.ref).map(node => node.props.ref);
  refs[0].current = { querySelector: (selector: string) => selector.includes('color') ? color : mode };
  refs[1].current = { querySelector: () => done };
  commit();
  assert.equal(active, color, 'focus starts on the selected color');
  const press = (shiftKey = false) => { const event = { key: 'Tab', shiftKey, prevented: false, preventDefault() { this.prevented = true; } }; listeners.keydown.forEach(fn => fn(event)); return event.prevented; };
  assert.equal(press(), true); assert.equal(active, mode);
  press(); assert.equal(active, done);
  press(); assert.equal(active, color, 'Tab wraps inside the dialog');
  press(true); assert.equal(active, done, 'Shift+Tab wraps backwards');
  active = otherColor; press(); assert.equal(active, mode, 'any radio in a group counts as that stop');
  active = null; press(); assert.equal(active, color, 'focus outside the dialog returns to the first stop');
  done.disabled = true; color.disabled = true; mode.disabled = true; active = null; assert.equal(press(), true); assert.equal(active, null, 'a saving dialog still holds Tab');
  done.disabled = false;
  const escape = { key: 'Escape', preventDefault() {}, stopPropagation() {} }; listeners.keydown.forEach(fn => fn(escape));
  tree = render(); commit(); cleanups.forEach(fn => typeof fn === 'function' && fn());
  assert.equal(active, row, 'Escape closes and restores the Appearance row');
  assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.visible, false);
});

function appFunction(name: string, env: Record<string, any>) {
  const parsed = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const app = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AppContent') as ts.FunctionDeclaration;
  const fn = app.body!.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  return new Function('env', `with(env){${ts.transpile(fn.getText(parsed), { target: ts.ScriptTarget.ES2022 })};return ${name};}`)(env);
}
test('background sync never drives the pull spinner; a user pull shows it until its own work settles, including rejected pulls', async () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<RefreshControl refreshing=\{false\}[^>]*onRefresh=\{pullToRefresh\}/);
  assert.doesNotMatch(app, /refreshing=\{busy\}/);
  for (const [screen, tab, kind] of [['home', 'Groups', 'sync'], ['group', 'Groups', 'sync'], ['home', 'Activity', 'activity']] as const) {
    const pulls: boolean[] = [], calls: string[] = [], work = deferred<void>();
    const env = { screen, tab, owner: 'owner', groupId: 'g', ownerRef: { current: 'owner' }, activeGroupRef: { current: 'g' }, setLedgerRevision() {}, setPulling: (value: boolean) => pulls.push(value), sync: async () => { calls.push('sync'); }, background: async (action: () => Promise<void>) => { await action(); await work.promise; }, refreshActivity: async () => { calls.push('activity'); await work.promise; } };
    appFunction('pullToRefresh', env)();
    await tick(); assert.deepEqual(pulls, [true]); assert.deepEqual(calls, [kind]);
    work.resolve(); await tick(); assert.deepEqual(pulls, [true, false]);
  }
  for (const failure of ['Please wait for the current action.', 'Offline']) {
    const pulls: boolean[] = [];
    appFunction('pullToRefresh', { screen: 'home', tab: 'Groups', owner: 'owner', groupId: 'g', ownerRef: { current: 'owner' }, activeGroupRef: { current: 'g' }, setLedgerRevision() {}, setPulling: (value: boolean) => pulls.push(value), sync: async () => {}, background: async () => { throw new Error(failure); } })();
    await tick(); assert.deepEqual(pulls, [true, false], `${failure} does not leave the spinner stuck`);
  }
});

test('header keeps one fixed trailing slot without moving back or action buttons', () => {
  const env: Record<string, any> = { React, View: 'View', Text: 'Text', ActivityIndicator: 'ActivityIndicator', IconAction: 'IconAction', useUI: () => ({ palette: { text: 'text', accent: 'accent', background: 'background' } }) };
  const header = new Function('env', `with(env){${source('src/AppNavigation.tsx', ['ScreenHeader'])};return ScreenHeader;}`)(env);
  const styles = new Function('env', `with(env){const pageWidthStyle={};const radii={};const StyleSheet={create:v=>v};${source('src/AppNavigation.tsx', ['styles'])};return styles;}`)(env);
  env.styles = styles;
  const shape = (tree: Element) => tree.children.flat().filter(Boolean).map((node: Element) => node.type === 'View' ? `area:${node.props.style === styles.titleArea}` : node.type);
  const idle = header({ title: 'Goa trip', busy: false, onBack() {}, children: React.createElement('IconAction', { name: 'add' }) });
  const busy = header({ title: 'Goa trip', busy: true, onBack() {}, children: React.createElement('IconAction', { name: 'add' }) });
  assert.deepEqual(shape(idle), shape(busy)); assert.deepEqual(shape(busy), ['IconAction', 'area:true', 'IconAction', 'area:false']);
  const working = nodes(busy).find(node => node.props.style === styles.working)!;
  assert.equal(styles.titleArea.minWidth, 0); assert.equal(styles.titleArea.overflow, 'hidden');
  assert.equal(styles.working.width, 44); assert.equal(styles.working.height, 44); assert.equal(working.props.pointerEvents, 'none');
  assert.equal(nodes(working)[1].props.accessibilityLabel, 'Working'); assert.ok(!nodes(idle).some(node => node.type === 'ActivityIndicator'));
  const activity = readFileSync(new URL('../src/ActivityScreen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(activity, /ActivityIndicator/);
});
