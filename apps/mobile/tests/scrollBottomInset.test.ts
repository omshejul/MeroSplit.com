import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
test('full-page footer delegates the physical inset to keyboard-aware safe area only on iOS',()=>{
 const source=readFileSync(new URL('../src/ScrollBottomInset.tsx',import.meta.url),'utf8').replace(/^import .*$/mg,'').replace(/^export (?:default )?/mg,'');
 const code=ts.transpile(source,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
 for(const OS of ['ios','android','web']){
  const React={createElement:(type:any,props:any)=>({type,props})};
  const render=new Function('env',`with(env){${code};return ScrollBottomInset;}`)({React,Platform:{OS},BottomSafeArea:'KeyboardAwareSafeArea'});
  const result=render();if(OS==='ios'){assert.equal(result.type,'KeyboardAwareSafeArea');assert.equal(result.props.style.flex,0);}else assert.equal(result,null);
 }
});
