import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/HomeTabInset.tsx',import.meta.url),'utf8').replace(/^import .*$/mg,'').replace(/^export (?:default )?/mg,'');
const code=ts.transpile(source,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
test('only floating native iOS tabs add their real screen inset; fallback tabs add none',()=>{
 for(const OS of ['ios','android','web'])for(const Version of ['18.7','25.0','26.0','27.0']){
  let loaded=0;const React={createElement:(type:any,props:any,...children:any[]):any=>typeof type==='function'?type({...props,children:children.length?children:undefined}):({type,props,children})};
  const render=new Function('env',`with(env){${code};return HomeTabInset;}`)({React,Platform:{OS,Version},require:(name:string)=>{assert.equal(name,'react-native-screens/experimental');loaded++;return{SafeAreaView:'NativeScreenInset'};}});
  const result=render(),native=OS==='ios'&&parseInt(Version,10)>=26;
  assert.equal(loaded,native?1:0);
  if(native){assert.equal(result.type,'NativeScreenInset');assert.deepEqual(result.props.edges,{bottom:true});assert.equal(result.props.style.flex,0);assert.equal(result.props.collapsable,false);assert.equal(result.props.pointerEvents,'none');}
  else assert.equal(result,null);
 }
});

test('full-page footer delegates the physical inset to keyboard-aware safe area only on iOS',()=>{
 const source=readFileSync(new URL('../src/ScrollBottomInset.tsx',import.meta.url),'utf8').replace(/^import .*$/mg,'').replace(/^export (?:default )?/mg,'');
 const code=ts.transpile(source,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
 for(const OS of ['ios','android','web']){
  const React={createElement:(type:any,props:any)=>({type,props})};
  const render=new Function('env',`with(env){${code};return ScrollBottomInset;}`)({React,Platform:{OS},BottomSafeArea:'KeyboardAwareSafeArea'});
  const result=render();if(OS==='ios'){assert.equal(result.type,'KeyboardAwareSafeArea');assert.equal(result.props.style.flex,0);}else assert.equal(result,null);
 }
});
