import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('Avatar.tsx',readFileSync(new URL('../src/Avatar.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export (?:default )?/,'')).join('\n');
function fixture(){let cursor=0;const states:any[]=[],effects:(()=>void)[]=[];let session:any=null;
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})};
 const env={React,View:'View',Image:'Image',createContext:()=>({}),useContext:()=>session,useState:(initial:any)=>{const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],(v:any)=>states[i]=v];},useEffect:(fn:()=>void)=>effects.push(fn),cachedProfilePhoto:async()=> 'file:///synthetic-photo'};
 const render=new Function('env',`with(env){${ts.transpile(body,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return Avatar;}`)(env);
 return {render:(props:any)=>{cursor=0;return render(props);},setSession:(value:any)=>session=value,effects};
}
test('photo, initials and icon placeholders use the same rounded square at every size',()=>{
 for(const size of [24,36,64,96]){
  const app=fixture(),fallback=app.render({size,children:'OS',backgroundColor:'#222'}),photo=app.render({size,source:{uri:'https://synthetic.invalid/photo'},children:'OS',backgroundColor:'#222'});
  assert.deepEqual(photo.props.style,fallback.props.style);assert.equal(photo.props.style.borderRadius,size/3);assert.equal(photo.props.style.width,size);assert.equal(photo.props.style.height,size);assert.equal(photo.props.style.overflow,'hidden');assert.equal(photo.props.style.flexShrink,0);
  assert.equal(photo.children[0].type,'Image');assert.equal(photo.children[0].props.resizeMode,'cover');assert.equal(fallback.children[0],'OS');
 }
});
test('failed photos fall back inside the same frame and decorative avatars remain unfocusable',()=>{
 const app=fixture(),props={size:64,source:{uri:'https://synthetic.invalid/missing'},children:'OS'};
 const image=app.render(props);image.children[0].props.onError();const fallback=app.render(props);
 assert.deepEqual(fallback.props.style,image.props.style);assert.equal(fallback.children[0],'OS');assert.equal(fallback.props.accessible,false);
 const labeled=app.render({...props,label:'Your profile photo'});assert.equal(labeled.props.accessibilityRole,'image');assert.equal(labeled.props.accessibilityLabel,'Your profile photo');
});
test('rows, profile editor and legacy media previews all use the shared avatar',()=>{
 const read=(name:string)=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
 for(const name of ['ui.tsx','ProfilePhoto.tsx','PrivateMediaThumbnail.tsx','PrivateMediaImage.web.tsx']){
  const text=read(name);assert.match(text,/from '\.\/Avatar'/);assert.doesNotMatch(text,/borderRadius: (?:size \/ 2|32)/);
 }
});
