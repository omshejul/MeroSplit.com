import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const read=(name:string)=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const source=ts.createSourceFile('nav.tsx',read('src/AppNavigation.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function component(name:string,os:string){
 const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)!;
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})};
 const styles:any={floating:{position:'absolute',bottom:0,paddingBottom:16},floatingContent:{},tabs:{},title:{}};
 return new Function('env',`with(env){${ts.transpile(fn.getText(source),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}).replace('export ','')};return ${name};}`)({React,Platform:{OS:os},View:'View',SafeAreaView:'SafeAreaView',BottomSafeArea:'BottomSafeArea',Button:'Button',TabBarSurface:'TabBarSurface',TabButton:'TabButton',tabs:[],styles,pageWidthStyle:{}});
}
test('only sticky controls consume the iOS bottom inset, with unchanged Android/web placement',()=>{
 for(const os of ['ios','android','web']){
  const floating=component('AddExpenseButton',os)({disabled:false,onPress(){}}),tabs=component('AppTabs',os)({selected:'Groups',busy:false,onSelect(){}});
  assert.equal(floating.type,'BottomSafeArea');assert.equal(tabs.type,'BottomSafeArea');
  assert.equal(floating.props.style.bottom,0);assert.equal(floating.props.style.paddingBottom,16);assert.equal(floating.props.pointerEvents,'box-none');
 }
});
test('all full-page iOS scrollers request UIKit safe content insets instead of clipping their viewport',()=>{
 for(const file of ['src/GroupScreen.tsx','src/ActivityScreen.tsx','src/ExpenseVersionHistory.tsx','src/SignInLayout.tsx','src/GroupJoinDialog.tsx','src/EmailLinkScreens.tsx'])assert.match(read(file),/contentInsetAdjustmentBehavior="automatic"/,file);
 assert.match(read('App.tsx'),/contentInsetAdjustmentBehavior=\{Platform.OS === 'ios' \? 'automatic' : undefined\}/);
 assert.match(read('src/BillChatScreen.tsx'),/<BottomSafeArea/,'chat composer owns its inset below the list');
});

test('bottom controls drop the home-indicator inset with the iOS keyboard, then restore it',()=>{
 const source=read('src/BottomSafeArea.tsx').replace(/^import .*$/mg,'').replace('export default ','');
 const React={createElement:(type:any,props:any)=>({type,props})};
 for(const os of ['ios','android','web']){
  let visible=false;const listeners:any={};let cleanup:any;
  const render=new Function('env',`with(env){${ts.transpile(source,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return BottomSafeArea;}`)({React,SafeAreaView:'SafeAreaView',Platform:{OS:os},Keyboard:{isVisible:()=>false,scheduleLayoutAnimation(){},addListener:(name:string,fn:any)=>{listeners[name]=fn;return{remove(){delete listeners[name];}};}},useState:()=>[visible,(v:boolean)=>visible=v],useEffect:(fn:any)=>{cleanup=fn();}});
  assert.deepEqual(render({}).props.edges,os==='ios'?['bottom']:[]);
  if(os==='ios'){listeners.keyboardWillShow({endCoordinates:{height:328}});assert.deepEqual(render({}).props.edges,[]);listeners.keyboardWillHide({endCoordinates:{height:0}});assert.deepEqual(render({}).props.edges,['bottom']);cleanup();assert.deepEqual(Object.keys(listeners),[]);}
  else assert.deepEqual(Object.keys(listeners),[]);
 }
});
