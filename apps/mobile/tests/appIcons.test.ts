import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { appIconFromNative, appIconLabel, appIcons, isAppIconChoice, markPaths, markTransform, nativeIconName, resolveAppIcon, themeAppIcon } from '../src/appIcons.ts';
import { colorFamilies, isColorFamily } from '../src/theme.ts';
import { buildAppIconBundles, primaryImageName } from '../scripts/generate-app-icons.ts';

const root = new URL('../', import.meta.url), brand = new URL('assets/brand/', root);
type Element = { type: any; props: Record<string, any>; children: any[] };
const React = { Fragment: 'Fragment', createElement: (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children }) };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function source(file: string, names?: string[]) {
  const parsed = ts.createSourceFile(file, readFileSync(new URL(file, root), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const kept = parsed.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isTypeAliasDeclaration(node) && (!names || (ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')) || (ts.isVariableStatement(node) && names.some(name => node.getText(parsed).includes(`${name} =`)))));
  return ts.transpile(kept.map(node => node.getText(parsed).replace(/^export (?:default )?/, '')).join('\n'), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
}
const load = (file: string, names: string[], env: Record<string, any>) => new Function('env', `with(env){${source(file, names.length ? names : undefined)};return { ${names.join(', ')} };}`)(env);

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(at => { const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test('every Appearance color has an icon; Basic keeps the primary icon and no choice is ambiguous', () => {
  assert.deepEqual(Object.keys(themeAppIcon).sort(), colorFamilies.map(family => family.value).sort());
  assert.equal(themeAppIcon.basic, 'default');
  for (const family of colorFamilies) {
    assert.equal(resolveAppIcon('match', family.value), themeAppIcon[family.value]);
    assert.equal(resolveAppIcon('cobalt', family.value), 'cobalt', 'a picked icon ignores the color');
    if (family.value !== 'basic') assert.equal(appIconLabel(themeAppIcon[family.value]), family.label, 'theme icons share the color name');
  }
  assert.equal(new Set(appIcons.map(icon => icon.id)).size, appIcons.length);
  assert.equal(appIcons[0].id, 'default');
  assert.ok(isAppIconChoice('match') && isAppIconChoice('rose') && !isAppIconChoice('ember') && !isAppIconChoice(null));
  assert.ok(!isColorFamily('match'), 'Match color never collides with a color name');
  assert.equal(nativeIconName('default'), null);
  assert.equal(nativeIconName('ultraviolet'), 'AppIconUltraviolet');
  for (const icon of appIcons) assert.equal(appIconFromNative(nativeIconName(icon.id)), icon.id);
  assert.equal(appIconFromNative('AppIconUnknown'), null);
});

test('in grayscale the ground and both halves of every icon stay distinct', () => {
  for (const icon of appIcons) {
    const [ground, left, right] = [icon.ground, icon.left, icon.right].map(luminance);
    for (const [a, b, pair] of [[left, right, 'halves'], [ground, left, 'ground and left'], [ground, right, 'ground and right']] as const) {
      assert.ok(Math.abs(a - b) >= 0.15, `${icon.label}: ${pair} differ by only ${Math.abs(a - b).toFixed(2)} in lightness`);
    }
  }
});

test('committed Icon Composer bundles match the primary icon and the icon list exactly', () => {
  const primaryJson = readFileSync(new URL('merosplit.icon/icon.json', brand), 'utf8');
  const primarySvg = readFileSync(new URL(`merosplit.icon/Assets/${primaryImageName(primaryJson)}`, brand), 'utf8');
  const expected = buildAppIconBundles(primaryJson, primarySvg);
  const folder = new URL('app-icons/', brand);
  const committed = readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name !== '.DS_Store')
    .map(entry => path.relative(path.join(new URL(folder).pathname), path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
  assert.deepEqual(committed, Object.keys(expected).sort(), 'run pnpm icons:generate after changing src/appIcons.ts or the primary icon');
  for (const [file, content] of Object.entries(expected)) assert.equal(readFileSync(new URL(file, folder), 'utf8'), content, `${file} is stale; run pnpm icons:generate`);
  assert.deepEqual(Object.keys(expected).filter(file => file.endsWith('/icon.json')).map(file => file.split('.icon/')[0]), appIcons.slice(1).map(icon => nativeIconName(icon.id)));
  const cove = JSON.parse(expected['AppIconCove.icon/icon.json']), primary = JSON.parse(primaryJson);
  assert.deepEqual(cove.groups, primary.groups, 'alternates keep the primary layers, scale and glass');
  assert.deepEqual(cove.fill, { 'automatic-gradient': 'srgb:0.00000,0.40784,0.47843,1.00000' });
  assert.match(expected['AppIconCove.icon/Assets/merosplit-logo.svg'], /fill="#6ccfe0"[\s\S]*fill="#eaf4f5"/);
  assert.throws(() => buildAppIconBundles(primaryJson, primarySvg.replace('#ffb21e', '#000000')), /exactly one half/);
});

test('preview mark uses the same geometry as the brand SVG', () => {
  const svg = readFileSync(new URL('merosplit-logo.svg', brand), 'utf8').replace(/\s+/g, ' ');
  assert.ok(svg.includes('d="m 40,0 a 40,40 0 0 0 0,80 V 61 a 21,21 0 0 1 0,-42 z"'), 'left half: radius 40 ring, 19 thick, centred on (40, 40)');
  assert.ok(svg.includes('d="m 49,16 a 40,40 0 0 1 0,80 V 77 a 21,21 0 0 0 0,-42 z"'), 'right half: same ring moved 9 right and 16 down');
  assert.equal(markPaths.left, 'M40 0A40 40 0 0 0 40 80V61A21 21 0 0 1 40 19Z');
  assert.equal(markPaths.right, 'M49 16A40 40 0 0 1 49 96V77A21 21 0 0 0 49 35Z');
  assert.match(markTransform, /translate\(-44\.5 -48\)$/, 'centred on the 89 x 96 mark box');
});

test('iOS plugin copies every alternate beside the primary icon, lists them once, and is safe to rerun', async () => {
  const added: string[] = [], dangerous: ((config: any) => Promise<any>)[] = [];
  const builds = [['debug', { buildSettings: { ASSETCATALOG_COMPILER_APPICON_NAME: 'merosplit' } }], ['release', { buildSettings: {} }], ['broken', null]];
  const stub = {
    withDangerousMod: (config: any, [platform, action]: [string, any]) => { assert.equal(platform, 'ios'); dangerous.push(action); return config; },
    withXcodeProject: (config: any, action: (config: any) => any) => action(config),
    IOSConfig: {
      XcodeUtils: {
        addResourceFileToGroup: ({ filepath, groupName, isBuildFile }: any) => { assert.equal(groupName, 'MeroSplit'); assert.equal(isBuildFile, true); if (!added.includes(filepath)) added.push(filepath); },
        getBuildConfigurationsForListId: (_project: unknown, list: string) => { assert.equal(list, 'list-id'); return builds; },
      },
      Target: { findNativeTargetByName: (_project: unknown, name: string) => { assert.equal(name, 'MeroSplit'); return ['target-id', { buildConfigurationList: 'list-id' }]; } },
    },
  };
  const realRequire = createRequire(import.meta.url), module = { exports: null as any };
  vm.runInNewContext(readFileSync(new URL('plugins/with-app-icons.cjs', root), 'utf8'), { module, require: (name: string) => name === 'expo/config-plugins' ? stub : realRequire(name) });
  const ios = mkdtempSync(path.join(tmpdir(), 'merosplit-ios-'));
  try {
    const run = async () => {
      const config = module.exports({ modRequest: { projectRoot: new URL(root).pathname, platformProjectRoot: ios, projectName: 'MeroSplit' }, modResults: {} });
      for (const action of dangerous.splice(0)) await action(config);
    };
    await run(); await run();
    const names = appIcons.slice(1).map(icon => nativeIconName(icon.id)!).sort();
    assert.deepEqual(added, names.map(name => `MeroSplit/${name}.icon`));
    for (const name of names) {
      assert.ok(existsSync(path.join(ios, 'MeroSplit', `${name}.icon`, 'icon.json')));
      assert.ok(existsSync(path.join(ios, 'MeroSplit', `${name}.icon`, 'Assets', 'merosplit-logo.svg')));
    }
    assert.equal((builds[0][1] as any).buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES, `"${names.join(' ')}"`);
    assert.equal((builds[1][1] as any).buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES, `"${names.join(' ')}"`);
    assert.equal((builds[0][1] as any).buildSettings.ASSETCATALOG_COMPILER_APPICON_NAME, 'merosplit', 'the primary .icon stays the app icon');
  } finally { rmSync(ios, { recursive: true, force: true }); }
  const appJson = JSON.parse(readFileSync(new URL('app.json', root), 'utf8'));
  assert.ok(appJson.expo.plugins.includes('./plugins/with-app-icons.cjs'));
  assert.equal(appJson.expo.ios.icon, './assets/brand/merosplit.icon');
});

test('a saved icon choice survives restarts, defaults to Match color and rejects unknown values', async () => {
  const secure = new Map<string, string>();
  const native = load('src/native.ts', ['APP_ICON_KEY', 'savedAppIcon', 'saveAppIcon'], { isAppIconChoice, SecureStore: { getItemAsync: async (key: string) => secure.get(key) ?? null, setItemAsync: async (key: string, value: string) => { secure.set(key, value); } } });
  assert.equal(await native.savedAppIcon(), 'match');
  await native.saveAppIcon('peacock'); assert.equal(await native.savedAppIcon(), 'peacock'); assert.equal(secure.get('splitdumb.appIcon'), 'peacock');
  await assert.rejects(native.saveAppIcon('ember'), /Choose an app icon/); assert.equal(secure.get('splitdumb.appIcon'), 'peacock');
  secure.set('splitdumb.appIcon', 'corrupt'); assert.equal(await native.savedAppIcon(), 'match');
  const web = load('src/native.web.ts', ['savedAppIcon', 'saveAppIcon'], {});
  await web.saveAppIcon('rose'); assert.equal(await web.savedAppIcon(), 'match', 'browsers have no app icon');
});

function bridge(os: string, module: any, saved = 'match') {
  return new Function('env', `with(env){${source('src/appIcon.ts')};return { availableAppIcons, shownAppIcon, applyAppIcon, syncAppIcon };}`)({
    Platform: { OS: os }, requireOptionalNativeModule: (name: string) => { assert.equal(name, 'MeroSplitAppIcon'); return module; },
    appIconFromNative, appIcons, nativeIconName, resolveAppIcon, savedAppIcon: async () => saved,
  });
}
function fakeNative(available: string[], shown: string | null = null) {
  const calls: (string | null)[] = [];
  let current = shown;
  return { calls, get current() { return current; }, module: {
    getAvailableIcons: async () => available,
    getIconName: async () => current,
    setIconName: async (name: string | null) => { calls.push(name); await tick(); current = name; },
  } };
}

test('the native bridge lists only icons in this build, changes the icon only when it differs, and queues changes', async () => {
  const all = appIcons.slice(1).map(icon => nativeIconName(icon.id)!);
  const ios = fakeNative(['AppIconCove', 'AppIconRose']), app = bridge('ios', ios.module);
  assert.deepEqual(await app.availableAppIcons(), ['default', 'cove', 'rose'], 'an older build without newer icons hides them');
  assert.equal(await app.shownAppIcon(), 'default');
  await app.applyAppIcon('match', 'basic'); assert.deepEqual(ios.calls, [], 'already showing the primary icon: no alert');
  await app.applyAppIcon('match', 'cove'); assert.deepEqual(ios.calls, ['AppIconCove']);
  await app.applyAppIcon('cove', 'rose'); assert.deepEqual(ios.calls, ['AppIconCove'], 'a picked icon that is already shown is left alone');
  await Promise.all([app.applyAppIcon('rose', 'basic'), app.applyAppIcon('default', 'basic')]);
  assert.deepEqual(ios.calls, ['AppIconCove', 'AppIconRose', null], 'changes run one at a time in order'); assert.equal(ios.current, null);

  const none = fakeNative([]), unsupported = bridge('ios', none.module);
  assert.deepEqual(await unsupported.availableAppIcons(), [], 'no alternates or no device support hides the row');
  await unsupported.syncAppIcon('rose'); assert.deepEqual(none.calls, []);
  for (const os of ['android', 'web']) {
    const other = bridge(os, fakeNative(all).module);
    assert.deepEqual(await other.availableAppIcons(), []); assert.equal(await other.shownAppIcon(), null);
    await other.applyAppIcon('rose', 'rose'); await other.syncAppIcon('rose');
  }
  const missing = bridge('ios', null);
  assert.deepEqual(await missing.availableAppIcons(), [], 'builds made before the module shipped');
});

test('closing Appearance moves a Match color icon to the new color but never overrides a picked icon', async () => {
  const all = appIcons.slice(1).map(icon => nativeIconName(icon.id)!);
  const matching = fakeNative(all), follow = bridge('ios', matching.module, 'match');
  await follow.syncAppIcon('orchid'); await follow.syncAppIcon('obsidian'); await follow.syncAppIcon('basic');
  assert.deepEqual(matching.calls, ['AppIconOrchid', 'AppIconObsidian', null]);
  const picked = fakeNative(all, 'AppIconCobalt'), fixed = bridge('ios', picked.module, 'cobalt');
  await fixed.syncAppIcon('rose'); assert.deepEqual(picked.calls, []); assert.equal(picked.current, 'AppIconCobalt');
});

function picker(options: { available?: string[]; colorFamily?: string; save?: () => Promise<void>; apply?: (choice: string, family: string) => Promise<void> } = {}) {
  let states: any[] = [], cursor = 0;
  const effects: (() => any)[] = [], saves: string[] = [], applied: string[][] = [], focus: string[] = [];
  const env: Record<string, any> = { React, View: 'View', Pressable: 'Pressable', Text: 'Text', Dialog: { Title: 'Title', Actions: 'Actions' }, Svg: 'Svg', G: 'G', Path: 'Path', Rect: 'Rect',
    DialogScrollBody: 'DialogScrollBody', RadioChoice: 'RadioChoice', KeyboardDialog: 'KeyboardDialog', SettingsRow: 'SettingsRow', Button: 'Button', ErrorText: 'ErrorText',
    appIconLabel, appIcons, markPaths, markTransform, themeAppIcon, colorFamilies, savedAppIcon: null, saveAppIcon: null,
    useUI: () => ({ ui: {}, palette: { accent: 'accent', text: 'text', line: 'line' }, colorFamily: options.colorFamily ?? 'rose' }), useWindowDimensions: () => ({ height: 700 }),
    requestAnimationFrame: (fn: () => void) => fn(),
    availableAppIcons: async () => options.available ?? appIcons.map(icon => icon.id),
    applyAppIcon: options.apply ?? (async (choice: string, family: string) => { applied.push([choice, family]); }),
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
    useEffect: (fn: () => any) => { const id = cursor++; if (!(id in states)) { states[id] = true; effects.push(fn); } },
  };
  env.useSavedChoice = (initial: string) => { const [value, set] = env.useState(initial); return [value, async (next: string) => { saves.push(next); if (options.save) await options.save(); set(next); }]; };
  const { AppIconSettings } = new Function('env', `with(env){${source('src/AppIconSettings.tsx')};return { AppIconSettings };}`)(env);
  const render = () => { cursor = 0; const tree = AppIconSettings({ busy: false }); effects.splice(0).forEach(fn => fn()); return tree; };
  return { render, saves, applied, focus };
}

test('App icon picker saves a choice at once and changes the icon only when the dialog closes', async () => {
  const app = picker();
  assert.equal(app.render(), null, 'hidden until the build reports its icons'); await tick();
  let tree = app.render();
  const row = nodes(tree).find(node => node.type === 'SettingsRow')!;
  assert.equal(row.props.label, 'App icon'); assert.equal(row.props.value, 'Match color');
  row.props.rowRef.current = { focus: () => app.focus.push('row') }; row.props.onPress();
  tree = app.render();
  assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.visible, true);
  assert.ok(nodes(tree).some(node => node.type === 'Text' && node.children.join('') === 'Follows your Appearance color. Rose uses Rose.'));
  const tiles = () => nodes(app.render()).filter(node => node.type === 'Pressable');
  assert.deepEqual(tiles().map(node => node.props.accessibilityLabel), appIcons.map(icon => `${icon.label} icon`));
  assert.ok(tiles().every(node => node.props.role === 'radio' && node.props['aria-checked'] === false));
  assert.equal(nodes(app.render()).find(node => node.type === 'RadioChoice')!.props.selected, true);

  await tiles().find(node => node.props.accessibilityLabel === 'Cobalt icon')!.props.onPress(); await tick();
  await tiles().find(node => node.props.accessibilityLabel === 'Peacock icon')!.props.onPress(); await tick();
  assert.deepEqual(app.saves, ['cobalt', 'peacock']); assert.deepEqual(app.applied, [], 'trying icons shows no iOS alert');
  tree = app.render();
  assert.equal(nodes(tree).find(node => node.type === 'SettingsRow')!.props.value, 'Peacock');
  assert.deepEqual(tiles().filter(node => node.props['aria-checked']).map(node => node.props.accessibilityLabel), ['Peacock icon']);
  assert.equal(nodes(tree).find(node => node.type === 'RadioChoice')!.props.selected, false);

  await nodes(tree).find(node => node.type === 'Button' && node.props.title === 'Done')!.props.onPress(); await tick();
  assert.deepEqual(app.applied, [['peacock', 'rose']], 'one change, made on close');
  assert.equal(nodes(app.render()).find(node => node.type === 'KeyboardDialog')!.props.visible, false); assert.deepEqual(app.focus, ['row']);

  nodes(app.render()).find(node => node.type === 'SettingsRow')!.props.onPress();
  await nodes(app.render()).find(node => node.type === 'RadioChoice')!.props.onPress(); await tick();
  await nodes(app.render()).find(node => node.type === 'KeyboardDialog')!.props.onDismiss(); await tick();
  assert.deepEqual(app.applied, [['peacock', 'rose'], ['match', 'rose']], 'tapping outside also applies the choice');
});

test('App icon picker keeps the dialog open with a clear message when iOS refuses the change', async () => {
  const unsupported = Object.assign(new Error('This device cannot change the app icon.'), { code: 'ERR_APP_ICON_UNSUPPORTED' });
  for (const [cause, message] of [[new Error('NSPOSIXErrorDomain 35'), 'Could not change the app icon. Try again.'], [unsupported, 'This device cannot change the app icon.']] as const) {
    const app = picker({ apply: async () => { throw cause; } }); app.render(); await tick();
    nodes(app.render()).find(node => node.type === 'SettingsRow')!.props.onPress();
    await nodes(app.render()).find(node => node.type === 'Button')!.props.onPress(); await tick();
    const tree = app.render();
    assert.equal(nodes(tree).find(node => node.type === 'KeyboardDialog')!.props.visible, true);
    assert.deepEqual(nodes(tree).find(node => node.type === 'ErrorText')!.children, [message]);
  }
  const limited = picker({ available: ['default', 'cove'] }); limited.render(); await tick();
  nodes(limited.render()).find(node => node.type === 'SettingsRow')!.props.onPress();
  assert.deepEqual(nodes(limited.render()).filter(node => node.type === 'Pressable').map(node => node.props.accessibilityLabel), ['Default icon', 'Cove icon']);
  const none = picker({ available: [] }); none.render(); await tick(); assert.equal(none.render(), null, 'Android, web and older builds show no App icon row');
});

test('closing immediately after a pick waits for the saved choice', async () => {
  let saved!: () => void;
  const app = picker({ save: () => new Promise(resolve => { saved = resolve; }) });
  app.render(); await tick();
  nodes(app.render()).find(node => node.type === 'SettingsRow')!.props.onPress();
  nodes(app.render()).find(node => node.props.accessibilityLabel === 'Cobalt icon')!.props.onPress();
  nodes(app.render()).find(node => node.type === 'Button' && node.props.title === 'Done')!.props.onPress();
  await tick(); assert.deepEqual(app.applied, []);
  saved(); await tick(); assert.deepEqual(app.applied, [['cobalt', 'rose']]);
});
