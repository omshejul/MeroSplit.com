// Offline opt-in fixture. Uses the real invitation and Android permission dialog, no push registration.
import React,{useEffect,useRef,useState} from 'react';
import {registerRootComponent} from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import {File,Paths} from 'expo-file-system';
import {View} from 'react-native';
import {Text} from 'react-native-paper';
import {SafeAreaProvider,initialWindowMetrics} from 'react-native-safe-area-context';
import {UIProvider,useUI,Button} from '../../src/ui';
import {LoadingProvider} from '../../src/LoadingOverlay';
import PushInvitation from '../../src/PushInvitation';
import {pushPermission} from '../../src/notifications';
import type {PushControls} from '../../src/PushSettings';
import type {Session} from '../../src/types';
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>String(input).startsWith('https://push-qa.invalid')?new Response(JSON.stringify({expense_updates:true,email_reminders:true}),{status:200,headers:{'content-type':'application/json'}}):original(input,init);
function Probe(){
 const {ui,palette}=useUI(),[eligible,setEligible]=useState(false),[account,setAccount]=useState(1),[calls,setCalls]=useState(0),[permission,setPermission]=useState<'ask'|'granted'|'denied'>('ask');
 const commands=useRef<Record<string,()=>void>>({});
 const session:Session={baseUrl:'https://push-qa.invalid',userId:String(account),token:'synthetic-push-'+account,email:'qa@example.invalid'};
 const push={state:{ready:true,enabled:false,optedIn:false,pendingOff:false,working:false,permission,error:''},enable:async()=>{
  setCalls(n=>n+1);await Notifications.setNotificationChannelAsync('shared-bills',{name:'Shared bills',importance:Notifications.AndroidImportance.DEFAULT});
  const status=await Notifications.requestPermissionsAsync({ios:{allowAlert:true,allowSound:true,allowBadge:false}}),value=pushPermission(status);setPermission(value);return value==='granted';
 }} as PushControls;
 commands.current={open:()=>setEligible(true),reopen:()=>{setEligible(false);setTimeout(()=>setEligible(true),100);},account:()=>{setEligible(false);setAccount(n=>n+1);}};
 useEffect(()=>{void SplashScreen.hideAsync();},[]);
 useEffect(()=>{new File(Paths.document,'push-calls').write(JSON.stringify({calls,permission}));},[calls,permission]);
 useEffect(()=>{
  const command=new File(Paths.document,'push-command'),ready=new File(Paths.document,'push-ready');ready.write('boot');
  const timer=setInterval(()=>{if(!command.exists)return;const action=command.textSync().trim();command.delete();commands.current[action]?.();setTimeout(()=>ready.write(action),1500);},100);
  return()=>clearInterval(timer);
 },[]);
 return <View style={{flex:1,padding:20,gap:20,backgroundColor:palette.background}}><Text style={ui.section}>Shared group</Text><Text style={ui.body}>Dinner · ₹900</Text><Button title="Open shared group" onPress={()=>setEligible(true)} /><Text style={ui.body}>Permission requests: {calls}</Text>
  <PushInvitation key={account} owner={session.baseUrl+'|'+session.userId} session={session} eligible={eligible} push={push} onVisibility={()=>{}} />
 </View>;
}
registerRootComponent(()=> <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><Probe /></LoadingProvider></UIProvider></SafeAreaProvider>);
