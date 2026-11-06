import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
type Element = { type: string; props: Record<string, any>; children: unknown[] };
function component() {
  const hooks: any[] = []; let position = 0, effects: (() => void)[] = [];
  let sequence: string[] = [], previousSequence: string[] | undefined;
  const hook = (kind: string) => { sequence.push(kind); return position++; };
  const navigated: string[] = [], requests: string[] = [], replies: any[] = [];
  const React = {
    createElement: (type: string, props: object, ...children: unknown[]): Element => ({ type, props, children }),
    createContext(value: unknown) { return { value }; },
    useContext(context: { value: unknown }) { hook('context'); return context.value; },
    useState(initial: unknown) { const i = hook('state'); if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (v: any) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(initial: unknown) { const i = hook('ref'); return hooks[i] ??= { current: initial }; },
    useEffect(effect: () => any, deps: any[]) { const i = hook('effect'), prior = hooks[i]; if (!prior || deps.some((d, n) => d !== prior.deps[n])) effects.push(() => { prior?.cleanup?.(); hooks[i] = { deps, cleanup: effect() }; }); },
  };
  const code = ts.transpile(readFileSync(new URL('../src/OAuthContinuation.tsx', import.meta.url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React });
  const modules: Record<string, unknown> = {
    react: { ...React, default: React }, 'react-native': { View: 'View', StyleSheet: { absoluteFill: {}, create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390, height: 640 }) }, 'react-native-paper': { Text: 'Text', Dialog: { Title: 'Title' } },
    './api': { request: async (_: unknown, path: string) => { requests.push(path); return { authorization_url: await replies.shift() }; } },
    './EmailLinkScreens': { NameOnlyForm: 'NameOnlyForm' }, './DialogFocus': 'DialogFocus', './KeyboardDialog': 'KeyboardDialog',
    './DialogParts': { Dialog: { Title: 'Title', Actions: 'Actions' }, CancelDialogActions: 'Actions', DialogScrollBody: 'Body' },
    './ui': { Button: 'Button', ErrorText: 'ErrorText', useUI: () => ({ ui: { body: {}, caption: {} } }) },
  };
  // Run the production hook so an early return cannot hide a hook-order crash.
  const loadingCode = ts.transpile(readFileSync(new URL('../src/LoadingOverlay.tsx', import.meta.url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React });
  const loading: any = {}; new Function('require', 'exports', loadingCode)((name: string) => modules[name], loading);
  modules['./LoadingOverlay'] = loading;
  const exports: any = {}; new Function('require', 'exports', 'window', 'document', code)((name: string) => { assert.ok(name in modules, name); return modules[name]; }, exports, { location: { assign: (p: string) => navigated.push(p) } }, { activeElement: null });
  return { ...exports, navigated, requests, replies, render(props: object): Element { position = 0; effects = []; sequence = []; const tree = exports.default(props); if (previousSequence) assert.deepEqual(sequence, previousSequence, 'Hook order must stay unchanged between renders'); previousSequence = sequence; return tree; }, async mount() { effects.forEach(e => e()); await tick(); } };
}
function nodes(value: unknown): Element[] { if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object' || !('children' in value)) return []; const n = value as Element; return [n, ...n.children.flatMap(nodes)]; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const consent = '/oauth/authorize?request=12345678-1234-1234-1234-123456789abc';
const props = { session: { userId: '1', token: 'session', baseUrl: 'https://example.invalid', email: 'me@example.invalid', displayName: 'Me' }, busy: false, onSaveName: async () => {}, beforeContinue: async () => {} };
const button = (tree: Element) => nodes(tree).find(n => n.type === 'Button' && n.props.title === 'Review access')!;

test('loading and dismissing a pending connection preserve production hook order', async () => { const a = component(); a.replies.push(consent); assert.equal(a.render(props), null); await a.mount(); const dialog = a.render(props); assert.equal(dialog.type, 'KeyboardDialog'); nodes(dialog).find(n => n.type === 'Actions')!.props.onCancel(); assert.equal(a.render(props), null); });
test('only the closed server-held selector is accepted', () => { const a = component(); assert.equal(a.oauthConsentPath(consent), consent); for (const v of [null, {}, '', '//evil.invalid', 'https://evil.invalid' + consent, consent + '&extra=1', consent + '#x', '/app/']) assert.equal(a.oauthConsentPath(v), null); });
test('pending access is one blocking themed dialog, never an automatic approval', async () => { const a = component(); a.replies.push(consent); a.render(props); await a.mount(); const t = a.render(props), all = nodes(t); assert.equal(t.type, 'KeyboardDialog'); assert.equal(t.props.dismissable, false); assert.equal(t.props.label, 'Review agent access'); assert.ok(all.some(n => n.type === 'Title' && n.children.includes('Review agent access'))); assert.ok(button(t)); assert.deepEqual(a.navigated, []); });
test('name onboarding stays inside the same dialog before review', async () => { const a = component(), p = { ...props, session: { ...props.session, displayName: '' } }; a.replies.push(consent); a.render(p); await a.mount(); const t = a.render(p); assert.equal(t.type, 'KeyboardDialog'); assert.equal(nodes(t).find(n => n.type === 'NameOnlyForm')!.props.autoFocus, false); assert.equal(button(t), undefined); assert.equal(nodes(t).find(n => n.type === 'Actions')!.props.disabled, false); assert.equal(nodes(t).find(n => n.type === 'Actions')!.props.cancelTitle, 'Not now'); });
test('review flushes drafts and rechecks the exact pending request', async () => { const a = component(); a.replies.push(consent, consent); let release!: () => void; const p = { ...props, beforeContinue: () => new Promise<void>(r => { release = r; }) }; a.render(p); await a.mount(); button(a.render(p)).props.onPress(); assert.deepEqual(a.navigated, []); release(); await tick(); assert.deepEqual(a.navigated, [consent]); assert.equal(a.requests.length, 2); });
test('expired, unsafe or different valid pending requests cannot replace confirmed review', async () => { for (const next of [null, 'https://evil.invalid', consent.replace('12345678', '87654321')]) { const a = component(); a.replies.push(consent, next); a.render(props); await a.mount(); button(a.render(props)).props.onPress(); await tick(); assert.deepEqual(a.navigated, []); assert.ok(nodes(a.render(props)).some(n => n.type === 'ErrorText')); } });
test('busy and rapid duplicate presses cannot start navigation twice', async () => { const a = component(); a.replies.push(consent, consent); a.render(props); await a.mount(); const press = button(a.render(props)).props.onPress; press(); press(); await tick(); assert.equal(a.requests.length, 2); assert.equal(a.navigated.length, 1); const busy = component(); busy.replies.push(consent); const p = { ...props, busy: true }; busy.render(p); await busy.mount(); const b = button(busy.render(p)); assert.equal(b.props.disabled, true); b.props.onPress(); await tick(); assert.equal(busy.requests.length, 1); });
test('account changes fence late pending and review responses', async () => { const a = component(); let release!: (v: string) => void; a.replies.push(new Promise<string>(r => { release = r; })); a.render(props); await a.mount(); const p = { ...props, session: { ...props.session, userId: '2', token: 'new', email: 'other@example.invalid' } }; a.replies.push(null); assert.equal(a.render(p), null); await a.mount(); release(consent); await tick(); assert.equal(a.render(p), null); assert.deepEqual(a.navigated, []); });
test('Not now and Escape dismiss locally without denying, granting or navigating', async () => { const a = component(); a.replies.push(consent); a.render(props); await a.mount(); const t = a.render(props), dismiss = nodes(t).find(n => n.type === 'Actions')!.props.onCancel; dismiss(); assert.equal(a.render(props), null); assert.equal(a.requests.length, 1); assert.deepEqual(a.navigated, []); const b = component(); b.replies.push(consent); b.render(props); await b.mount(); b.render(props).props.onDismiss(); assert.equal(b.render(props), null); });
test('App mounts one web-only continuation outside the Groups/home content', () => { const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'); assert.equal((app.match(/<OAuthContinuation\b/g) ?? []).length, 1); assert.ok(!app.slice(app.indexOf('const homeContext'), app.indexOf('const homeContext') + 450).includes('<OAuthContinuation')); assert.match(app, /Platform\.OS === 'web'.*<OAuthContinuation/); });

test('switching account while review is in flight cannot navigate the old selector', async () => { const a = component(); let release!: (v: string) => void; a.replies.push(consent, new Promise<string>(r => { release = r; })); a.render(props); await a.mount(); button(a.render(props)).props.onPress(); await tick(); const p = { ...props, session: { ...props.session, userId: '2', token: 'new', email: 'other@example.invalid' } }; a.replies.push(consent); a.render(p); await a.mount(); release(consent); await tick(); assert.deepEqual(a.navigated, []); assert.ok(button(a.render(p))); });
