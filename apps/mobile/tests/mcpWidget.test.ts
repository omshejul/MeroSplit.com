import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../api/ledger/templates/ledger/mcp_group.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'test executes the actual shipped widget script');
const groupId = 'a1111111-1111-4111-8111-111111111111';
const hostOrigin = 'https://synthetic-host.example.invalid';
type Message = { jsonrpc: string; id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };

class Element {
  textContent = '';
  children: Element[] = [];
  disabled = false;
  onclick?: () => void;
  set innerHTML(_value: string) { throw Error('Ledger text must never use HTML parsing'); }
  replaceChildren(...children: Element[]) { this.children = children; }
  click() { if (!this.disabled) this.onclick?.(); }
}

function widget() {
  const elements = new Map(['title', 'status', 'balances', 'items', 'refresh', 'open'].map(id => [id, new Element()]));
  elements.get('title')!.textContent = 'MeroSplit group';
  elements.get('status')!.textContent = 'Waiting for an authorized group.';
  elements.get('refresh')!.disabled = elements.get('open')!.disabled = true;
  const sent: { message: Message; origin: string }[] = [];
  const tags: string[] = [];
  const parent = { postMessage(message: Message, origin: string) {
    sent.push({ message: JSON.parse(JSON.stringify(message)), origin });
  } };
  let listener: (event: { source: object; origin: string; data: Message }) => void;
  const forbidden = () => { throw Error('The widget must use only the host bridge'); };
  const document = {
    getElementById(id: string) { assert.ok(elements.has(id), 'only existing widget elements'); return elements.get(id)!; },
    createElement(tag: string) { tags.push(tag); return new Element(); },
    get cookie() { return forbidden(); }
  };
  const window = {
    parent,
    addEventListener(name: string, callback: typeof listener) { assert.equal(name, 'message'); listener = callback; },
    get localStorage() { return forbidden(); },
    get sessionStorage() { return forbidden(); },
    get location() { return forbidden(); }
  };
  runInNewContext(script!, { window, document, fetch: forbidden }, { timeout: 1000, filename: 'mcp_group.html' });
  function receive(data: Message, origin = hostOrigin, source: object = parent) { listener({ data, origin, source }); }
  function initialize() { receive({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } }); }
  function result(data: unknown) { receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: data } }); }
  function snapshot() { return [...elements].map(([id, element]) => [id, element.textContent, element.disabled, element.children.map(child => child.textContent)]); }
  return { elements, sent, tags, receive, initialize, result, snapshot };
}

function data() {
  return { group: { id: groupId, name: 'Synthetic home', version: 7, archived: false,
    participants: [{ id: 'self', name: 'Canonical self', is_self: true }, { id: 'other', name: 'Noor', is_self: false }, { id: 'zero', name: 'Zero' }],
    balances: { self: '100', other: '-100', zero: '0' } },
    transactions: [{ kind: 'bill', bill: { description: 'Lunch', total: '200', deleted: false } },
      { kind: 'payment', payment: { sender: 'self', recipient: 'other', amount: '50', reversed: false } }] };
}

test('real script initializes the standard bridge and binds messages to the parent source and origin', () => {
  const w = widget();
  assert.deepEqual(w.sent, [{ origin: '*', message: { jsonrpc: '2.0', id: 1, method: 'ui/initialize',
    params: { appInfo: { name: 'MeroSplit group', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' } } }]);
  const before = w.snapshot();
  w.receive({ jsonrpc: '2.0', id: 1, result: {} }, hostOrigin, {});
  w.receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: data() } }, hostOrigin, {});
  assert.deepEqual(w.snapshot(), before);
  w.initialize();
  assert.deepEqual(w.sent.at(-1), { origin: hostOrigin, message: { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} } });
  w.receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: data() } }, 'https://attacker.invalid');
  assert.deepEqual(w.snapshot(), before);
  w.result(data());
  assert.equal(w.elements.get('title')!.textContent, 'Synthetic home');
});

test('model/tool-input and text content cannot supply canonical balances or enable actions', () => {
  const w = widget();
  w.initialize();
  const before = w.snapshot();
  w.receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: data() } });
  w.receive({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: JSON.stringify(data()) }] } });
  w.receive({ jsonrpc: '2.0', id: 999, result: { structuredContent: data() } });
  assert.deepEqual(w.snapshot(), before);
  assert.equal(w.elements.get('refresh')!.disabled, true);
  w.elements.get('refresh')!.click();
  assert.equal(w.sent.length, 2);
});

