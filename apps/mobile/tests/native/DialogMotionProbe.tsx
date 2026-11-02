// Synthetic, offline UI acceptance entry. Never imported by production index.ts.
import React,{useEffect,useRef,useState} from 'react';
import {registerRootComponent} from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import {File,Paths} from 'expo-file-system';
import {Keyboard,Platform,View} from 'react-native';
import {Text} from 'react-native-paper';
import {SafeAreaProvider,initialWindowMetrics} from 'react-native-safe-area-context';
import {UIProvider,useUI,Button} from '../../src/ui';
import {LoadingProvider} from '../../src/LoadingOverlay';
import AccountNotifications from '../../src/AccountNotifications';
import FieldDialog from '../../src/FieldDialog';
import {TextField} from '../../src/FormFields';
import type {PushControls} from '../../src/PushSettings';
import type {Session} from '../../src/types';

const session:Session={baseUrl:Platform.OS==='web'?window.location.origin:'https://dialog-qa.invalid',token:'synthetic-dialog-fixture',userId:'dialog-fixture',email:'qa@example.invalid'};
let release=false;
let preferences={expense_updates:true,email_reminders:true,notifications_enabled:true,push_device_ids:['fixture-phone']};
let statements={enabled:false,frequency:'monthly',next_at:null as string|null,delivery:null as any};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=String(input);if(!url.startsWith(session.baseUrl))return originalFetch(input,init);
 const method=init?.method??'GET',body=JSON.parse(typeof init?.body==='string'?init.body:'{}');
 if(url.endsWith('/me/notifications/preferences')){
  if(method==='GET')while(!release)await new Promise(done=>setTimeout(done,50));
  else {await new Promise(done=>setTimeout(done,350));preferences={...preferences,...body,notifications_enabled:!!body.expense_updates};}
  return new Response(JSON.stringify(preferences),{status:200,headers:{'content-type':'application/json'}});
 }
 await new Promise(done=>setTimeout(done,600));
 if(url.endsWith('/me/balance-statements/preferences')){
  if(method==='PUT')statements={...statements,...body,next_at:body.enabled?'2026-12-01T09:00:00Z':null};
  return new Response(JSON.stringify(statements),{status:200,headers:{'content-type':'application/json'}});
 }
 if(url.endsWith('/me/balance-statements/send')){
  const delivery={id:'e3dc142a-c8cc-493a-8a22-112522d2bc0a',command_id:body.command_id,state:'accepted',error:''};statements.delivery=delivery;
  return new Response(JSON.stringify(delivery),{status:200,headers:{'content-type':'application/json'}});
 }
 throw Error('Unexpected synthetic request');
};
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):React.isValidElement(node)?[node,...React.Children.toArray((node.props as any).children).flatMap(nodes)]:[];
function Probe(){
 const {ui,changeColorFamily,motion}=useUI(),[field,setField]=useState(false),[name,setName]=useState('Weekend crew'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const input=useRef<any>(null),commands=useRef<any>({});
 const push={state:{ready:true,enabled:true,working:false,permission:'granted',installationId:'fixture-phone',error:'',pendingOff:false},enable:async()=>true,disable:async()=>{},refresh:async()=>{}} as unknown as PushControls;
 const notifications=AccountNotifications({session,push,busy,onBusyChange:setBusy});
 commands.current={
  open:()=>nodes(notifications).find(n=>n.props.label==='Notifications'&&n.props.onPress)?.props.onPress(),
  ready:()=>{release=true;},
  master:()=>nodes(notifications).find(n=>n.props.label==='Notifications'&&n.props.onChange)?.props.onChange(!preferences.expense_updates),
  close:()=>nodes(notifications).find(n=>typeof n.props.onDismiss==='function')?.props.onDismiss(),
  field:()=>{commands.current.close();setField(true);},
  error:()=>setError('Could not save your changes. Check your connection and try again.'),
  keyboard:()=>{input.current?.focus();setTimeout(()=>input.current?.measureInWindow((_x:number,y:number,_w:number,h:number)=>new File(Paths.document,'keyboard-check').write(JSON.stringify({y,height:h,keyboard:Keyboard.metrics(),focused:input.current?.isFocused()}))),700);},
  closefield:()=>{Keyboard.dismiss();setField(false);},
 };
 useEffect(()=>{void SplashScreen.hideAsync();void changeColorFamily('obsidian');},[changeColorFamily]);
 useEffect(()=>{if(Platform.OS==='web'){(globalThis as any).dialogMotion=motion;return;}new File(Paths.document,'dialog-motion').write(JSON.stringify(motion));},[motion]);
 useEffect(()=>{
  if(Platform.OS==='web'){(globalThis as any).dialogCommand=(action:string)=>commands.current[action]?.();return()=>{delete (globalThis as any).dialogCommand;};}
  const command=new File(Paths.document,'dialog-command'),report=new File(Paths.document,'dialog-ready');report.write('boot');
  const timer=setInterval(()=>{if(!command.exists)return;const action=command.textSync().trim();command.delete();commands.current[action]?.();setTimeout(()=>report.write(action),action==='ready'?1200:500);},100);
  return()=>clearInterval(timer);
 },[]);
 return <View style={{flex:1,padding:20,gap:20}}><Text style={ui.section}>Dialog motion QA</Text>{notifications}
  <Button title="Open field dialog" onPress={()=>setField(true)} />
  <FieldDialog title="Edit nickname" visible={field} disabled={false} canSave={!!name} onSave={()=>setError('Could not save your changes. Check your connection and try again.')} onClose={()=>{Keyboard.dismiss();setField(false);}} error={error}>
   <TextField ref={input} label="Nickname" value={name} onChangeText={setName} />
  </FieldDialog>
 </View>;
}
registerRootComponent(()=> <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><Probe /></LoadingProvider></UIProvider></SafeAreaProvider>);
