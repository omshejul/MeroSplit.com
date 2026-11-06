// Isolated, synthetic-only entry. Never imported by the production application.
import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from 'react-native-paper';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { UIProvider, Button, useUI } from '../../src/ui';
import SavedChangeScreen from '../../src/SavedChangeScreen';
import { resolveGroupSetting } from '../../src/groupSettingReview';
import { getDatabase } from '../../src/native';
import { enqueue, pendingCommands } from '../../src/storage';
import type { Command, Group } from '../../src/types';
const owner='synthetic-setting-recovery';
const group:Group={id:'g',name:'Weekend trip',version:5,participants:[{id:'a',name:'Asha'}],expenses:[],settlements:[],activity:[],balances:{},transfers:[],simplify_debts:true,can_change_simplify:true};
const command:Command={command_id:'setting',group_id:'g',method:'POST',path:'/groups/g/simplify',body:{version:1,command_id:'setting',simplify_debts:false},state:'conflict',error:'This group changed.',attempted:true};
function Probe(){const {ui,changeAppearance}=useUI(),[status,setStatus]=useState('Starting'),[busy,setBusy]=useState(false),[value,setValue]=useState(group);
 async function reset(){const db=await getDatabase();await db.runAsync('DELETE FROM outbox WHERE owner=?',owner);await enqueue(db,owner,command);await enqueue(db,owner,{...command,command_id:'bill',path:'/groups/g/expenses',body:{command_id:'bill',id:'bill',description:'Saved dinner'},state:'pending',error:null,attempted:undefined});setStatus('Ready');}
 useEffect(()=>{void reset().catch(e=>setStatus(String(e)));},[]);
 async function resolve(apply:boolean){setBusy(true);try{const db=await getDatabase();await resolveGroupSetting(db,owner,command,value,apply?'reviewed':null);const rows=await pendingCommands(db,owner);if(!rows.some(r=>r.command_id==='bill'))throw Error('Waiting bill lost');if(apply&&rows.map(r=>r.command_id).join()!=='reviewed,bill')throw Error('Wrong order');setStatus(apply?'Applied. Waiting bill retained.':'Kept current. Waiting bill retained.');}catch(e){setStatus(String(e));}finally{setBusy(false);}}
 return <ScrollView contentContainerStyle={{padding:20,gap:16}}><Text style={ui.section}>Review saved change</Text><Text>{status}</Text><View style={{flexDirection:'row',gap:10}}><Button title="Use dark" onPress={()=>void changeAppearance('dark')}/><Button title="Use light" onPress={()=>void changeAppearance('light')}/></View><SavedChangeScreen command={command} group={value} busy={busy} onEditSaved={()=>{}} onApplySetting={()=>void resolve(true)} onDiscard={()=>void resolve(false)}/><Button title="Reset recovery" onPress={()=>void reset()}/><Button title="Archive group" onPress={()=>setValue({...group,archived:true})}/></ScrollView>;
}
void SplashScreen.hideAsync();registerRootComponent(()=> <SafeAreaProvider><UIProvider><Probe/></UIProvider></SafeAreaProvider>);
