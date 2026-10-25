import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readAppLink, writeAppLink } from '../src/browserLinks.web.ts';
import type { AppLink } from '../src/browserLinks.ts';

const file = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function productionNode(predicate: (node: ts.Node) => boolean) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (predicate(node)) found = node; ts.forEachChild(node, visit); };
  visit(file); assert.ok(found); return found;
}
function actual(node: ts.Node, env: Record<string, unknown>) {
  const code = ts.transpileModule(`const actual = (${node.getText(file)});`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return Function(...Object.keys(env), `${code}; return actual;`)(...Object.values(env));
}
function effect(marker: string) {
  return (productionNode(node => ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' && !!node.arguments[0]?.getText(file).includes(marker)) as ts.CallExpression).arguments[0];
}
const openLink = effect('const active = session, target = appLink;');
const syncURL = effect("if (screen === 'group' || screen === 'expenseDetail'");
const queueCheck = productionNode(node => ts.isFunctionDeclaration(node) && node.name?.text === 'queueCookieCheck');
const groupId = '11111111-1111-4111-8111-111111111111';
const groupURL = `https://merosplit.test/app/groups/${groupId}`;
class ApiError extends Error { status: number; constructor(status: number) { super(`HTTP ${status}`); this.status=status; } }

async function browserScenario(run: (app: ReturnType<typeof appHarness>, browser: {location: URL}) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = {location:new URL(groupURL),history:{pushState:(_s: unknown,_t: string,path: string)=>{browser.location=new URL(path,groupURL);}}};
  Object.assign(globalThis,{window:browser});
  try { await run(appHarness(),browser); }
  finally { if (previous) Object.defineProperty(globalThis,'window',previous); else Reflect.deleteProperty(globalThis,'window'); }
}
function appHarness() {
  const session={token:'synthetic-session',userId:'1',baseUrl:'https://merosplit.test',email:'one@example.invalid'};
  const activeSessionRef={current:session as typeof session|null},authHeldRef={current:false},cookieCheck={current:false};
  const state={appLink:readAppLink(),screen:'home',groupId:null as string|null,expenseId:null as string|null,checkingCookie:false,saves:0,claims:0,fetches:0,notice:''};
  let pending=Promise.resolve<unknown>(undefined),fetch=async()=>({id:groupId,is_direct:false,expenses:[]});
  const env={ready:true,session,expired:false,busy:false,activeSessionRef,authHeldRef,cookieCheck,Platform:{OS:'web'},ApiError,
    draftWrites:{current:Promise.resolve()},launch:(fn:()=>Promise<unknown>)=>{pending=fn();},fetchGroup:()=>{state.fetches++;return fetch();},
    withBill:async(_s: unknown,group: unknown)=>group,getDatabase:async()=>({}),accountOwner:()=>session.userId,saveGroup:async()=>{state.saves++;},readVisibleGroup:async()=>null,
    request:async()=>{state.claims++;return {id:groupId};},uuid:()=>'synthetic-command',
    setGroupId:(id:string)=>{state.groupId=id;},setTab:()=>{},setExpenseId:(id:string|null)=>{state.expenseId=id;},setDraft:()=>{},setScreen:(screen:string)=>{state.screen=screen;},
    setAppLink:(next:AppLink|null|((current:AppLink|null)=>AppLink|null))=>{state.appLink=typeof next==='function'?next(state.appLink):next;},
    setNotice:(notice:string)=>{state.notice=notice;},setCheckingCookie:(value:boolean)=>{state.checkingCookie=value;},pauseAccountRequests:()=>Promise.resolve()};
  const view=()=>({...env,...state,authHeld:state.checkingCookie,writeAppLink});
  return {state,activeSessionRef,open:()=>{actual(openLink,view())();return pending;},sync:()=>actual(syncURL,view())(),
    check:()=>actual(queueCheck,env)(),resume:()=>{activeSessionRef.current=session;authHeldRef.current=false;cookieCheck.current=false;state.checkingCookie=false;},
    fail:(error:Error)=>{fetch=async()=>{throw error;};}};
}

test('a normal group deep link opens the group and keeps its URL',async()=>browserScenario(async(app,browser)=>{
  await app.open();app.sync();
  assert.equal(app.state.screen,'group');assert.equal(app.state.appLink,null);assert.equal(browser.location.href,groupURL);
}));

test('a session check cannot discard a pending group URL; opening retries after validation',async()=>browserScenario(async(app,browser)=>{
  const target=app.state.appLink,pending=app.open();app.check();await pending;
  assert.equal(app.state.screen,'home');assert.equal(app.state.saves,0);assert.equal(app.state.appLink,target);
  app.resume();app.sync();assert.equal(browser.location.href,groupURL);
  await app.open();app.sync();
  assert.equal(app.state.screen,'group');assert.equal(app.state.saves,1);assert.equal(app.state.appLink,null);assert.equal(browser.location.href,groupURL);
}));

test('a pending group does not repeatedly fetch while its account is held or unvalidated',async()=>browserScenario(async(app,browser)=>{
  const target=app.state.appLink,session=app.activeSessionRef.current!;
  app.check();app.state.checkingCookie=false;app.activeSessionRef.current=session;
  await app.open();assert.equal(app.state.fetches,0);
  app.resume();app.activeSessionRef.current=null;
  await app.open();assert.equal(app.state.fetches,0);
  app.activeSessionRef.current={...session,token:'different-session'};
  await app.open();assert.equal(app.state.fetches,0);
  assert.equal(app.state.appLink,target);assert.equal(browser.location.href,groupURL);
}));

test('an obsolete account response cannot discard the destination or save its group',async()=>browserScenario(async(app,browser)=>{
  const target=app.state.appLink,pending=app.open();app.activeSessionRef.current={...app.activeSessionRef.current!,token:'new-account-session'};await pending;
  assert.equal(app.state.appLink,target);assert.equal(app.state.saves,0);app.sync();assert.equal(browser.location.href,groupURL);
}));

test('finishing an older group request cannot clear a newer queued destination',async()=>browserScenario(async(app)=>{
  const pending=app.open(),next={groupId:'01234567-89ab-cdef-0123-456789abcdef'};app.state.appLink=next;await pending;
  assert.equal(app.state.appLink,next);
}));

test('a definitive missing group clears its link and reports unavailable',async()=>browserScenario(async(app,browser)=>{
  app.fail(new ApiError(404));await app.open();app.sync();
  assert.equal(app.state.appLink,null);assert.match(app.state.notice,/unavailable/);assert.equal(browser.location.pathname,'/app/');
}));

test('a normal network failure clears the link instead of automatically retrying forever',async()=>browserScenario(async(app)=>{
  app.fail(new Error('offline'));await assert.rejects(app.open(),/offline/);assert.equal(app.state.appLink,null);
}));

test('an interrupted legacy invitation claim is not automatically replayed',async()=>browserScenario(async(app)=>{
  app.state.appLink={inviteToken:'synthetic-invite'};const pending=app.open();app.check();await pending;
  assert.equal(app.state.claims,1);assert.equal(app.state.appLink,null);
}));
