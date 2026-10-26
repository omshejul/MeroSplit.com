import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(load: (signal: AbortSignal) => Promise<boolean | null>, web = false) {
  let now = Date.now();
  let index = 0, props = { scope: 'account|group|query', cursor: 'next' as string | null, enabled: true, load }, effects: (() => void)[] = [];
  const state: any[] = [], deps: any[][] = [], cleanup: (() => void)[] = [], listeners = new Map<string, () => void>();
  const env = { Date: { now: () => now }, Platform: { OS: web ? 'web' : 'ios' },
    useRef: (value: any) => state[index++] ??= { current: value },
    useState: (value: any) => { const key = index++; return [state[key] ??= value, (value: any) => { state[key] = typeof value === 'function' ? value(state[key]) : value; }]; },
    useEffect: (fn: () => any, values: any[]) => { const key = index++; if (!deps[key] || values.some((value, i) => value !== deps[key][i])) { effects.push(() => { cleanup[key]?.(); cleanup[key] = fn(); }); deps[key] = values; } },
  };
  const source = ts.createSourceFile('useScrollPagination.ts', readFileSync(new URL('../src/useScrollPagination.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const body = source.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(source).replace(/^export /, '')).join('\n');
  const hook = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022 })};return useScrollPagination;}`)(env);
  const scrollRef = { current: { getScrollableNode: () => ({ addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) }) } };
  return { render: (changes: Partial<typeof props> = {}) => { props = { ...props, ...changes }; index = 0; return hook({ ...props, scrollRef }); },
    commit: async () => { const pending = effects; effects = []; pending.forEach(fn => fn()); await tick(); },
    advance: (ms: number) => { now += ms; }, wheel: () => listeners.get('wheel')?.(), unmount: () => cleanup.forEach(fn => fn?.()) };
}

test('mount and cursor changes never fetch without an explicit Load older tap', async () => {
  let calls = 0; const app = fixture(async () => { calls++; return true; });
  let paging = app.render(); await app.commit(); assert.equal(calls, 0); assert.equal(paging.canLoadMore, true);
  paging.loadMore(); await tick(); assert.equal(calls, 1);
  paging = app.render({ cursor: 'older' }); await app.commit(); assert.equal(calls, 1);
  paging.loadMore(); await tick(); assert.equal(calls, 2); app.unmount();
});

test('double taps, repeated cursors and exhaustion stop duplicate requests', async () => {
  let finish!: (added: boolean) => void, calls = 0;
  const app = fixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  let paging = app.render(); await app.commit(); paging.loadMore(); paging.loadMore(); assert.equal(calls, 1);
  assert.equal(app.render().loading, true); finish(true); await tick();
  paging = app.render(); assert.equal(paging.canLoadMore, false); paging.loadMore(); assert.equal(calls, 1);
  paging = app.render({ cursor: null }); await app.commit(); paging.loadMore(); assert.equal(calls, 1); app.unmount();
});

test('cancel and re-enable the same cursor ignores its late result', async () => {
  const pending: { signal: AbortSignal; resolve: (added: boolean) => void }[] = [];
  const app = fixture(signal => new Promise(resolve => pending.push({ signal, resolve })));
  let paging = app.render(); await app.commit(); paging.loadMore();
  app.render({ enabled: false }); await app.commit(); assert.equal(pending[0].signal.aborted, true);
  paging = app.render({ enabled: true }); await app.commit(); paging.loadMore(); assert.equal(pending.length, 2);
  pending[0].resolve(true); await tick(); assert.equal(app.render().loading, true);
  pending[1].resolve(true); await tick(); assert.equal(app.render().loading, false); app.unmount();
});

test('scope change aborts old work and requires a fresh tap', async () => {
  let signal!: AbortSignal, calls = 0;
  const app = fixture(value => { signal = value; calls++; return new Promise(() => {}); });
  let paging = app.render(); await app.commit(); paging.loadMore();
  paging = app.render({ scope: 'another-account|another-group|filter' }); await app.commit();
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  paging.loadMore(); assert.equal(calls, 2); app.unmount();
});

test('failed pages retain their cursor for explicit Retry', async () => {
  let calls = 0; const app = fixture(async () => { calls++; if (calls === 1) throw Error('Offline'); return true; });
  let paging = app.render(); await app.commit(); paging.loadMore(); await tick();
  paging = app.render(); await app.commit(); assert.equal(paging.failed, true); assert.equal(calls, 1);
  paging.retry(); await tick(); assert.equal(calls, 2); assert.equal(app.render().failed, false); app.unmount();
});

test('empty pages and busy readers never automatically drain the next cursor', async () => {
  let calls = 0; const app = fixture(async () => { calls++; return calls === 1 ? null : false; });
  let paging = app.render(); await app.commit(); paging.loadMore(); await tick();
  paging = app.render(); assert.equal(paging.failed, false); paging.loadMore(); await tick(); assert.equal(calls, 2);
  paging = app.render({ cursor: 'next-page' }); await app.commit(); assert.equal(calls, 2);
  assert.equal(paging.canLoadMore, true); app.unmount();
});
