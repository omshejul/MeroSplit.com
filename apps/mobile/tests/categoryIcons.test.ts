import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {categoryIcon,categoryIcons,categoryMeaning} from '../src/categoryIcons.ts';

test('only known expense categories select installed icon names',()=>{
 for(const category of Object.keys(categoryIcons))assert.equal(categoryIcon(category),category);
 assert.equal(categoryIcon(' Food '),'food');
 assert.ok(Object.keys(categoryIcons).length >= 70);
 for(const key of Object.keys(categoryIcons)) assert.ok(categoryMeaning(key), key);
 assert.equal(categoryIcon('electricity'),'electricity');
 assert.equal(categoryIcon('medicine'),'medicine');
 for(const value of [null,undefined,'','general','other','pending','uncertain','https://untrusted.invalid/icon','invented'])assert.equal(categoryIcon(value),'bill');
});


test('transaction icon is a fixed decorative slot with no extra focus stop',()=>{
 const file=new URL('../src/TransactionIcon.tsx',import.meta.url);
 const source=readFileSync(file,'utf8');
 const body=source.split('export default ')[1];
 const jsx=ts.transpile(body+';return TransactionIcon;', {target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props,children})};
 const component=new Function('React','View','Icon','useUI',jsx)(React,'View','Icon',()=>({palette:{muted:'#888'}}));
 const icon=component({name:'water'});
 assert.equal(icon.props.style.width,20);assert.equal(icon.props.style.flexShrink,0);
 assert.equal(icon.props.accessible,false);assert.equal(icon.props['aria-hidden'],true);assert.equal(icon.props.importantForAccessibility,'no-hide-descendants');
 assert.equal(icon.children[0].props.color,'#888');assert.equal(icon.children[0].props.size,18);assert.equal(icon.children[0].props.name,'water');
});
