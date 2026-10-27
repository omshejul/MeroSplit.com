import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';

type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { Fragment: 'Fragment', createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }) };
const Mascot = () => null;
function read(file: string) { return ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function execute(code: string, env: Record<string, any>) {
  return new Function('env', `with(env) { ${ts.transpile(code, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })} }`)(env);
}
function productionFunction(file: string, name: string, env: Record<string, any>) {
  const source = read(file); let found = '';
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source).replace(/^export (default )?/, ''); ts.forEachChild(node, visit); }
  visit(source); assert.ok(found);
  return execute(`${found}; return ${name};`, { React, ...env });
}
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('children' in tree)) return [];
  const element = tree as Element; return [element, ...element.children.flatMap(elements), ...elements(element.props.ListHeaderComponent), ...elements(element.props.ListFooterComponent), ...elements(element.props.data?.length ? undefined : element.props.ListEmptyComponent)];
}
const uiEnv = { FlatList: 'FlatList', pageContentStyle: {}, useRef: () => ({ current: null }), useScrollPagination: () => ({ events: {}, loading: false, failed: false }), LoadingSpinner: 'LoadingSpinner', Mascot, Text: 'Text', ErrorText: 'ErrorText', View: 'View', ActivityIndicator: 'Spinner', Button: 'Button', GroupListRow: 'GroupListRow', ActivityRow: 'ActivityRow', styles: {}, s: {}, useUI: () => ({ ui: {}, palette: {} }) };

test('Groups and Activity decorate only verified true empty states while retaining their existing copy', () => {
  const groups = productionFunction('src/GroupList.tsx', 'GroupList', uiEnv);
  const activity = productionFunction('src/ActivityScreen.tsx', 'ActivityScreen', uiEnv);
  const base = { groups: [], commands: [], busy: false, direct: false, decorated: true, onOpen() {} };
  // Visible mascots only; an invisible Mascot keeps the footprint without an image.
  const count = (tree: unknown) => elements(tree).filter(value => value.type === Mascot && value.props.visible).length;
  const slots = (tree: unknown) => elements(tree).filter(value => value.type === Mascot).length;
  assert.equal(count(groups(base)), 0, 'cache/startup empty is not canonical emptiness');
  assert.equal(slots(groups(base)), 1, 'its footprint is reserved so the caption does not move once verified');
  const verified = groups({ ...base, emptyVerified: true }); assert.equal(count(verified), 1);
  assert.ok(elements(verified).some(value => value.type === 'Text' && value.children.includes('No groups yet')));
  for (const changed of [{ direct: true }, { busy: true }, { commands: [{ group_id: 'pending' }] }, { groups: [{ group: { id: 'existing' } }] }]) assert.equal(count(groups({ ...base, emptyVerified: true, ...changed })), 0);
  for (const changed of [{ busy: true }, { commands: [{ group_id: 'pending' }] }]) assert.equal(slots(groups({ ...base, emptyVerified: true, ...changed })), 1, 'sync and saved work keep the same caption position');
  for (const changed of [{ direct: true }, { decorated: false }]) assert.equal(slots(groups({ ...base, emptyVerified: true, ...changed })), 0, 'People and archived/removed lists keep a plain caption');
  const feed = { items: [], busy: false, onRefresh() {}, onOpen() {} };
  assert.equal(count(activity(feed)), 0);
  const suppressed = activity({ ...feed, emptyVerified: true, showEmpty: false });
  assert.ok(!elements(suppressed).some(value => value.type === 'Text' && value.children.includes('No activity yet')));
  assert.equal(slots(suppressed), 0);
  const empty = activity({ ...feed, emptyVerified: true }); assert.equal(count(empty), 1);
  assert.ok(elements(empty).some(value => value.type === 'Text' && value.children.includes('No activity yet')));
  for (const changed of [{ showEmpty: false }, { busy: true }, { error: 'Offline' }, { hasMore: true }, { items: [{ id: 'existing' }] }]) assert.equal(count(activity({ ...feed, emptyVerified: true, ...changed })), 0);
  const loading = activity({ ...feed, emptyVerified: true, busy: true });
  assert.equal(slots(loading), 1, 'refresh keeps the empty footprint'); assert.ok(elements(loading).some(value => value.type === 'Text' && value.children.includes('Loading activity…')));
});

