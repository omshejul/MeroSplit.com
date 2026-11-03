import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readLedgerHeads } from '../src/api.ts';
import { recordConnection, serverReachable } from '../src/connectivity.ts';
import { readFileSync } from 'node:fs';
const source = ts.createSourceFile('useLiveLedger.ts',readFileSync(new URL('../src/useLiveLedger.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const code = source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n');
const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
class ApiError extends Error {status:number;constructor(status:number){super('Synthetic');this.status=status;}}
function fixture(){
 const calls:any[]=[],refreshes:string[][]=[],timers=new Map<number,{fn:()=>void,delay:number}>();let timerId=0,ref:any,cleanup:(()=>void)|undefined,effect:(()=>void)|undefined,deps:any[]=[];
 const options:any={enabled:true,heads:[{id:'g',version:1,hidden:false}],safe:()=>true,onRefresh:async(ids:string[])=>{refreshes.push(ids)},onExpired:()=>{expired++}};let expired=0;
 const env={ApiError,useRef:(value:any)=>ref??={current:value},useEffect:(fn:()=>any,next:any[])=>{if(!deps.length||next.some((v,i)=>v!==deps[i])){effect=()=>{cleanup?.();cleanup=fn()};deps=next}},readLedgerHeads:(_:any,signal:AbortSignal)=>new Promise((resolve,reject)=>calls.push({path:'/me/ledger-heads',signal,resolve,reject})),setTimeout:(fn:()=>void,delay:number)=>{timers.set(++timerId,{fn,delay});return timerId},clearTimeout:(id:number)=>timers.delete(id)};
 const {useLiveLedger,changedLedgerGroups}=new Function('env',`with(env){${ts.transpile(code,{target:ts.ScriptTarget.ES2022})};return {useLiveLedger,changedLedgerGroups};}`)(env);
 return {calls,refreshes,timers,options,changedLedgerGroups,get expired(){return expired},render(changes:any={},session:any={baseUrl:'https://synthetic.invalid',userId:'one',token:'one'}){Object.assign(options,changes);useLiveLedger(session,{...options});effect?.();effect=undefined},async fire(){const [id,t]=timers.entries().next().value!;timers.delete(id);t.fn();await tick()},stop(){cleanup?.()}};
}
const head=(id='g',version=1,hidden=false)=>({id,version,hidden});
test('head comparison catches edits, new groups, removed membership and hidden changes without stale version rollback',()=>{
 const {changedLedgerGroups:changed}=fixture();assert.deepEqual(changed([head()], [head()]),[]);
 assert.deepEqual(changed([head('g',2),head('new')],[head(),head('removed')]),['g','new','removed']);
 assert.deepEqual(changed([head('g',1,true)],[head()]),['g']);assert.deepEqual(changed([head()],[head('g',2)]),[]);
 for(const value of [null,{},[head(),head()],[{id:'g',version:1}],[{...head(),version:-1}]])assert.throws(()=>changed(value,[head()]));
});
test('quiet checks do not reload data; changed versions refresh once and compare against accepted heads',async()=>{
 const app=fixture();app.render();assert.equal(app.calls[0].path,'/me/ledger-heads');assert.equal(app.timers.size,0);
 app.calls[0].resolve({groups:[head()]});await tick();assert.equal(app.refreshes.length,0);assert.equal([...app.timers.values()][0].delay,2000);
 await app.fire();app.calls[1].resolve({groups:[head('g',2)]});await tick();assert.deepEqual(app.refreshes,[['g']]);
 app.render({heads:[head('g',2)]});await app.fire();app.calls[2].resolve({groups:[head('g',2)]});await tick();assert.equal(app.refreshes.length,1);app.stop();
});
test('deferred or failed refresh retries the same version and backs off without overlapping requests',async()=>{
 const app=fixture();let safe=false;app.render({safe:()=>safe});assert.equal(app.calls.length,0);safe=true;await app.fire();assert.equal(app.calls.length,1);assert.equal(app.timers.size,0);
 app.render({onRefresh:async()=>{throw Error('Temporary')}});app.calls[0].resolve({groups:[head('g',2)]});await tick();assert.equal([...app.timers.values()][0].delay,4000);
 app.render({onRefresh:async(ids:string[])=>{app.refreshes.push(ids)}});await app.fire();app.calls[1].resolve({groups:[head('g',2)]});await tick();assert.deepEqual(app.refreshes,[['g']]);app.stop();
});
test('hidden or offline screens abort late responses; returning catches missed changes',async()=>{
 const app=fixture();app.render();app.render({enabled:false});assert.equal(app.calls[0].signal.aborted,true);app.calls[0].resolve({groups:[]});await tick();assert.equal(app.refreshes.length,0);assert.equal(app.timers.size,0);
 app.render({enabled:true});app.calls[1].resolve({groups:[head('g',3)]});await tick();assert.deepEqual(app.refreshes,[['g']]);app.stop();
});
test('account changes cancel pending work; expired sessions stop quietly',async()=>{
 const app=fixture();app.render();app.render({}, {baseUrl:'https://other.invalid',userId:'two',token:'two'});assert.equal(app.calls[0].signal.aborted,true);app.calls[0].resolve({groups:[]});await tick();assert.equal(app.refreshes.length,0);
 app.calls[1].reject(new ApiError(401));await tick();assert.equal(app.expired,1);assert.equal(app.timers.size,0);app.stop();
});


test('a failed advisory network probe keeps recovery enabled and retries without financial writes', async()=>{
 const fetch=globalThis.fetch;recordConnection(true);
 try{globalThis.fetch=async()=>{throw Error('Network down')};await assert.rejects(readLedgerHeads({baseUrl:'https://synthetic.invalid',userId:'one',token:'one',email:'one@example.invalid'}));assert.equal(serverReachable(),true);}finally{globalThis.fetch=fetch;recordConnection(true)}
 const app=fixture();app.render();app.calls[0].reject(Error('Network down'));await tick();assert.equal([...app.timers.values()][0].delay,4000);await app.fire();app.calls[1].resolve({groups:[head('g',2)]});await tick();assert.deepEqual(app.refreshes,[['g']]);app.stop();
});

test('the App watches accepted groups even when their creation receipt is held, and ignores only unsent local creations',()=>{
 const app=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);let expression='';
 function visit(n:ts.Node){if(ts.isCallExpression(n)&&n.expression.getText(app)==='useLiveLedger'){const options=n.arguments[1] as ts.ObjectLiteralExpression;expression=(options.properties.find(p=>p.name?.getText(app)==='heads') as ts.PropertyAssignment).initializer.getText(app);}ts.forEachChild(n,visit)}visit(app);assert.ok(expression);
 const groups=[{kind:'shared',group:head('local',0)},{kind:'shared',group:head('accepted',1)},{kind:'local',group:head('device',0)}];
 const commands=['local','accepted'].map(group_id=>({group_id,method:'POST',path:'/groups'}));
 const heads=new Function('groups','commands',`return ${expression}`)(groups,commands);assert.deepEqual(heads,[head('accepted',1)]);
});
