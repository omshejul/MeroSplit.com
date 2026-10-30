import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createNativeSheetStore} from '../src/nativeSheetStore.ts';

const file=ts.createSourceFile('NativeSheet.tsx',readFileSync(new URL('../src/NativeSheet.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const code=ts.transpile(file.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(file).replace(/^export (?:default )?/, '')).join('\n'),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
function harness(store=createNativeSheetStore<any>()){
 let cursor=0,prevent=false,onPrevent:any,focused=true;const slots:any[]=[],effects:(()=>void)[]=[],cleanups=new Map<number,()=>void>(),actions:any[]=[],options:any[]=[];
 let state:any={key:'test-stack',index:0,routes:[{name:'expense',key:'form',params:{groupId:'g'}}]};
 const navigation={setOptions:(value:any)=>{options.push(value);},getState:()=>state,isFocused:()=>focused,dispatch:(action:any)=>{actions.push(action);if(action.type==='PUSH')state={...state,index:1,routes:[state.routes[0],{key:'overlay',name:'sheet',params:action.payload.params}]};},goBack:()=>{actions.push({type:'BACK'});state={...state,index:0,routes:state.routes.slice(0,1)};}};
 const effect=(fn:()=>void|(()=>void),deps?:any[])=>{const index=cursor++,previous=slots[index];if(!deps||!previous||deps.some((v,i)=>!Object.is(v,previous[i]))){slots[index]=deps;effects.push(()=>{cleanups.get(index)?.();const cleanup=fn();if(cleanup)cleanups.set(index,cleanup);else cleanups.delete(index);});}};
 const env={Platform:{OS:'android'},React:{createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})},createContext:()=>({Provider:'Provider'}),createNativeSheetStore,Button:'Button',useContext:()=>store,useNavigation:()=>navigation,useRoute:()=>state.routes[0],StackActions:{pop:(count:number)=>({type:'POP',payload:{count}}),push:(name:string,params:any)=>({type:'PUSH',payload:{name,params}})},useId:()=>':sheet:',useRef:(initial:any)=>slots[cursor++]??={current:initial},useState:(initial:any)=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],(value:any)=>{slots[i]=value;}];},useEffect:effect,useLayoutEffect:effect,useSyncExternalStore:(_subscribe:any,snapshot:()=>any)=>snapshot(),usePreventRemove:(enabled:boolean,fn:any)=>{prevent=enabled;onPrevent=fn;}};
 const api=new Function('env',`with(env){ const useLoading = env.useLoading ?? (() => {}), LoadingOverlay = env.LoadingOverlay ?? 'LoadingOverlay';${code};return {NativeSheet,NativeSheetScreen};}`)(env);
 return {store,actions,options,navigation,render:(name:'NativeSheet'|'NativeSheetScreen',props:any)=>{cursor=0;const tree=api[name](props);effects.splice(0).forEach(run=>run());return tree;},unmount:()=>{[...cleanups.values()].reverse().forEach(run=>run());cleanups.clear();},remove:(action:any)=>{if(prevent)onPrevent({data:{action}});else navigation.dispatch(action);},prevented:()=>prevent,focus:(value:boolean)=>{focused=value;},state:(value:any)=>{state=value;}};
}

test('controlled sheet content updates without pushing another route or moving form values into params',()=>{
 const h=harness(),dismiss=()=>{},first={field:'12.50'},props={visible:false,disabled:false,onDismiss:dismiss,children:first};
 h.render('NativeSheet',props);assert.equal(h.actions.length,0);
 h.render('NativeSheet',{...props,visible:true});assert.equal(h.actions.length,1);assert.equal(h.store.get(':sheet:').children,first);
 assert.deepEqual(h.actions[0].payload.params,{groupId:'g',sheetId:':sheet:',ownerKey:'form'});
 const next={field:'37.50'};h.render('NativeSheet',{...props,visible:true,disabled:true,children:next});assert.equal(h.actions.length,1);assert.equal(h.store.get(':sheet:').children,next);assert.equal(h.store.get(':sheet:').disabled,true);
 h.render('NativeSheet',props);assert.equal(h.store.get(':sheet:'),undefined);assert.equal(h.actions.at(-1).type,'POP');assert.equal(h.actions.at(-1).source,'overlay');assert.equal(h.actions.at(-1).target,'test-stack');h.unmount();
});

test('native dismissal closes only its registered owner, and a removed owner cannot pop another screen',()=>{
 const store=createNativeSheetStore<any>();let dismissed=0;store.set('id',{children:'fields',disabled:false,onDismiss:()=>dismissed++});const screen=harness(store);
 screen.render('NativeSheetScreen',{route:{params:{sheetId:'id'}},navigation:screen.navigation,blocked:false});screen.unmount();assert.equal(dismissed,1);assert.equal(store.get('id'),undefined);
 const owner=harness();owner.render('NativeSheet',{visible:true,disabled:false,onDismiss(){},children:'fields'});owner.state({index:0,routes:[{name:'home',key:'new-account'}]});owner.unmount();assert.equal(owner.actions.length,1,'no Back on a replacement route');assert.equal(owner.store.get(':sheet:'),undefined);
});

