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
