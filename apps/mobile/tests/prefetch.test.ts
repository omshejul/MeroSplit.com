import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadPrefetch, prefetchTTL, readScope, readPrefetch } from '../src/prefetch.ts';
import { request, prefetchRead } from '../src/api.ts';
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only metadata, first pages and versioned details are eligible', () => {
  for (const path of ['/me','/me/notifications/preferences','/activity?limit=50','/me/chat-conversations?limit=20','/groups/g/expenses/b?version=4','/groups/g/settlements/p?version=4']) assert.ok(prefetchTTL(path));
  for (const path of ['/me/mcp','/activity?limit=50&cursor=older','/groups/g/expenses/b/history','/groups/g/expenses/b/chat','/groups/g/expenses/b/attachments','/groups/g/history?search=food']) assert.equal(prefetchTTL(path),0);
});
test('only two speculative reads run and a tap promotes queued work immediately', async () => {
  const cache=new ReadPrefetch();cache.configure('a',true);
  const one=deferred<any>(),two=deferred<any>();const calls:string[]=[];
  const a=cache.warm('a','/me',async()=>{calls.push('one');return one.promise;});
  const b=cache.warm('a','/activity?limit=50',async()=>{calls.push('two');return two.promise;});
  const c=cache.warm('a','/me/notifications/preferences',async()=>{calls.push('three');return {enabled:true};});
  await tick();assert.deepEqual(calls,['one','two']);
  const tapped=cache.read('a','/me/notifications/preferences',async()=>{assert.fail('must share queued loader');});
  await tapped;assert.deepEqual(calls,['one','two','three']);
  one.resolve({name:'One'});two.resolve({items:[]});await Promise.all([a,b,c]);
});
test('prefetch and click share one GET; cached values are isolated and expire', async () => {
  let now=0,calls=0;const cache=new ReadPrefetch(()=>now);cache.configure('a',true);const pending=deferred<any>();
  const warmed=cache.warm('a','/me',async()=>{calls++;return pending.promise;});
  const clicked=cache.read<any>('a','/me',async()=>{assert.fail('duplicate GET');});
  pending.resolve({name:'One'});await warmed;const value=await clicked;value.name='Changed';
  assert.equal((await cache.read<any>('a','/me',async()=>{assert.fail();})).name,'One');assert.equal(calls,1);
  now=60_001;assert.equal(cache.fresh('a','/me'),false);
  assert.equal(cache.peek<any>('a','/me')?.name,'One','stale data remains available to paint immediately');
  await cache.read('a','/me',async()=>{calls++;return {name:'Fresh'};});assert.equal(calls,2);
});
test('background/offline pauses abort speculative reads and drop queued work',async()=>{
  const cache=new ReadPrefetch();cache.configure('a',true);const pending=deferred<any>();let signal!:AbortSignal,queued=0;
  const a=cache.warm('a','/me',async s=>{signal=s;return pending.promise;});
  const b=cache.warm('a','/activity?limit=50',async()=>pending.promise);
  const c=cache.warm('a','/me/notifications/preferences',async()=>{queued++;return {};});
  await tick();cache.configure('a',false);assert.equal(signal.aborted,true);assert.equal(queued,0);
  assert.deepEqual(await Promise.all([a,b,c]),[undefined,undefined,undefined]);pending.resolve({});await tick();
  assert.equal(cache.peek('a','/me'),undefined);
});
test('account/token changes discard late results and never reuse another identity',async()=>{
  const cache=new ReadPrefetch(),old=deferred<any>();cache.configure('a',true);
  const work=cache.warm('a','/me',async()=>old.promise);await tick();cache.configure('b',true);old.resolve({name:'Old'});await work;await tick();
  assert.equal(cache.peek('b','/me'),undefined);assert.equal(cache.peek('a','/me'),undefined);
  assert.notEqual(readScope({baseUrl:'x',userId:'1',token:'a'} as any),readScope({baseUrl:'x',userId:'1',token:'b'} as any));
});
test('a failed warm-up is retryable and never blocks subsequent clicks',async()=>{
  const cache=new ReadPrefetch();cache.configure('a',true);
  assert.equal(await cache.warm('a','/me',async()=>{throw Error('Offline');}),undefined);
  assert.deepEqual(await cache.read('a','/me',async()=>({name:'Retry'})),{name:'Retry'});
});
test('a caller cancelling a shared read does not cancel another caller',async()=>{
  const cache=new ReadPrefetch();cache.configure('a',true);const pending=deferred<any>(),controller=new AbortController();
  const first=cache.read('a','/me',async()=>pending.promise,controller.signal);
  const second=cache.read('a','/me',async()=>{assert.fail('duplicate');});controller.abort();await assert.rejects(first,/cancelled/);
  pending.resolve({name:'Kept'});assert.deepEqual(await second,{name:'Kept'});
});
test('actual API prefetch is reused on click and any mutation invalidates its result',async()=>{
  const session={baseUrl:'https://synthetic.invalid',userId:'1',token:'synthetic'} as any;
  const previous=globalThis.fetch;let gets=0;
  globalThis.fetch=async(_url,init)=>{if(init?.method==='POST')return Response.json({saved:true});gets++;return Response.json({display_name:'Name '+gets});};
  readPrefetch.configure(readScope(session),true);
  try {
    await prefetchRead(session,'/me');assert.deepEqual(await request(session,'/me'),{display_name:'Name 1'});assert.equal(gets,1);
    await request(session,'/me/name','POST',{name:'Changed'});
    assert.deepEqual(await request(session,'/me'),{display_name:'Name 2'});assert.equal(gets,2);
  } finally {readPrefetch.configure('',false);globalThis.fetch=previous;}
});

