import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

function fixture(name:string){
 let cursor=0;const slots:any[]=[],effects:(()=>void)[]=[],animations:any[]=[];
 const hooks={
  useState(initial:any){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return [slots[i].value,(v:any)=>slots[i].value=typeof v==='function'?v(slots[i].value):v];},
  useRef(initial:any){const i=cursor++;return slots[i]??={current:initial};},
  useEffect(fn:()=>any,deps:any[]){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i].deps[j]))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
 };
 class Value{value:number;constructor(v:number){this.value=v;}setValue(v:number){this.value=v;}stopAnimation(){}interpolate(config:any){return{value:this,config};}}
 const Animated={Value,timing(value:Value,config:any){const a={value,config,stopped:false,done:undefined as any,start(done?:any){a.done=done;animations.push(a);},stop(){a.stopped=true;a.done?.({finished:false});}};return a;}};
 const exports:any={};runInNewContext(ts.transpile(readFileSync(new URL('../src/dialogTransition.ts',import.meta.url),'utf8'),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}),{exports,require:(id:string)=>id==='react'?hooks:{Animated,Easing:{out:(v:any)=>v,cubic:'cubic'},Platform:{OS:'ios'}}});
 return {animations,render(...args:any[]){cursor=0;const result=exports[name](...args);effects.splice(0).forEach(fn=>fn());return result;},finish(i=animations.length-1){const a=animations[i];a.value.setValue(a.config.toValue);a.done?.({finished:true});},unmount(){slots.forEach(s=>s?.cleanup?.());}};
}

test('dialog exit retains its modal scope until its own animation completes',()=>{
 const h=fixture('useDialogTransition');assert.equal(h.render(false,true).present,false);
 h.render(true,true);let state=h.render(true,true);assert.equal(state.present,true);assert.equal(h.animations.at(-1).config.duration,180);assert.equal(h.animations.at(-1).config.useNativeDriver,true);h.finish();
 state=h.render(false,true);assert.equal(state.present,true);assert.equal(h.animations.at(-1).config.duration,140);h.finish();assert.equal(h.render(false,true).present,false);h.unmount();
});
test('rapid reopen ignores a stale exit completion and cancels the old animation',()=>{
 const h=fixture('useDialogTransition');h.render(true,true);h.finish();h.render(false,true);const exit=h.animations.at(-1);
 h.render(true,true);assert.equal(exit.stopped,true);exit.done({finished:true});assert.equal(h.render(true,true).present,true);h.finish();assert.equal(h.render(true,true).opacity.value,1);h.unmount();
});
test('reduced motion presents opaque dialogs and closes immediately without a tween',()=>{
 const h=fixture('useDialogTransition');h.render(false,false);h.render(true,false);const open=h.render(true,false);
 assert.equal(open.present,true);assert.equal(open.opacity.value,1);assert.equal(open.translateY,0);h.render(false,false);assert.equal(h.render(false,false).present,false);assert.equal(h.animations.length,0);h.unmount();
});
test('dynamic body sizes animate only their viewport, clamp to keyboard bounds and stop on unmount',()=>{
 const h=fixture('useDialogBodySize');let body=h.render(300,true);body.onContentSizeChange(200,100);body=h.render(300,true);assert.equal(body.height.value,100);assert.equal(h.animations.length,0);
 body.onContentSizeChange(200,500);assert.equal(h.animations.at(-1).config.toValue,300);assert.equal(h.animations.at(-1).config.useNativeDriver,false);h.finish();
 body=h.render(180,true);assert.equal(h.animations.at(-1).config.toValue,180);h.finish();assert.equal(body.height.value,180);
 body=h.render(600,true);assert.equal(h.animations.at(-1).config.toValue,500);h.unmount();assert.equal(h.animations.at(-1).stopped,true);
});
test('switching to reduced motion settles an in-flight resize and preserves natural content height',()=>{
 const h=fixture('useDialogBodySize');let body=h.render(600,true);body.onContentSizeChange(200,100);body=h.render(600,true);body.onContentSizeChange(200,500);
 body=h.render(300,false);assert.equal(body.height.value,300);assert.equal(h.animations.at(-1).stopped,true);
 body=h.render(600,false);assert.equal(body.height.value,500);
 body=h.render(600,true);body.onContentSizeChange(200,300);assert.equal(h.animations.at(-1).config.toValue,300);h.finish();assert.equal(body.height.value,300);h.unmount();
});

test('initial zero measurement does not collapse the first visible content',()=>{
 const h=fixture('useDialogBodySize');let body=h.render(600,true);body.onContentSizeChange(200,0);body=h.render(600,true);assert.equal(body.height,undefined);
 body.onContentSizeChange(200,200);body=h.render(600,true);assert.equal(body.height.value,200);assert.equal(h.animations.length,0);h.unmount();
});
test('dialogs mounted already visible enter from their own opaque destination',()=>{
 const h=fixture('useDialogTransition');let state=h.render(true,true);assert.equal(state.opacity.value,0);h.finish();state=h.render(true,true);assert.equal(state.opacity.value,1);h.unmount();
});
