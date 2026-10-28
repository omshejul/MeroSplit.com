import { withSharedUI } from './componentHarness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const file=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect='';
function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[0]?.getText(file).includes('prefetchRead<ActivityPage>'))effect=node.arguments[0].getText(file);ts.forEachChild(node,visit);}
visit(file);assert.ok(effect);
const run=(env:any)=>new Function('env',`with(env){${ts.transpile('const setup = '+effect,{target:ts.ScriptTarget.ES2022})}; return setup;}`)(withSharedUI(env))();
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){const session={token:'a'},calls:string[]=[],configs:any[]=[];let idle:()=>void=()=>{},page:any=null;
 const env:any={session,ready:true,foreground:true,online:true,expired:false,authHeld:false,busy:false,syncing:false,readScope:()=> 'scope',accountOwner:()=> 'owner',ownerRef:{current:'owner'},activeSessionRef:{current:session},activityOwner:{current:''},readPrefetch:{configure:(...v:any[])=>configs.push(v)},setTimeout:(f:()=>void,delay:number)=>{assert.equal(delay,600);idle=f;return 1;},clearTimeout(){idle=()=>{};},prefetchRead:async(_session:any,path:string)=>{calls.push(path);return path.startsWith('/activity')?{read_mode:'activity',items:[],next_cursor:null}:{};},setActivity:(fn:any)=>page=fn(page)};
 return {env,calls,configs,idle:()=>idle(),page:()=>page};
}
test('startup warms only first-page metadata after settling and hydrates Activity before a tap',async()=>{
 const app=fixture(),cleanup=run(app.env);assert.deepEqual(app.calls,[]);app.idle();await tick();
 assert.deepEqual(app.calls,['/activity?limit=50','/me','/me/notifications/preferences','/me/chat-conversations?limit=20']);
 assert.equal(app.page().firstPage,true);assert.equal(app.env.activityOwner.current,'owner');cleanup();
});
test('offline, background, auth hold, busy and sync states start no speculative work',()=>{
 for(const change of [{online:false},{foreground:false},{authHeld:true},{expired:true},{busy:true},{syncing:true},{ready:false}]){
  const app=fixture();Object.assign(app.env,change);run(app.env);app.idle();assert.deepEqual(app.calls,[]);assert.equal(app.configs.at(-1)[1],false);
 }
});
test('a late prefetch cannot publish into a changed account or replace loaded Activity pages',async()=>{
 const app=fixture();run(app.env);app.env.activeSessionRef.current={token:'new'};app.idle();await tick();assert.equal(app.page(),null);
 const current=fixture();run(current.env);current.idle();await tick();const first=current.page();current.idle();await tick();assert.equal(current.page(),first);
});
test('actual bill and payment row controls warm on hover/focus without triggering navigation',()=>{
 const parsed=ts.createSourceFile('GroupScreen.tsx',readFileSync(new URL('../src/GroupScreen.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='LogRow')!;
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props,children})};
 const render=new Function('env',`with(env){${ts.transpile(fn.getText(parsed),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return LogRow;}`)(withSharedUI({React,useUI:()=>({ui:{},palette:{}}),Button:'Button',LogDate:'LogDate',View:'View',s:{}}));
 let warmed=0,opened=0;const row=render({label:'Bill',busy:false,onPrefetch:()=>warmed++,onPress:()=>opened++});
 assert.equal(warmed,0);row.props.onHoverIn();row.props.onFocus();assert.equal(warmed,2);assert.equal(opened,0);row.props.onPress();assert.equal(opened,1);
});
