import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function picker(supported = true, granted = true, canceled = false) {
 const calls:string[]=[];
 const source=readFileSync(new URL('../src/mediaPlatform.ts',import.meta.url),'utf8').replaceAll("await import('expo-file-system')",'fileSystem').replaceAll("await import('expo-image-picker')",'imagePicker').replaceAll("await import('./cameraSupport')",'camera');
 const ast=ts.createSourceFile('mediaPlatform.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const body=ast.statements.filter(n=>!ts.isImportDeclaration(n)&&!ts.isExportDeclaration(n)).map(n=>n.getText(ast).replace(/^export /,'')).join('\n');
 const env={camera:{canTakePhoto:()=>supported},fileSystem:{File:class {size=100;},Paths:{cache:{uri:'file:///cache'}}},imagePicker:{UIImagePickerPreferredAssetRepresentationMode:{Compatible:'compatible'},requestCameraPermissionsAsync:async()=>{calls.push('permission');return{granted,canAskAgain:false}},launchCameraAsync:async(options:any)=>{calls.push('camera');assert.deepEqual(options.mediaTypes,['images']);return canceled?{canceled:true}:{canceled:false,assets:[{uri:'file:///cache/capture.jpg',fileName:null,mimeType:'image/jpeg'}]}},launchImageLibraryAsync:async()=>{calls.push('photos');return{canceled:true}}}};
 return{calls,pick:new Function('env',`with(env){${ts.transpile(body,{target:ts.ScriptTarget.ES2022})};return pickMedia}`)(env)};
}
test('camera selection requests permission, normalizes a receipt filename and reuses file validation',async()=>{
 const p=picker();const file=await p.pick('camera');assert.deepEqual(p.calls,['permission','camera']);assert.equal(file.type,'image/jpeg');assert.equal(file.size,100);assert.match(file.name,/^Receipt photo .*\.jpg$/);
});
test('old native builds never request camera access; denial and cancellation retain the draft',async()=>{
 const old=picker(false);await assert.rejects(()=>old.pick('camera'),/Update MeroSplit/);assert.deepEqual(old.calls,[]);
 const denied=picker(true,false);await assert.rejects(()=>denied.pick('camera'),/device settings/);assert.deepEqual(denied.calls,['permission']);
 const canceled=picker(true,true,true);assert.equal(await canceled.pick('camera'),null);assert.deepEqual(canceled.calls,['permission','camera']);
 const photos=picker();assert.equal(await photos.pick(true),null);assert.deepEqual(photos.calls,['photos']);
});

test('iOS builds through 33 do not expose the camera', () => {
  const source = readFileSync(new URL('../src/cameraSupport.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const load = new Function('exports', 'require', outputText);
  const canTakePhoto = (platform: string, nativeBuildVersion: string) => {
    const exports = { canTakePhoto: () => false };
    load(exports, (name: string) => name === 'expo'
      ? { requireOptionalNativeModule: () => ({ nativeBuildVersion }) }
      : { Platform: { OS: platform } });
    return exports.canTakePhoto();
  };

  assert.equal(canTakePhoto('ios', '32'), false);
  assert.equal(canTakePhoto('ios', '33'), false);
  assert.equal(canTakePhoto('ios', '34'), true);
  assert.equal(canTakePhoto('android', '33'), true);
  assert.equal(canTakePhoto('web', ''), true);
});
