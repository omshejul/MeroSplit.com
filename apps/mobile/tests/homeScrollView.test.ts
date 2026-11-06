import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/HomeScrollView.tsx', import.meta.url), 'utf8').replace(/^import .*$/mg, '').replace(/^export (?:default )?/mg, '');
const code = ts.transpile(source, {target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
function fixture(native:boolean,bottom:number) {
 const env={React:{createElement:(type:any,props:any)=>({type,props})},ScrollView:'KeyboardScrollView',usesNativeHomeTabs:native,useSafeAreaInsets:()=>({bottom}),StyleSheet:{flatten:(styles:any)=>Array.isArray(styles)?Object.assign({},...styles):styles}};
 return new Function('env',`with(env){${code};return {HomeScrollView,useHomeTabScrollInsets};}`)(env);
}
test('native home viewport stays full height while content and indicators consume one actual tab inset',()=>{
 for(const bottom of [0,34,83,110])for(const clearance of [0,147,230]){
  const app=fixture(true,bottom),ref={current:null};
  const tree=app.HomeScrollView({home:true,bottomClearance:clearance,ref,style:{flex:1},contentInsetAdjustmentBehavior:'automatic',contentContainerStyle:{paddingBottom:24}});
  assert.equal(tree.props.contentInsetAdjustmentBehavior,'never');
  assert.deepEqual(tree.props.scrollIndicatorInsets,{bottom});
  assert.equal(Object.assign({},...tree.props.contentContainerStyle).paddingBottom,Math.max(24+bottom,clearance));
  assert.deepEqual(tree.props.style,{flex:1});assert.equal(tree.props.ref,ref);
  assert.equal(tree.props.home,undefined);assert.equal(tree.props.bottomClearance,undefined);
 }
});
test('native inset changes update clearance without a remount, and fallback/stack scroll behavior stays unchanged',()=>{
 for(const native of [false,true])for(const home of [false,true]){
  const app=fixture(native,90),tree=app.HomeScrollView({home,contentInsetAdjustmentBehavior:'automatic',scrollIndicatorInsets:{bottom:7},contentContainerStyle:{paddingBottom:24}});
  assert.equal(tree.props.contentInsetAdjustmentBehavior,native&&home?'never':'automatic');
  assert.equal(tree.props.scrollIndicatorInsets.bottom,native&&home?90:7);
  assert.equal(Object.assign({},...tree.props.contentContainerStyle).paddingBottom,native&&home?114:24);
 }
 assert.equal(fixture(true,83).useHomeTabScrollInsets().bottom,83);
 assert.equal(fixture(true,110).useHomeTabScrollInsets().bottom,110);
});
