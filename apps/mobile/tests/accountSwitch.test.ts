import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { EmailLinkError } from '../src/emailLinkApi.ts';
import { inspectNativeEmailLink, NativeEmailLinkError } from '../src/nativeEmailLinkApi.ts';

const file = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function productionFunction(name: string, env: Record<string, unknown>) {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); };
  visit(file); assert.ok(found);
  const code = ts.transpileModule(found.getText(file), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return Function(...Object.keys(env), `${code}; return ${name};`)(...Object.values(env));
}
function productionAuthDialog(authHeld: boolean, emailEntry: { phase: string } | null) {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.expression?.getText(file).startsWith('authHeld &&') && node.getText(file).includes('<EmailLinkDialog')) expression = node.expression;
    ts.forEachChild(node, visit);
  };
  visit(file); assert.ok(expression);
  const code = ts.transpileModule(`const result = (${expression.getText(file)});`, {compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
  return Function('authHeld', 'emailEntry', 'emailContent', 'EmailLinkDialog', 'React', `${code}; return result;`)(
    authHeld, emailEntry, 'email-link-content', 'EmailLinkDialog', {createElement:(type: string, props: Record<string, unknown>)=>({type,props})},
  );
}
const session = {baseUrl:'https://merosplit.test',userId:'1',email:'one@example.invalid',token:'a'.repeat(32)};
const inspection = {email:'two@example.invalid',userId:2,purpose:'invite',currentUserId:1,currentEmail:session.email};
const grant = '01234567-89ab-cdef-0123-456789abcdef', proof = 'p'.repeat(43);
function preview(extra: Record<string, unknown> = {}) {
  const calls:string[] = [], epoch = {current:1}, entry = {id:grant,phase:'opening',error:'',sent:false};
  const emailEntryRef:{current:any} = {current:entry}, checked:unknown[]=[];
  const env = {pauseAccountRequests:async()=>{calls.push('pause');}, draftWrites:{current:Promise.resolve()},authEpoch:epoch,cookieCheck:{current:false},
    Platform:{OS:'web'},session,savedSession:async()=>session,API_URL:session.baseUrl,emailProof:{current:{id:grant,proof}},emailEntryRef,
    setEmailEntry:(value:any)=>{emailEntryRef.current=value;}, EmailLinkError,NativeEmailLinkError,
    inspectEmailLink:async()=>{calls.push('inspect');return inspection;},inspectNativeEmailLink:async()=>inspection,
    resolveEmailLink:async(...args:unknown[])=>{checked.push(args);calls.push('resolve');return null;},
    resolveNativeEmailLink:async(...args:unknown[])=>{checked.push(args);calls.push('resolve');return null;},...extra};
  return {env,calls,epoch,entry,emailEntryRef,checked,run:productionFunction('finishEmailLink',env)};
}

test('returning to an authenticated browser tab rechecks cookies without opening a sign-in dialog',()=>{
  const authHeldRef={current:false},activeSessionRef={current:session as typeof session|null},cookieCheck={current:false};
  let checkingCookie=false,pauses=0;
  const recheck=productionFunction('queueCookieCheck',{Platform:{OS:'web'},authHeldRef,activeSessionRef,cookieCheck,
    setCheckingCookie:(value:boolean)=>{checkingCookie=value;},pauseAccountRequests:()=>{pauses++;return Promise.resolve();}});
  recheck();
  assert.equal(checkingCookie,true);assert.equal(cookieCheck.current,true);assert.equal(authHeldRef.current,true);
  assert.equal(activeSessionRef.current,null);assert.equal(pauses,1);
  assert.equal(productionAuthDialog(authHeldRef.current,null),false);
});

test('actual email-link sign-in, name, error and account-switch dialogs remain visible while auth is held',()=>{
  for(const phase of ['opening','target','error','name']) {
    const rendered=productionAuthDialog(true,{phase});
    assert.equal(rendered.type,'EmailLinkDialog');assert.equal(rendered.props.title,phase==='name'?'Name':'Sign in');
  }
  assert.equal(productionAuthDialog(true,{phase:'switch'}),'email-link-content');
  assert.equal(productionAuthDialog(false,{phase:'opening'}),false);
});

test('actual App opening another account link only inspects and shows both accounts before any exchange',async()=>{
  const app=preview(); await app.run(app.entry,1);
  assert.deepEqual(app.calls,['pause','inspect']);assert.equal(app.checked.length,0);
  assert.equal(app.emailEntryRef.current.phase,'switch');assert.equal(app.emailEntryRef.current.inspection.currentEmail,session.email);
  assert.equal(app.emailEntryRef.current.inspection.email,inspection.email);assert.equal(app.env.emailProof.current.proof,proof);
});

test('actual App same-account preview continues without popup; explicit switch binds the current account',async()=>{
  const same=preview({inspectEmailLink:async()=>({...inspection,userId:1})});await same.run(same.entry,1);
  assert.equal(same.emailEntryRef.current.phase,'opening');assert.equal(same.checked.length,1);
  const confirmed=preview();await confirmed.run({...confirmed.entry,switchFromUserId:1},1);
  assert.equal(confirmed.checked[0] && (confirmed.checked[0] as unknown[])[3],1);
  const rebound=preview({inspectEmailLink:async()=>({...inspection,currentUserId:3,currentEmail:'three@example.invalid'})});
  await assert.rejects(rebound.run({...rebound.entry,switchFromUserId:1},1),/account changed/);assert.equal(rebound.checked.length,0);
});

test('actual App ignores stale preview and never exchanges a failed or consumed preview proof',async()=>{
  let release!:(value:unknown)=>void;const wait=new Promise(resolve=>{release=resolve;});
  const stale=preview({inspectEmailLink:()=>wait});const pending=stale.run(stale.entry,1);await Promise.resolve();await Promise.resolve();stale.epoch.current=2;release(inspection);await pending;
  assert.equal(stale.checked.length,0);assert.equal(stale.emailEntryRef.current.phase,'opening');
  const consumed=preview({inspectEmailLink:async()=>{throw new EmailLinkError(400);}});await consumed.run(consumed.entry,1);
  assert.equal((consumed.checked[0] as any[])[1].proof,null,'only a same-recipient resume is permitted after failed proof inspection');
});

test('actual native App recovers a rejected saved token through anonymous inspection before resolving the fresh proof',async()=>{
  const original=globalThis.fetch,calls:{url:string;token:string|null}[]=[];
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),token:new Headers(init?.headers).get('X-Session-Token')});return calls.length===1?Response.json({}, {status:410}):Response.json({data:{email:inspection.email,user_id:2,purpose:'invite',current_user_id:null,current_email:null}});};
  try {
    const app=preview({Platform:{OS:'ios'},inspectNativeEmailLink});await app.run(app.entry,1);
    assert.equal(app.checked.length,1);assert.deepEqual(calls.map(call=>call.token),[session.token,null]);assert.ok(calls.every(call=>call.url.endsWith('/inspect')));
    assert.equal(app.emailEntryRef.current.phase,'opening');
  } finally {globalThis.fetch=original;}
});