test('busy sheets block user dismissal and replay an app action only after the lock releases while focused',()=>{
 for(const focused of [true,false]){
  const h=harness(),props={route:{params:{sheetId:'id'}},navigation:h.navigation,blocked:false};h.store.set('id',{children:'fields',disabled:true,onDismiss(){}});h.render('NativeSheetScreen',props);assert.equal(h.prevented(),true);
  h.remove({type:'GO_BACK'});assert.equal(h.actions.length,0);
  const action={type:'POP',appNavigation:true};h.remove(action);h.render('NativeSheetScreen',props);assert.equal(h.actions.length,0);
  h.focus(focused);h.store.set('id',{children:'fields',disabled:false,onDismiss(){}});h.render('NativeSheetScreen',props);assert.equal(h.prevented(),false);assert.equal(h.actions.length,focused?1:0);if(focused)assert.equal(h.actions[0],action);h.unmount();
 }
});


test('person sheets keep Done in the header on every platform and disable empty selections',()=>{
 const source=ts.createSourceFile('PeopleSheet.tsx',readFileSync(new URL('../src/PeopleSheet.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const code=ts.transpile(source.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(source).replace(/^export (?:default )?/, '')).join('\n'),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
 const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.children)]:[];
 for(const OS of ['android','ios','web']){
  const env={React:{createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})},Platform:{OS},NativeSheet:'NativeSheet',Modal:'Modal',DialogFocus:'DialogFocus',KeyboardAvoidingView:'KeyboardAvoidingView',ScrollView:'ScrollView',View:'View',Text:'Text',Icon:'Icon',Button:'Button',RowGroup:'RowGroup',StyleSheet:{absoluteFill:{},hairlineWidth:1},useState:(value:any)=>[value,()=>{}],useWindowDimensions:()=>({height:852,width:393}),useSafeAreaInsets:()=>({top:44,bottom:34}),useUI:()=>({ui:{},palette:{},motion:{enabled:false}})};
  const component=new Function('env',`with(env){ const useLoading = env.useLoading ?? (() => {}), LoadingOverlay = env.LoadingOverlay ?? 'LoadingOverlay';${code};return PeopleSheet;}`)(env);
  const tree=component({visible:true,onDismiss(){},title:'Split expense',icon:'people',count:0,disabled:false,maxHeight:800,children:'rows'});
  const body=nodes(tree);if(OS==='android')assert.equal(tree.type,'NativeSheet');if(OS==='ios'){assert.equal(tree.type,'Modal');assert.equal(tree.props.presentationStyle,'pageSheet');assert.equal(tree.props.visible,true);assert.equal(tree.props.allowSwipeDismissal,true);}const done=body.find(node=>node.props.accessibilityLabel==='Apply split');assert.equal(done.props.title,'Done');assert.equal(done.props.disabled,true);assert.ok(body.find(node=>node.type==='ScrollView').props.nestedScrollEnabled);assert.equal(body.find(node=>node.type==='ScrollView').props.contentContainerStyle.paddingBottom,46,'modal rows clear the physical bottom inset without a native-stack provider');
  if(OS==='web')assert.equal(component({visible:false,disabled:false,maxHeight:800}),null);
  if(OS==='ios'){
   let dismissals=0;
   const busy=component({visible:true,onDismiss:()=>dismissals++,title:'Split expense',icon:'people',count:3,disabled:true,maxHeight:800,children:'rows'});
   assert.equal(busy.props.allowSwipeDismissal,false);busy.props.onRequestClose();assert.equal(dismissals,0);
   const ready=component({visible:true,onDismiss:()=>dismissals++,title:'Who paid?',icon:'pay',count:2,disabled:false,maxHeight:800,children:'rows'});
   ready.props.onRequestClose();assert.equal(dismissals,1);
   nodes(ready).find(node=>node.props.accessibilityLabel==='Apply payers').props.onPress();assert.equal(dismissals,2);
   const closed=component({visible:false,disabled:false,maxHeight:800});assert.equal(closed.type,'Modal');assert.equal(closed.props.visible,false,'iOS owns hiding and unmounting its native presentation');
  }
 }
});


test('native Back notifies the form once and owner cleanup cannot issue a second pop from stale state',()=>{
 const store=createNativeSheetStore<any>(),owner=harness(store),screen=harness(store);let dismissed=0;const props={visible:true,disabled:false,onDismiss:()=>dismissed++,children:'fields'};
 owner.render('NativeSheet',props);screen.render('NativeSheetScreen',{route:{params:{sheetId:':sheet:'}},navigation:screen.navigation,blocked:false});screen.unmount();assert.equal(dismissed,1);
 owner.render('NativeSheet',{...props,visible:false});assert.equal(owner.actions.length,1,'only the original push, even when owner getState still contains the removed sheet');owner.unmount();
});
