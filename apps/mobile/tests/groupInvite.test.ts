import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { groupInviteToken, captureGroupInvite, forgetGroupInvite } from '../src/groupInvite.ts';
import { parseNativeLink, APP_ORIGIN, confirmedGroupInvite } from '../src/appLinks.ts';
import { readAppLink, subscribeAppLinks } from '../src/browserLinks.web.ts';
const token = '01234567-89ab-cdef-0123-456789abcdef:' + 's'.repeat(43);
const source = readFileSync(new URL('../scripts/email-link-bootstrap.js', import.meta.url), 'utf8');
test('native cold/warm parsing accepts only canonical fragment group capabilities', () => {
  assert.deepEqual(parseNativeLink(`${APP_ORIGIN}/app/invite/join#token=${encodeURIComponent(token)}`), { kind: 'app', target: { groupInviteToken: token } });
  for (const hash of ['#token=short', '#token='+token+'&other=1', '#token=%xx', '']) assert.equal(parseNativeLink(`${APP_ORIGIN}/app/invite/join${hash}`), null);
  assert.equal(parseNativeLink(`https://other.invalid/app/invite/join#token=${token}`), null);
  assert.equal(groupInviteToken('#token='+encodeURIComponent(token)), token);
});
test('early bootstrap scrubs before assets; tab continuation survives email sign-in and clears on cancel', () => {
  const values = new Map<string,string>(), writes: string[] = [];
  const storage = { getItem: (k:string)=>values.get(k)??null, setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k) };
  const location = { pathname:'/app/invite/join',hash:'#token='+encodeURIComponent(token),search:'' };
  const history = { replaceState: (_a:unknown,_b:string,path:string)=>{ writes.push(path);location.hash=''; } };
  const browser = {location,history};
  vm.runInNewContext(source,{window:browser,location,history,sessionStorage:storage});
  assert.deepEqual(writes,['/app/invite/join']);assert.ok(!writes[0].includes(token));
  const priorWindow=globalThis.window,priorStorage=globalThis.sessionStorage;
  Object.assign(globalThis,{window:browser,sessionStorage:storage});
  try {
    assert.deepEqual(readAppLink(),{groupInviteToken:token});
    location.pathname='/app/sign-in/01234567-89ab-cdef-0123-456789abcdef';location.hash='#proof='+'p'.repeat(64);
    assert.equal(captureGroupInvite(),token);assert.ok(location.hash.startsWith('#proof='),'do not steal email proof');
    forgetGroupInvite();assert.equal(captureGroupInvite(),null);
    location.pathname='/app/invite/join';location.hash='#token=bad';assert.equal(readAppLink(),null);
  } finally {Object.assign(globalThis,{window:priorWindow,sessionStorage:priorStorage});}
});

test('browser link subscription removes both listeners on cleanup', () => {
  const prior=globalThis.window, added=new Map<string, unknown>(), removed=new Map<string,unknown>();
  Object.assign(globalThis,{window:{addEventListener:(n:string,f:unknown)=>added.set(n,f),removeEventListener:(n:string,f:unknown)=>removed.set(n,f)}});
  try {const stop=subscribeAppLinks(()=>{});stop();assert.deepEqual([...added.keys()],['popstate','hashchange']);assert.deepEqual(removed,added);} finally {Object.assign(globalThis,{window:prior});}
});

test('sharing requires a confirmed matching group receipt and an exact owned capability URL', () => {
 const good={id:'g',version:2,url:APP_ORIGIN+'/app/invite/join#token='+encodeURIComponent(token)};
 assert.equal(confirmedGroupInvite('g',good),good.url);
 for(const value of [{},{...good,url:undefined},{...good,url:''},{...good,id:'other'},{...good,version:0},{...good,url:'https://other.invalid/app/invite/join#token='+token},{...good,url:APP_ORIGIN+'/undefined'},{...good,url:APP_ORIGIN+'/app/invite/join#token=bad'}])assert.throws(()=>confirmedGroupInvite('g',value),/Could not confirm/);
});
