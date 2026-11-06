import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {scrubSentryEvent,scrubSentrySpan,scrubBreadcrumb,diagnosticRoute} from '../src/sentryPrivacy.ts';
function setup(){
 let options:any,cleanup:any,current:any=null,observer:any,tracer:any;const users:any[]=[],crumbs:any[]=[],errors:any[]=[],spans:any[]=[];
 const Sentry:any={init:(value:any)=>options=value,setTag(){},setUser:(value:any)=>{current=value;users.push(value);},getIsolationScope:()=>({clearBreadcrumbs:()=>crumbs.splice(0),getUser:()=>current}),getCurrentScope:()=>({clearBreadcrumbs:()=>crumbs.splice(0)}),addBreadcrumb:(crumb:any)=>crumbs.push(crumb),withScope:(fn:any)=>fn({setUser:(value:any)=>users.push(value)}),captureException:(error:any)=>errors.push(error),startSpan:(value:any,task:any)=>{spans.push(value);return task();}};
 const source=readFileSync(new URL('../src/sentry.ts',import.meta.url),'utf8').replace(/^import .*$/gm,'');const code=ts.transpile(source,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});const exports:any={};new Function('env','exports',`with(env){${code}}`)({Sentry,Platform:{OS:'android'},Constants:{nativeAppVersion:'1.2.2',nativeBuildVersion:'32'},Updates:{updateId:'a'.repeat(8)+'-aaaa-aaaa-aaaa-'+ 'a'.repeat(12)},__DEV__:false,process:{env:{}},scrubSentryEvent,scrubSentrySpan,scrubBreadcrumb,diagnosticRoute,useLayoutEffect:(fn:any)=>{cleanup?.();cleanup=fn();},configureSyncDiagnostics:(fn:any)=>observer=fn,configureRequestTracing:(fn:any)=>tracer=fn},exports);
 return{options,users,crumbs,errors,spans,user:exports.useSentryUser,sync:(value:any,error?:any)=>observer(value,error),trace:(value:any,task:any)=>tracer(value,task)};
}
test('production setup enables 100% tracing, safe breadcrumbs and span/transaction privacy filters',()=>{
 const h=setup();assert.equal(h.options.tracesSampleRate,1);assert.equal(h.options.enableAutoPerformanceTracing,true);assert.equal(h.options.maxBreadcrumbs,50);assert.equal(h.options.sendDefaultPii,false);assert.equal(h.options.beforeSend,scrubSentryEvent);assert.equal(h.options.beforeSendTransaction,scrubSentryEvent);assert.equal(h.options.beforeSendSpan,scrubSentrySpan);
 assert.equal(h.options.beforeBreadcrumb({category:'console',message:'private'}),null);
});
test('account changes clear identity/breadcrumbs and stale sync failures cannot contaminate the new user',()=>{
 const h=setup();h.user('80');const failure=Error('private bill');h.sync({phase:'failed',userId:'80',pending_count:2,status:409},failure);assert.equal(h.errors.length,1);assert.equal(h.crumbs.length,1);
 h.user('59');assert.equal(h.crumbs.length,0);h.sync({phase:'failed',userId:'80',pending_count:1},failure);assert.equal(h.errors.length,1);
 h.user(null);assert.equal(h.users.at(-1),null);h.sync({phase:'failed',userId:'59',pending_count:1},failure);assert.equal(h.errors.length,1);
});
test('network spans bind the request account and use sanitized route names',async()=>{
 const h=setup();h.user('80');await h.trace({userId:'80',method:'POST',route:'/api/v1/groups/private/expenses?token=secret'},async()=> 'ok');assert.equal(h.spans[0].name,'POST /api/v1/groups/:id/expenses');assert.equal(h.spans[0].op,'http.client');assert.deepEqual(h.users.at(-1),{id:'80'});
});
test('actual App clears diagnostics identity before auth resolves, during auth holds, and after expiry',()=>{
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression='';function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='useSentryUser')expression=node.arguments[0].getText(source);ts.forEachChild(node,visit);}visit(source);assert.ok(expression);const evaluate=new Function('ready','authHeld','expired','session',`return (${expression});`);
 assert.equal(evaluate(true,false,false,{userId:'80'}),'80');for(const flags of [[false,false,false],[true,true,false],[true,false,true]])assert.equal(evaluate(...flags,{userId:'80'}),null);
});
