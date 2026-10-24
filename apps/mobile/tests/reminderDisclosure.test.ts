import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { requestEmailCode as nativeRequest } from '../src/transport.ts';
import { requestEmailCode as browserRequest } from '../src/transport.web.ts';

const base = 'https://merosplit.test', email = ' reminder-qa@example.invalid ';
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler = '';
function find(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'sendSignInCode') handler = node.getText(source);
  ts.forEachChild(node, find);
}
find(source); assert.ok(handler, 'exercise the actual production sign-in action');
const compiled = ts.transpile(handler, { target: ts.ScriptTarget.ES2022 });

for (const [platform, requestEmailCode, client] of [['native', nativeRequest, 'app'], ['browser', browserRequest, 'browser']] as const) {
  test(`${platform} App action leaves email off through its actual code/request transport`, async () => {
    const original = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document };
    Object.assign(globalThis, { window: { location: { origin: base } }, document: { cookie: 'csrftoken=synthetic-csrf' } });
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return Response.json({ data: { challenge_id: 'request-challenge', expires_in: 180, retry_after: 60 } }); };
    const state = { emailRequested: true, challenge: null as unknown, code: '1234', retryAt: 0 };
    const env = { API_URL: base, email, requestEmailCode, setEmailRequested: (value: boolean) => { state.emailRequested = value; }, setChallenge: (value: unknown) => { state.challenge = value; }, setCode: (value: string) => { state.code = value; }, setRetryAt: (value: number) => { state.retryAt = value; }, setClock: (_value: number) => {} };
    try {
      const action = new Function('env', `with (env) { ${compiled}; return sendSignInCode; }`)(env) as () => Promise<void>;
      await action();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${base}/_allauth/${client}/v1/auth/code/request`);
      assert.equal(calls[0].init.method, 'POST');
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { email: email.trim(), email_reminders_disclosed: false });
      assert.equal(new Headers(calls[0].init.headers).get('X-Session-Token'), null);
      if (platform === 'browser') { assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(new Headers(calls[0].init.headers).get('X-CSRFToken'), 'synthetic-csrf'); }
      assert.deepEqual(state.challenge, { challengeId: 'request-challenge', expiresIn: 180, retryAfter: 60 });
      assert.equal(state.emailRequested, false); assert.equal(state.code, ''); assert.ok(state.retryAt > Date.now());
    } finally { Object.assign(globalThis, original); }
  });

  test(`${platform} callers without a disclosure or with explicit false never infer consent`, async () => {
    const original = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document };
    Object.assign(globalThis, { window: { location: { origin: base } }, document: { cookie: 'csrftoken=synthetic-csrf' } });
    const bodies: unknown[] = [];
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ data: { challenge_id: 'request-challenge', expires_in: 180, retry_after: 60 } }); };
    try {
      await requestEmailCode(base, email); await requestEmailCode(base, email, false);
      assert.deepEqual(bodies, Array(2).fill({ email: email.trim(), email_reminders_disclosed: false }));
    } finally { Object.assign(globalThis, original); }
  });
}
