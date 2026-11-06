// Synthetic API boundaries around the real production app and navigation.
import {Platform} from 'react-native';
import {File,Paths} from 'expo-file-system';
import {saveSession,getDatabase} from '../../src/native';
import * as SecureStore from 'expo-secure-store';
import React,{useEffect,useState} from 'react';
import { registerRootComponent } from 'expo';
import App from '../../App';
const original=globalThis.fetch;
let email=true,revision=0;
(globalThis as any).toggleProbe={calls:[],delay:5000};
globalThis.fetch=(async(input:any,init:any={})=>{
 const url=String(input),path=url.split('/api/v1')[1];
 if(!path)return original(input,init);
 const probe=(globalThis as any).toggleProbe;probe.offline=new File(Paths.document,'toggle-probe-offline').exists;probe.calls.push({path,method:init.method??'GET'});
 const body=JSON.parse(init.body??'{}');let result:any;
 if(probe.offline)throw Error('Synthetic offline');
 if(path==='/me')result={id:42,email:'qa@example.invalid',display_name:'Test Person',payment_profile:null};
 else if(path.split('?')[0]==='/me/notifications/channels'){
  if(init.method==='PUT'){await new Promise(r=>setTimeout(r,probe.delay));if(body.revision>revision){if(body.email_notifications!==undefined)email=body.email_notifications;revision=body.revision}}
  result={email_notifications:email,email_available:true,legacy_muted:false,statement_enabled:email,statement_frequency:'monthly',muted_push_devices:[],revision};
 }else if(path==='/groups'||path.startsWith('/me/ledger-heads'))result={groups:[]};
 else if(path==='/me/notifications/preferences')result={expense_updates:true,email_reminders:email};
 else if(path.startsWith('/me/notifications?'))result={notices:[],has_more:false};
 else if(path.startsWith('/me/balance-statements/preferences'))result={enabled:email,frequency:'monthly',delivery:null};
 else if(path==='/me/bill-email-entry')result={needs_invitation:false};
 else if(path.startsWith('/me/chat-conversations'))result={conversations:[],has_more:false};
 else if(path.startsWith('/me/providers'))result={providers:[]};
 else result={};
 return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json','X-MeroSplit-Account':'42'}});
}) as any;
const session={baseUrl:'https://toggle-reset.invalid',userId:'42',email:'qa@example.invalid',displayName:'Test Person',token:'synthetic-toggle-reset'};
setInterval(()=>{void Promise.all([getDatabase().then(db=>db.getFirstAsync<{body:string}>('SELECT body FROM notification_channels WHERE owner=?',session.baseUrl+'|42')),SecureStore.getItemAsync('splitdumb.push')]).then(([email,push])=>new File(Paths.document,'toggle-report.json').write(JSON.stringify({email:email?JSON.parse(email.body):null,push:push?JSON.parse(push):null}))).catch(()=>{})},200);
function Entry(){const[ready,setReady]=useState(false);useEffect(()=>{void saveSession(session).then(()=>setReady(true))},[]);return ready?<App/>:null}
registerRootComponent(Entry);
