import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const read=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const parse=(path:string)=>ts.createSourceFile(path,read(path),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const app=parse('App.tsx');
function find(source:ts.SourceFile,predicate:(node:ts.Node)=>boolean){let result:ts.Node|undefined;function visit(node:ts.Node){if(predicate(node))result=node;ts.forEachChild(node,visit);}visit(source);return result;}
const main=find(app,node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(app)==='ScrollView'&&node.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(app)==='role'&&a.initializer?.getText(app)==='"main"')) as ts.JsxElement;
const footers=main.children.filter(child=>/Home(Create|Tab)Inset/.test(child.getText(app))).map(child=>child.getText(app));
const React={Fragment:'Fragment',createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})};
function evaluate(expression:string,env:Record<string,any>){const program=ts.transpile(`function render(){return (${expression});}`,{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022});return new Function('env',`with(env){${program};return render();}`)({React,HomeCreateInset:'NavigationInset',HomeTabInset:'NavigationInset',ScrollBottomInset:'PhysicalInset',...env});}
function count(value:any):number{return Array.isArray(value)?value.reduce((n,v)=>n+count(v),0):value&&typeof value==='object'?(value.type==='NavigationInset'?1:0)+count(value.children):0;}

test('all native home lists keep a navigation inset when create actions are absent',()=>{
 for(const tab of ['Groups','Friends','Account'])for(const showCreate of [false,true]){
  const result=evaluate(`<>${footers.join('')}</>`,{screen:'home',tab,showCreate});
  assert.equal(count(result),showCreate?0:1,`${tab}, create=${showCreate}: create footer owns its own navigation inset`);
 }
 assert.equal(count(evaluate(`<>${footers.join('')}</>`,{screen:'expenseDetail',showCreate:false})),0,'stack pages have no home tab overlay');
});

test('Activity places navigation clearance after inbox and pagination inside its virtualized list',()=>{
 const source=parse('src/ActivityScreen.tsx');const attribute=find(source,node=>ts.isJsxAttribute(node)&&node.name.getText(source)==='ListFooterComponent') as ts.JsxAttribute;
 const expression=(attribute.initializer as ts.JsxExpression).expression!.getText(source);
 assert.equal(count(evaluate(expression,{footer:'Inbox',PaginationFooter:'PaginationFooter',paging:{},s:{message:{}}})),1);
});

test('bill list bottom spacing grows with the measured floating action',()=>{
 const source=parse('src/GroupScreen.tsx');const attribute=find(source,node=>ts.isJsxAttribute(node)&&node.name.getText(source)==='contentContainerStyle'&&node.getText(source).includes('paddingBottom')) as ts.JsxAttribute;
 const value=evaluate((attribute.initializer as ts.JsxExpression).expression!.getText(source),{pageContentStyle:{paddingBottom:24},bottomClearance:196});
 assert.ok(Object.assign({},...value).paddingBottom>=196,'large-text action cannot cover the last bill');
});
