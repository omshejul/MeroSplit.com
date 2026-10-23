import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

type Element = { type: string; props: Record<string, any>; children: unknown[] };
function component() {
  let state: unknown[] = [], position = 0, effects: (() => void)[] = [];
  const navigated: string[] = [], requests: string[] = [];
  const replies: unknown[] = [];
  const React = {
    createElement: (type: string, props: object, ...children: unknown[]): Element => ({ type, props, children }),
    useState(initial: unknown) {
      const index = position++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value: unknown) => { state[index] = value; }];
    },
    useEffect(effect: () => void) { effects.push(effect); },
  };
  const source = readFileSync(new URL('../src/OAuthContinuation.tsx', import.meta.url), 'utf8');
  const code = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React });
  const modules: Record<string, unknown> = {
    react: { ...React, default: React }, 'react-native': { View: 'View' }, 'react-native-paper': { Text: 'Text' },
    './api': { request: async (_: unknown, path: string) => { requests.push(path); return { authorization_url: replies.shift() }; } },
    './EmailLinkScreens': { NameOnlyForm: 'NameOnlyForm' },
    './ui': { Button: 'Button', ErrorText: 'ErrorText', useUI: () => ({ ui: {} }) },
  };
  const exports: any = {};
  new Function('require', 'exports', 'window', code)(
    (name: string) => { assert.ok(name in modules, name); return modules[name]; }, exports,
    { location: { assign: (path: string) => navigated.push(path) } },
  );
  return {
    ...exports, navigated, requests, replies,
    render(props: object): Element { position = 0; effects = []; return exports.default(props); },
    async mount() { effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve)); },
    state: () => state,
  };
}
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('children' in value)) return [];
  const node = value as Element;
  return [node, ...node.children.flatMap(elements)];
}
const consent = '/oauth/authorize?request=12345678-1234-1234-1234-123456789abc';
const props = { session: { token: 'session', baseUrl: 'https://example.invalid', email: 'me@example.invalid', displayName: 'Me' }, busy: false, onSaveName: async () => {}, beforeContinue: async () => {} };

test('continuation allows only the closed server-held authorization selector', () => {
  const app = component();
  assert.equal(app.oauthConsentPath(consent), consent);
  for (const value of [null, {}, '', '//other.example/oauth/authorize', 'https://other.example' + consent,
    consent + '&redirect_uri=https://other.example', consent + '#proof=x', '/oauth/authorize?request=123', '/app/']) {
    assert.equal(app.oauthConsentPath(value), null);
  }
});

test('normal sign-in can request Name, and never grants consent or navigates automatically', async () => {
  const app = component(); app.replies.push(consent);
  const unnamed = { ...props, session: { ...props.session, displayName: '' } };
  assert.equal(app.render(unnamed), null);
  await app.mount();
  const tree = app.render(unnamed);
  const form = elements(tree).find(node => node.type === 'NameOnlyForm')!;
  assert.equal(form.props.onSave, props.onSaveName);
  assert.equal(elements(tree).some(node => node.type === 'Button'), false);
  assert.deepEqual(app.navigated, []);
});

test('explicit review waits for durable drafts, then rechecks the pending request before navigating', async () => {
  const app = component(); app.replies.push(consent, consent);
  let release!: () => void;
  const drafts = new Promise<void>(resolve => { release = resolve; });
  const input = { ...props, beforeContinue: () => drafts };
  app.render(input); await app.mount();
  const button = elements(app.render(input)).find(node => node.type === 'Button')!;
  assert.equal(button.props.title, 'Review agent access');
  button.props.onPress();
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.navigated, []);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.navigated, [consent]);
});

test('an expired or substituted request cannot redirect after the review click', async () => {
  for (const next of [null, 'https://other.example/']) {
    const app = component(); app.replies.push(consent, next);
    app.render(props); await app.mount();
    elements(app.render(props)).find(node => node.type === 'Button')!.props.onPress();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(app.navigated, []);
    assert.ok(elements(app.render(props)).some(node => node.type === 'ErrorText'));
  }
});
