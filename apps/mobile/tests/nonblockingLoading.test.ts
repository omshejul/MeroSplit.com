import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const app=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const content=app.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='AppContent') as ts.FunctionDeclaration;
function production(name:string,env:any){const n=content.body!.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)!;return new Function('env',`with(env){${ts.transpile(n.getText(app),{target:ts.ScriptTarget.ES2022})};return ${name};}`)(env);}
test('header keeps actionable status without global progress or an empty slot',()=>{
 const source=readFileSync(new URL('../src/AppNavigation.tsx',import.meta.url),'utf8');
 const parsed=ts.createSourceFile('header.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ScreenHeader')!;
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})};
 const env={React,View:'View',Text:'Text',IconAction:'IconAction',ActivityIndicator:'Spinner',useUI:()=>({palette:{}}),styles:{header:{},titleArea:{},title:{},working:{width:44,height:44}}};
 const render=new Function('env',`with(env){${ts.transpile(fn.getText(parsed),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}).replace('export ','')};return ScreenHeader;}`)(env);
 const nodes=(n:any):any[]=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'?[n,...nodes(n.children)]:[];
 const status=React.createElement('Spinner',{});
 for(const busy of [false,true]){const tree=render({title:'Group settings',busy,status});assert.equal(nodes(tree).filter(n=>n.type==='Spinner').length,1);}
 const bill=render({title:'Lunch',showTitle:false,busy:false,onBack(){},status});assert.equal(nodes(bill).filter(n=>n.type==='Text').length,0);assert.equal(nodes(bill).filter(n=>n.type==='IconAction').length,1);assert.equal(nodes(bill).filter(n=>n.type==='Spinner').length,1);
 const idle=render({title:'Group settings',busy:false}),loading=render({title:'Group settings',busy:true});
 assert.equal(nodes(idle).filter(n=>n.props.style===env.styles.working).length,0,'idle header reserves no blank status slot');
 assert.equal(nodes(loading).filter(n=>n.type==='Spinner').length,0);
 const feedback=render({title:'Groups',busy:false,onFeedback(){}});
 assert.equal(feedback.children.filter(Boolean).at(-1).props.label,'Feedback','rightmost action sits at the trailing padding');
 const workingFeedback=render({title:'Groups',busy:true,onFeedback(){}});
 assert.equal(workingFeedback.children.filter(Boolean).at(-1).props.label,'Feedback','progress never pushes the rightmost action inward');
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
  assert.deepEqual(area.props.edges,os==='ios'?['top','left','right']:['top','left','right','bottom']);
  assert.equal(area.children[0].children[0].props.style.flex,1,'absolute controls follow the keyboard-resized inner container');
  assert.equal(area.children[0].props.behavior,os==='ios'?'padding':undefined,'Android uses OS resize without double keyboard adjustment');
 }
});

test('Me update safety evaluates without retired refresh state and waits for background reads',()=>{
 let expression='';function visit(n:ts.Node){if(!expression&&ts.isBinaryExpression(n)&&n.left.getText(app)==='updateSafe.current')expression=n.right.getText(app);ts.forEachChild(n,visit);}visit(content);assert.ok(expression);
 const check=new Function('env',`with(env){return ${expression};}`);
 const env={ready:true,session:{},expired:false,authHeld:false,foreground:true,screen:'home',tab:'Account',busy:false,reading:0,pulling:false,syncing:false,storageError:'',appLink:null,emailEntry:null,feedbackOpen:false,alertOpen:false,upiSetup:false,pushInvitationOpen:false,returnAttemptId:null,returns:[],reviewCommand:null,newPersonInvite:null,pushTarget:null};
 assert.equal(check(env),true);assert.equal(check({...env,reading:1}),false);assert.equal(check({...env,pulling:true}),false);assert.equal(check({...env,pushInvitationOpen:true}),false);
});
