import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const app=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const content=app.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='AppContent') as ts.FunctionDeclaration;
function production(name:string,env:any){const n=content.body!.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)!;return new Function('env',`with(env){${ts.transpile(n.getText(app),{target:ts.ScriptTarget.ES2022})};return ${name};}`)(env);}
test('refresh can remain pending while save lock and navigation stay available',async()=>{
 let reads=0,resolve!:()=>void;const pending=new Promise<void>(r=>resolve=r);
 const lock={current:false};const env={setBackgroundReads:(f:any)=>reads=f(reads),ApiError:class extends Error{},setExpired(){},lock};
 const run=production('background',env);const work=run(()=>pending);
 assert.equal(reads,1);assert.equal(lock.current,false);resolve();await work;assert.equal(reads,0);
});
test('one fixed status slot owns progress even when an action and sync overlap',()=>{
 const source=readFileSync(new URL('../src/AppNavigation.tsx',import.meta.url),'utf8');
 const parsed=ts.createSourceFile('header.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ScreenHeader')!;
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})};
 const env={React,View:'View',Text:'Text',IconAction:'IconAction',ActivityIndicator:'Spinner',useUI:()=>({palette:{}}),styles:{header:{},titleArea:{},title:{},working:{width:44,height:44}}};
 const render=new Function('env',`with(env){${ts.transpile(fn.getText(parsed),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}).replace('export ','')};return ScreenHeader;}`)(env);
 const nodes=(n:any):any[]=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'?[n,...nodes(n.children)]:[];
 const status=React.createElement('Spinner',{});
 for(const busy of [false,true]){const tree=render({title:'Group settings',busy,status});assert.equal(nodes(tree).filter(n=>n.type==='Spinner').length,1);}
 const idle=render({title:'Group settings',busy:false}),loading=render({title:'Group settings',busy:true});
 assert.deepEqual(idle.children.map((n:any)=>n?.type),loading.children.map((n:any)=>n?.type));
});

test('edge-to-edge frame paints the window and protects all content edges once',()=>{
 const parsed=ts.createSourceFile('frame.tsx',readFileSync(new URL('../src/AppNavigation.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='AppFrame')!;
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})};
 const Platform={OS:'ios'};
 const render=new Function('env',`with(env){${ts.transpile(fn.getText(parsed),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}).replace('export ','')};return AppFrame;}`)({React,Platform,View:'View',SafeAreaView:'SafeAreaView',StatusBar:'StatusBar',KeyboardAvoidingView:'KeyboardAvoidingView',useUI:()=>({palette:{background:'#000'},dark:true})});
 for(const os of ['ios','android','web'])for(const nativeTabs of [false,true]){
  Platform.OS=os;const tree=render({children:'content',nativeTabs});
  assert.equal(tree.type,'View');assert.equal(tree.props.style.flex,1);assert.equal(tree.props.style.backgroundColor,'#000');
  const area=tree.children.find((n:any)=>n.type==='SafeAreaView');
  assert.deepEqual(area.props.edges,nativeTabs&&os==='ios'?['top','left','right']:['top','left','right','bottom']);
  assert.equal(area.children[0].props.behavior,os==='ios'?'padding':undefined,'Android uses OS resize without double keyboard adjustment');
 }
});

test('actual activity refresh deduplicates pending reads without blocking taps and ignores a departed tab',async()=>{
 let resolve!:(value:any)=>void,requests=0,reads=0,published=0;
 const response=new Promise<any>(r=>resolve=r),session={token:'synthetic'};
 const env:any={session,activity:null,browseCurrent:{current:'activity-tab'},activeSessionRef:{current:session},activityOwner:{current:''},activityRefresh:{current:null},setActivityError(){},accountOwner:()=> 'owner',setActivity(){published++;},request:()=>{requests++;return response;},perform(){throw Error('Loading must not acquire the save lock');},setBackgroundReads:(f:any)=>reads=f(reads),ApiError:class extends Error{},setExpired(){}};
 env.background=production('background',env);
 const refresh=production('refreshActivity',env),one=refresh(),two=refresh();
 assert.equal(requests,1);assert.equal(reads,1);
 env.browseCurrent.current='groups-tab';
 resolve({read_mode:'activity',items:[{id:'synthetic-row'}],revision:'r',next_cursor:null});
 await Promise.all([one,two]);assert.equal(published,0);assert.equal(reads,0);assert.equal(env.activityRefresh.current,null);
});

test('overlapping background work keeps one progress state and clears it after failures',async()=>{
 let reads=0,expired=false,resolve!:()=>void;class ApiError extends Error{status=401;}
 const env={setBackgroundReads:(f:any)=>reads=f(reads),ApiError,setExpired:(value:boolean)=>expired=value};
 const background=production('background',env),pending=new Promise<void>(r=>resolve=r),first=background(()=>pending);
 await assert.rejects(background(async()=>{throw new ApiError('Expired');}));
 assert.equal(reads,1);assert.equal(expired,true);resolve();await first;assert.equal(reads,0);
});