test('server ledger text uses textContent, exact paise formatting and bounded rows', () => {
  const w = widget();
  w.initialize();
  const value = data();
  value.group.name = '<img src=x onerror=steal()> & "home"';
  value.group.participants[1].name = '<script>steal()</script>';
  value.transactions[0].bill!.description = '<svg onload=steal()> Lunch';
  value.transactions.push(...Array.from({ length: 40 }, () => ({ kind: 'bill', bill: { description: 'Long '.repeat(150), total: '200', deleted: true } })));
  w.result(value);
  assert.equal(w.elements.get('title')!.textContent, value.group.name);
  assert.deepEqual(w.elements.get('balances')!.children.map(node => node.textContent), [
    'You is owed ₹1.00', '<script>steal()</script> owes ₹1.00', 'Zero is settled up'
  ]);
  const items = w.elements.get('items')!.children;
  assert.equal(items.length, 25);
  assert.equal(items[0].textContent, '<svg onload=steal()> Lunch · ₹2.00');
  assert.equal(items[1].textContent, 'Payment: You paid <script>steal()</script> ₹0.50');
  assert.equal(items[2].textContent.length, 500);
  assert.ok(w.tags.every(tag => tag === 'li'));
});

test('legitimate aggregate balances beyond12 digits retain exact BigInt paise', () => {
  const w = widget();
  w.initialize();
  const value = data();
  value.group.balances.self = '10000000000001';
  value.group.balances.other = '-10000000000001';
  w.result(value);
  assert.equal(w.elements.get('balances')!.children[0].textContent, 'You is owed ₹1,00,00,00,00,000.01');
  assert.equal(w.elements.get('balances')!.children[1].textContent, 'Noor owes ₹1,00,00,00,00,000.01');
});

test('refresh calls only render_group with the exact last authorized ID and matches its response', () => {
  const w = widget();
  w.initialize();
  w.result(data());
  w.elements.get('refresh')!.click();
  assert.deepEqual(w.sent.at(-1), { origin: hostOrigin, message: { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'render_group', arguments: { group_id: groupId } } } });
  assert.equal(w.elements.get('status')!.textContent, 'Refreshing…');
  const changed = data();
  changed.group.version = 8;
  w.receive({ jsonrpc: '2.0', id: 2, result: { structuredContent: changed } }, hostOrigin, {});
  assert.equal(w.elements.get('status')!.textContent, 'Refreshing…');
  w.receive({ jsonrpc: '2.0', id: 2, result: { structuredContent: changed } });
  assert.equal(w.elements.get('status')!.textContent, 'Saved group version 8');
  w.receive({ jsonrpc: '2.0', id: 2, result: { structuredContent: data() } });
  assert.equal(w.elements.get('status')!.textContent, 'Saved group version 8');
  w.elements.get('refresh')!.click();
  w.receive({ jsonrpc: '2.0', id: 3, result: { isError: true, structuredContent: data() } });
  assert.equal(w.elements.get('status')!.textContent, 'Could not refresh. Reconnect MeroSplit if access changed.');
});

test('bridge emits no bearer/contact/full-ledger payload and only opens the fixed canonical app', () => {
  const w = widget();
  w.initialize();
  const value = { ...data(), access_token: 'synthetic-do-not-echo-token', app_url: 'https://attacker.invalid',
    arbitraryNotes: 'do-not-echo-ledger', contact_email: 'private@example.invalid' };
  w.result(value);
  w.elements.get('refresh')!.click();
  w.elements.get('open')!.click();
  assert.deepEqual(w.sent.map(entry => entry.message.method), ['ui/initialize', 'ui/notifications/initialized', 'tools/call', 'ui/open-link']);
  assert.deepEqual(w.sent.at(-1), { origin: hostOrigin, message: { jsonrpc: '2.0', id: 3, method: 'ui/open-link',
    params: { url: 'https://merosplit.omshejul.com/app/' } } });
  const outgoing = JSON.stringify(w.sent);
  for (const text of ['synthetic-do-not-echo-token', 'do-not-echo-ledger', 'private@example.invalid', 'attacker.invalid', 'balances', 'Lunch']) {
    assert.ok(!outgoing.includes(text));
  }
});
