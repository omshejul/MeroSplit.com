import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {categoryIcon,categoryIcons,categoryMeaning} from '../src/categoryIcons.ts';

test('only known expense categories select installed icon names',()=>{
 for(const category of Object.keys(categoryIcons))assert.equal(categoryIcon(category),categoryIcons[category as keyof typeof categoryIcons]);
 assert.equal(categoryIcon(' Food '),'food');
 assert.equal(Object.keys(categoryIcons).length, 20);
 for(const key of Object.keys(categoryIcons)) assert.ok(categoryMeaning(key), key);
 assert.equal(categoryIcon('electricity'),'utilities');
 assert.equal(categoryIcon('medicine'),'health');
 for(const key of ['garbage','wastecollection','recycling'])assert.equal(categoryIcon(key),'garbage');
 for(const value of [null,undefined,'','general','other','pending','uncertain','https://untrusted.invalid/icon','invented'])assert.equal(categoryIcon(value),'bill');
});

test('every server icon choice maps to the same bundled Hugeicons asset',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../../api/ledger/assets/expense-icons.json',import.meta.url),'utf8'));
 const categories=Object.fromEntries(Object.entries(catalog.options).map(([key,value])=>[key,(value as string[])[1]]));
 assert.deepEqual(new Set(Object.keys(categories)),new Set(Object.keys(categoryIcons)));
 for(const [old,key] of Object.entries(catalog.aliases))assert.equal(categoryIcon(old),categoryIcon(key as string));
 const source=ts.createSourceFile('ui.tsx',readFileSync(new URL('../src/ui.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let assets:ts.ObjectLiteralExpression|undefined;
 function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='icons'&&node.initializer&&ts.isObjectLiteralExpression(node.initializer))assets=node.initializer;ts.forEachChild(node,visit);}
 visit(source);
 const bundled=Object.fromEntries(assets!.properties.map(property=>{const item=property as ts.PropertyAssignment;return [item.name.getText(source),item.initializer.getText(source)];}));
 for(const [category,icon] of Object.entries(categories))assert.equal(bundled[categoryIcon(category)],icon,category);
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