test('saving invalidates cache without interrupting an unrelated foreground read or caching its old result',async()=>{
 const cache=new ReadPrefetch();cache.configure('a',true);const pending=deferred<any>();
 const foreground=cache.read('a','/me',async()=>pending.promise);await tick();cache.invalidate('a');pending.resolve({name:'Old'});
 assert.deepEqual(await foreground,{name:'Old'});assert.equal(cache.peek('a','/me'),undefined);
 assert.deepEqual(await cache.read('a','/me',async()=>({name:'New'})),{name:'New'});
});

test('returning to Me keeps confirmed settings through mutations and a pending background refresh', async () => {
  const cache = new ReadPrefetch(); cache.configure('a', true);
  const path = '/me/notifications/preferences';
  const confirmed = { expense_updates: true, email_reminders: true, push_device_ids: ['phone'] };
  await cache.read('a', path, async () => confirmed);
  cache.invalidate('a');
  assert.deepEqual(cache.peek('a', path), confirmed, 'Me must not paint Unavailable after another setting is saved');
  assert.equal(cache.fresh('a', path), false, 'retained settings still need revalidation');
  const pending = deferred<any>();
  const refreshing = cache.read('a', path, async () => pending.promise);
  const shared = cache.read('a', path, async () => assert.fail('duplicate background refresh'));
  assert.deepEqual(cache.peek('a', path), confirmed, 'a pending refresh must not erase the row details');
  pending.resolve({ ...confirmed, email_reminders: false });
  await Promise.all([refreshing, shared]);
  assert.equal(cache.peek<any>('a', path).email_reminders, false);
});

test('failed settings refresh retains known details and retries; account changes still erase them', async () => {
  let now = 0; const cache = new ReadPrefetch(() => now); cache.configure('a', true);
  await cache.read('a', '/me', async () => ({ avatar: 'known-photo' })); now = 60_001;
  await assert.rejects(cache.read('a', '/me', async () => { throw Error('offline'); }));
  assert.deepEqual(cache.peek('a', '/me'), { avatar: 'known-photo' });
  await cache.read('a', '/me', async () => ({ avatar: 'new-photo' }));
  assert.deepEqual(cache.peek('a', '/me'), { avatar: 'new-photo' });
  cache.configure('b', true); assert.equal(cache.peek('b', '/me'), undefined);
});


test('a confirmed settings save wins over a late GET and survives a background pause', async () => {
  let now = 0; const cache = new ReadPrefetch(() => now); cache.configure('a', true);
  const path = '/me/sign-in-methods';
  cache.confirm('a', path, { auto_link: true }); now = 60_001;
  const pending = deferred<any>(); const reading = cache.warm('a', path, () => pending.promise); await tick();
  assert.deepEqual(cache.peek('a', path), { auto_link: true });
  cache.confirm('a', path, { auto_link: false });
  pending.resolve({ auto_link: true }); await reading;
  assert.deepEqual(cache.peek('a', path), { auto_link: false });
  cache.configure('a', false); assert.deepEqual(cache.peek('a', path), { auto_link: false });
  cache.configure('b', true); assert.equal(cache.peek('b', path), undefined);
});
