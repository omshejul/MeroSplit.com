import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DEFAULT_CURRENCY, currencies, currencyCode, currencySymbol, isCurrency, setDefaultCurrency } from '../src/currency.ts';
import { formatMoney, rupeesToPaise, validateExpense } from '../src/accounting.ts';
import { buildUPIUrl } from '../src/upi.ts';

test('currency changes only display symbols, keeping exact amounts and allocations', () => {
  assert.equal(currencyCode(), 'INR');
  const before = validateExpense('1001', { a: '1001' }, { mode: 'equal', values: { a: '1', b: '1' } }, ['a','b']);
  try {
    for (const currency of currencies) {
      setDefaultCurrency(currency.value);
      assert.equal(formatMoney('1001'), `${currency.symbol}10.01`);
      assert.equal(formatMoney('-1'), `-${currency.symbol}0.01`);
      assert.equal(rupeesToPaise('10.01'), '1001');
      assert.deepEqual(validateExpense('1001', { a: '1001' }, { mode: 'equal', values: { a: '1', b: '1' } }, ['a','b']), before);
    }
    setDefaultCurrency('USD');
    assert.equal(formatMoney('1001', 'INR'), '₹10.01', 'explicit payment currency overrides display preference');
    assert.throws(() => setDefaultCurrency('invalid' as any));
    assert.equal(currencyCode(), 'USD');
  } finally { setDefaultCurrency(DEFAULT_CURRENCY); }
});

for (const platform of ['native.ts', 'native.web.ts']) test(`${platform} defaults to INR, persists choices and rejects invalid values`, async () => {
  const source = ts.createSourceFile(platform, readFileSync(new URL(`../src/${platform}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const statements = source.statements.filter(n => ts.isFunctionDeclaration(n) && ['savedCurrency','saveCurrency'].includes(n.name?.text ?? '')).map(n => n.getText(source).replace(/^export /, '')).join('\n');
  let stored: string | null = null;
  const env = { localStorage: { setItem: (_: string, value: string) => { stored = value; } }, DEFAULT_CURRENCY, isCurrency, CURRENCY_KEY: 'test.currency', SecureStore: { getItemAsync: async () => stored, setItemAsync: async (_: string, value: string) => { stored = value; } }, readPreference: () => stored, writePreference: (_: string, value: string) => { stored = value; } };
  const prefs = new Function('env', `with(env){${ts.transpile(statements,{target:ts.ScriptTarget.ES2022})};return {savedCurrency,saveCurrency};}`)(env);
  assert.equal(await prefs.savedCurrency(), 'INR');
  stored = 'corrupt'; assert.equal(await prefs.savedCurrency(), 'INR');
  await prefs.saveCurrency('EUR'); assert.equal(await prefs.savedCurrency(), 'EUR');
  await assert.rejects(() => prefs.saveCurrency('invalid'));
  assert.equal(stored, 'EUR');
});

test('display preference cannot change the currency or amount in a real UPI link', () => {
  try {
    setDefaultCurrency('USD');
    const url = new URL(buildUPIUrl({ id:'00000000-0000-4000-8000-000000000001', amount:'12345', currency:'INR', vpa:'name@bank', recipient:'Person', note:'', bank_verified:false, direct_launch_supported:true, expires_at:new Date(Date.now()+60_000).toISOString(), group_version:1 }));
    assert.equal(url.searchParams.get('cu'), 'INR');
    assert.equal(url.searchParams.get('am'), '123.45');
  } finally { setDefaultCurrency(DEFAULT_CURRENCY); }
});
