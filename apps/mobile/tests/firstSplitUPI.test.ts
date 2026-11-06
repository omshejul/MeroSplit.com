import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
function fn(file: string, name: string, env: any) {
 const source=ts.createSourceFile(file,readFileSync(new URL(`../${file}`,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let code='';function visit(n:ts.Node){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)code=n.getText(source).replace(/^export /,'');ts.forEachChild(n,visit);}visit(source);assert.ok(code);
 return new Function('env',`with(env){${ts.transpile(code,{target:ts.ScriptTarget.ES2022})};return ${name};}`)(env);
}
function saveHarness(changes:any={}) {
 const events:string[]=[],session={token:'one'},env:any={session,selected:{group:{archived:false}},expenseId:null,vpa:'',selfId:'me',owner:'owner',draftWrites:{current:Promise.resolve()},perform:async(action:any)=>action(),queue:async()=>{events.push('saved');},command:()=>({}),groupId:'group',expensePayload:()=>({}),reviewCommand:null,setReviewCommand(){},setReviewInput(){},navigation:{complete:()=>events.push('left-editor')},isOnline:()=>false,upiPrompts:{current:new Set()},claimFirstSplitUPIPrompt:async()=>true,ownerRef:{current:'owner'},activeSessionRef:{current:session},setUpiAfterSplit:()=>events.push('copy'),setUpiSetup:()=>events.push('show'),...changes};
 return {env,events,save:fn('App.tsx','saveExpense',env)};
}
const bill={paid:{me:'20000'},shares:{me:'10000'},deleted:false};
test('first net receivable after a new split prompts only after the successful save and leaving editor',async()=>{
 const h=saveHarness();await h.save(bill);assert.deepEqual(h.events,['saved','left-editor','copy','show']);
 await h.save(bill);assert.equal(h.events.filter(v=>v==='show').length,1);
});
test('existing UPI, edits, removed bills, unknown self and non-receivables do not prompt',async()=>{
 for(const change of [{vpa:'name@bank'},{expenseId:'existing'},{selfId:''}]){const h=saveHarness(change);await h.save(bill);assert.ok(!h.events.includes('show'));}
 for(const value of [{...bill,deleted:true},{...bill,paid:{me:'10000'}},{...bill,paid:{me:'0'}},{...bill,shares:{me:'30000'}}]){const h=saveHarness();await h.save(value);assert.ok(!h.events.includes('show'));}
});
test('failed saves, prior dismissal, storage failure and account changes never produce a prompt',async()=>{
 const failed=saveHarness({queue:async()=>{throw Error('Save failed');}});await assert.rejects(failed.save(bill));assert.deepEqual(failed.events,[]);
 for(const claim of [async()=>false,async()=>{throw Error('Storage unavailable');}]){const h=saveHarness({claimFirstSplitUPIPrompt:claim});await h.save(bill);assert.ok(h.events.includes('saved'));assert.ok(!h.events.includes('show'));}
 const switched=saveHarness();switched.env.claimFirstSplitUPIPrompt=async()=>{switched.env.activeSessionRef.current={token:'other'};return true;};await switched.save(bill);assert.ok(!switched.events.includes('show'));
});
test('native and web remember first-split prompt across remounts, isolated by account and backend',async()=>{
 for(const file of ['src/native.ts','src/native.web.ts']){
  const disk=new Map<string,string>();const env={SecureStore:{getItemAsync:async(k:string)=>disk.get(k),setItemAsync:async(k:string,v:string)=>{disk.set(k,v);}},CryptoDigestAlgorithm:{SHA256:'sha256'},digestStringAsync:async(_:string,v:string)=>createHash('sha256').update(v).digest('hex'),readPreference:(k:string)=>disk.get(k),writePreference:(k:string,v:string)=>disk.set(k,v)};
  assert.equal(await fn(file,'claimFirstSplitUPIPrompt',env)('https://one|1'),true);
  assert.equal(await fn(file,'claimFirstSplitUPIPrompt',env)('https://one|1'),false);
  assert.equal(await fn(file,'claimFirstSplitUPIPrompt',env)('https://one|2'),true);
  assert.equal(await fn(file,'claimFirstSplitUPIPrompt',env)('https://two|1'),true);
 }
});