test('App keeps the Activity empty region during refresh but claims emptiness only when verified', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /emptyVerified=\{activityEmptyVerified\} showEmpty=\{activityEmptyVerified \|\| busy\}/);
  assert.match(app, /decorated=\{!showArchived && !showHidden && !archivedGroups\.length && !hiddenGroups\.length\}/);
});

test('approved PNG is unchanged and the image is decorative, contained and absent on short screens or keyboard', () => {
  const png = readFileSync(new URL('../assets/mascot.png', import.meta.url));
  assert.equal(createHash('sha256').update(png).digest('hex'), '902e652194de3568ce94adbc782946c31c5995b51c86dbbb3f6f161735799658');
  assert.equal(png.readUInt32BE(16), 1254); assert.equal(png.readUInt32BE(20), 1254);
  for (const size of ['welcome', 'empty'] as const) {
    const render = (height: number, keyboard: boolean, children?: Element) => productionFunction('src/Mascot.tsx', 'Mascot', { Image: 'Image', View: 'View', Keyboard: { isVisible: () => keyboard }, useWindowDimensions: () => ({ height }), useState: (initial: () => boolean) => [initial(), () => {}], useEffect: () => {}, require: (path: string) => path })({ size, children });
    const image = render(800, false) as Element;
    assert.equal(image.type, 'Image'); assert.equal(image.props.resizeMode, 'contain'); assert.equal(image.props.alt, '');
    assert.equal(image.props.accessible, false); assert.equal(image.props.accessibilityElementsHidden, true);
    assert.equal(image.props.importantForAccessibility, 'no-hide-descendants'); assert.equal(image.props.focusable, false);
    assert.deepEqual(image.props.style, { width: size === 'welcome' ? 112 : 80, height: size === 'welcome' ? 112 : 80, alignSelf: 'center' });
    assert.equal(image.props.onPress, undefined); assert.equal(render(599, false), null); assert.equal(render(800, true), null);
    const caption = React.createElement('Text', { style: { color: 'caption' } }, 'No groups yet');
    const centered = elements(render(800, false, caption)).find(value => value.type === 'View');
    assert.deepEqual(centered?.props.style, { alignItems: 'center' }); assert.equal(centered?.children[0], caption);
    for (const hidden of [render(599, false, caption), render(800, true, caption)]) {
      assert.equal(elements(hidden).filter(value => value.type === 'Image' || value.type === 'View').length, 0);
      assert.equal(elements(hidden).find(value => value.type === 'Text'), caption);
    }
    const reserve = (height: number, keyboard: boolean, children?: Element) => productionFunction('src/Mascot.tsx', 'Mascot', { Image: 'Image', View: 'View', Keyboard: { isVisible: () => keyboard }, useWindowDimensions: () => ({ height }), useState: (initial: () => boolean) => [initial(), () => {}], useEffect: () => {}, require: (path: string) => path })({ size, visible: false, children });
    const slot = reserve(800, false) as Element;
    assert.equal(slot.type, 'View', 'no mascot image while not eligible'); assert.deepEqual(slot.props.style, image.props.style, 'same footprint as the image');
    assert.equal(slot.props['aria-hidden'], true); assert.equal(slot.props.accessible, false); assert.equal(slot.props.importantForAccessibility, 'no-hide-descendants');
    const reservedCaption = elements(reserve(800, false, caption));
    assert.equal(reservedCaption.filter(value => value.type === 'Image').length, 0);
    assert.deepEqual(reservedCaption.find(value => value.type === 'View' && value.children[0] === caption)?.props.style, { alignItems: 'center' }, 'caption keeps the decorated position');
    assert.equal(reserve(599, false), null); assert.equal(elements(reserve(800, true, caption)).find(value => value.type === 'Text'), caption);
  }
});

const app = read('App.tsx');
function expressionFor(name: string) {
  let expression = '';
  function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(app) === name && node.initializer) expression = node.initializer.getText(app); ts.forEachChild(node, visit); }
  visit(app); assert.ok(expression); return expression;
}
function renderCondition(env: Record<string, any>, expression: string) { return execute(`return (${expression});`, { React, Mascot, ...env }); }
test('production verified-empty eligibility excludes known offline, errors and every saved-work state', () => {
  const eligible = { online: true, isOnline: () => true, busy: false, expired: false, notice: '', commands: [], hasDrafts: false, legacy: [], recoveries: [], unavailable: [], returns: [] };
  const expression = expressionFor('mascotEligible'); assert.equal(renderCondition(eligible, expression), true);
  for (const changed of [{ online: false }, { isOnline: () => false }, { busy: true }, { expired: true }, { notice: 'Failed' }, { commands: [{}] }, { hasDrafts: true }, { legacy: [{}] }, { recoveries: [{}] }, { unavailable: [{}] }, { returns: [{}] }]) assert.equal(renderCondition({ ...eligible, ...changed }, expression), false);

});