test('actual Cancel discards only ephemeral link state and restores the same session without logging out or changing drafts',()=>{
  const drafts={text:'Unsaved dinner',commands:['same-command']},before=structuredClone(drafts),authEpoch={current:1},authHeldRef={current:true},activeSessionRef={current:null as typeof session|null};
  const emailProof={current:{id:grant,proof} as unknown},emailEntryRef={current:{phase:'switch'} as unknown},initialEmailLink={current:{id:grant,proof} as unknown};let clears=0,resumes=0,checks=0;
  const cancel=productionFunction('cancelAccountSwitch',{busy:false,authEpoch,authHeldRef,activeSessionRef,session,emailProof,emailEntryRef,initialEmailLink,forgetEmailProof:()=>clears++,setEmailEntry:(value:unknown)=>{emailEntryRef.current=value;},resumeAccountRequests:()=>resumes++,queueCookieCheck:()=>checks++});
  cancel();assert.equal(activeSessionRef.current,session);assert.equal(authHeldRef.current,false);assert.equal(authEpoch.current,2);assert.equal(emailProof.current,null);assert.equal(emailEntryRef.current,null);assert.equal(initialEmailLink.current,null);assert.deepEqual(drafts,before);assert.equal(clears,1);assert.equal(resumes,1);assert.equal(checks,1);
});
