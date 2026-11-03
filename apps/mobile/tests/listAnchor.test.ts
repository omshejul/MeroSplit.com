import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('useListAnchor.ts',readFileSync(new URL('../src/useListAnchor.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const fn=source.statements.find(n=>ts.isFunctionDeclaration(n))!;
function harness(){
 const frames=new Map<number,()=>void>();
 const slots:any[]=[],effects:(()=>void)[]=[],moves:any[]=[],timers=new Map<number,()=>void>();let cursor=0,id=0;
 const env={requestAnimationFrame:(cb:()=>void)=>{frames.set(++id,cb);return id;},cancelAnimationFrame:(id:number)=>frames.delete(id),useRef:(value:any)=>slots[cursor++]??={current:value},useLayoutEffect:(callback:()=>void,deps:any[])=>{const i=cursor++,old=slots[i];if(!old||deps.some((d,j)=>d!==old.deps[j])){const slot=slots[i]={deps,cleanup:undefined as any};effects.push(()=>{old?.cleanup?.();slot.cleanup=callback();});}},setTimeout:(cb:()=>void)=>{timers.set(++id,cb);return id;},clearTimeout:(id:number)=>timers.delete(id)};
 const hook=new Function('env',`with(env){${ts.transpile(fn.getText(source).replace('export ',''),{target:ts.ScriptTarget.ES2022})};return useListAnchor;}`)(env);
 const list={current:{scrollToOffset:(v:any)=>moves.push(v)}};
 return {moves,render:(revision=1,active=true,animate=true,scope='g',flush=true)=>{cursor=0;const api=hook(list,revision,active,animate,scope);effects.splice(0).forEach(cb=>cb());while(flush&&frames.size){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(cb=>cb());}return api;},settle:()=>{const callbacks=[...timers.values()];timers.clear();callbacks.forEach(cb=>cb());}};
}
test('an inserted row above the visible bill receives one smooth correction, reduced motion stays immediate',()=>{
 for(const animate of [true,false]){const h=harness();let y=180;const api=h.render(1,true,animate);api.rowRef('bill')({measureInWindow:(done:any)=>done(0,y)});api.scrolled(1200);api.viewable(['bill']);y=300;h.render(2,true,animate);assert.deepEqual(h.moves,[{offset:1320,animated:animate}]);h.settle();h.render(3,true,animate);assert.equal(h.moves.length,1,'unchanged visible position needs no movement');}
});
test('returning from a hidden bill retains its measured anchor rather than the hidden layout',()=>{
 const h=harness();let y=180;const api=h.render();api.rowRef('bill')({measureInWindow:(done:any)=>done(0,y)});api.scrolled(1200);api.viewable(['bill']);h.render(2,false);y=0;api.scrolled(0);y=240;h.render(2,true);assert.deepEqual(h.moves,[{offset:1260,animated:true}]);
});
test('a removed first visible record uses the next visible record and a search clears old anchors',()=>{
 const h=harness();let y=250;const api=h.render();api.rowRef('first')({measureInWindow:(done:any)=>done(0,180)});api.rowRef('second')({measureInWindow:(done:any)=>done(0,y)});api.scrolled(1000);api.viewable(['first','second']);api.rowRef('first')(null);y=180;h.render(2);assert.deepEqual(h.moves,[{offset:930,animated:true}]);h.settle();y=500;h.render(3,true,true,'new search');assert.equal(h.moves.length,1);
});
test('a user drag cancels a late measurement so a correction cannot fight their scroll',()=>{
 const h=harness();let deferred:any,delay=false,y=180;const api=h.render();api.rowRef('bill')({measureInWindow:(done:any)=>{if(delay)deferred=done;else done(0,y);}});api.viewable(['bill']);delay=true;h.render(2);api.dragging();deferred(0,500);assert.deepEqual(h.moves,[]);
});


test('a second commit before layout cancels the first restoration and uses the final row position',()=>{
 const h=harness();let y=180;const api=h.render();api.rowRef('bill')({measureInWindow:(done:any)=>done(0,y)});api.scrolled(1200);api.viewable(['bill']);
 y=0;h.render(2,true,true,'g',false);y=300;h.render(3);assert.deepEqual(h.moves,[{offset:1320,animated:true}]);
});