test('production canonical refresh marker clears immediately and only verifies after successful current-owner load', async () => {
  const active = { baseUrl: 'https://example.invalid', userId: '1', token: 'session1' }, scope = 'owner1';
  let failed = false;
  let marker = 'owner1', release!: () => void;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  const env = { setVerifiedEmptyOwner: (value: string) => { marker = value; }, getDatabase: async () => ({}), accountOwner: () => scope, readProfile: async () => {}, syncOutbox: async () => {}, retryAccountMediaUploads: async () => 0, refreshGroups: async () => { if (failed) throw Error('Offline'); return []; }, load: () => loaded, ownerRef: { current: scope }, activeSessionRef: { current: active }, activeGroupRef: { current: null }, ApiError: class extends Error {} };
  const sync = productionFunction('App.tsx', 'runAccountRefresh', { ...env, authHeldRef: {current:false}, setSyncing(){}, setSyncProblem(){}, request:async()=>({needs_invitation:false}), setNeedsInvitation(){}, downloadOffline(){}, publishIfChanged:async()=>{} });
  const refreshing = sync(active); assert.equal(marker, ''); release(); await refreshing; assert.equal(marker, scope);
  failed = true;
  await assert.rejects(sync(active), /Offline/); assert.equal(marker, '');
  failed = false; env.activeSessionRef.current = { ...active, token: 'new-session' };
  await sync(active); assert.equal(marker, '', 'late prior-generation refresh cannot verify current emptiness');
});

test('an exhausted older Activity page never becomes a verified empty first page', async () => {
  let condition = '';
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'ActivityScreen') {
      const prop = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(app) === 'emptyVerified') as ts.JsxAttribute;
      assert.ok(prop?.initializer && ts.isJsxExpression(prop.initializer));
      condition = prop.initializer.expression!.getText(app);
    }
    ts.forEachChild(node, visit);
  }
  visit(app); assert.ok(condition);
  const session = { token: 'current' }, activityOwner = { current: '' };
  let displayed: Record<string, any> | null = null;
  const env = { session, browseCurrent: { current: 'scope' }, activity: { items: [], next_cursor: 'older', revision: 'current' }, perform: async (run: () => Promise<void>) => run(), setActivityError() {}, request: async () => ({ read_mode: 'activity', items: [], next_cursor: null, revision: 'current' }), activeSessionRef: { current: session }, activityOwner, accountOwner: () => 'owner', setActivity: (page: Record<string, any>) => { displayed = page; }, requestAnimationFrame() {}, ApiError: class extends Error {} };
  const refresh = productionFunction('App.tsx', 'refreshActivity', env);
  const eligible = () => {
    const scope = { mascotEligible: true, activityError: '', activity: displayed, activityOwner, owner: 'owner', session, emptyChatScope: 'owner|current' };
    return renderCondition({ ...scope, activityEmptyVerified: renderCondition(scope, expressionFor('activityEmptyVerified')) }, condition);
  };
  assert.equal(eligible(), false, 'not loaded yet');
  await refresh(true); assert.equal(eligible(), false, 'older page is empty, earlier history still exists');
  await refresh(false); assert.equal(eligible(), true, 'fresh canonical first page is empty');
  activityOwner.current = 'another-owner'; assert.equal(eligible(), false, 'previous account page is ineligible');
});


test('Activity genuine-empty verification requires the current chat session and existing financial verification', () => {
  const base = { mascotEligible: true, activityError: '', activity: { firstPage: true }, activityOwner: { current: 'owner1' }, owner: 'owner1', emptyChatScope: 'owner1|session1', session: { token: 'session1' } };
  const expression = expressionFor('activityEmptyVerified');
  assert.equal(renderCondition(base, expression), true);
  for (const changed of [{ activityError: 'Unavailable' }, { emptyChatScope: '' }, { emptyChatScope: 'owner1|oldsession' }, { emptyChatScope: 'owner2|session1' }, { mascotEligible: false }, { activity: null }, { activity: { firstPage: false } }, { activityOwner: { current: 'owner2' } }]) assert.equal(renderCondition({ ...base, ...changed }, expression), false);
});
