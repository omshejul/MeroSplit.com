// Synthetic API boundaries around the real production app and navigation.
import '../../src/webBootstrap';
import React from 'react';
import { registerRootComponent } from 'expo';
import App from '../../App';
const original=globalThis.fetch;
let email=true,revision=0;
(globalThis as any).toggleProbe={calls:[],delay:5000};
globalThis.fetch=(async(input:any,init:any={})=>{
 const url=String(input),path=url.split('/api/v1')[1];
 if(!path)return original(input,init);
 const probe=(globalThis as any).toggleProbe;probe.calls.push({path,method:init.method??'GET'});
 const body=JSON.parse(init.body??'{}');let result:any;
 if(probe.offline)throw Error('Synthetic offline');
 if(path==='/me')result={id:42,email:'qa@example.invalid',display_name:'Test Person',payment_profile:null};
 else if(path==='/me/notifications/channels'){
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
registerRootComponent(App);
