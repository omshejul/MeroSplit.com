// Synthetic native UI entry, excluded from production.
import React, { useEffect, useRef, useState } from 'react';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { Text } from 'react-native-paper';
import { AppFrame } from '../../src/AppNavigation';
import AppStack, { NavigationContainer } from '../../src/AppStack';
import KeyboardScrollView from '../../src/KeyboardScrollView';
import { LoadingProvider } from '../../src/LoadingOverlay';
import { ToastProvider } from '../../src/Toast';
import { Button, UIProvider, useUI } from '../../src/ui';
import MembersScreen from '../../src/MembersScreen';
import ExpenseForm from '../../src/ExpenseForm';
import type { Group } from '../../src/types';
const owner='synthetic-defaults-qa';
const group:Group={id:'defaults-qa',name:'Weekend trip',owner_id:991,version:1,participants:[{id:'a',name:'Asha',user_id:991},{id:'b',name:'Bea',user_id:992},{id:'c',name:'Chen',user_id:993}],expenses:[],settlements:[],balances:{a:'0',b:'0',c:'0'},transfers:[],activity:[],can_change_simplify:true};
function Probe(){
 const {ui,changeAppearance}=useUI(),[bill,setBill]=useState(false),[direct,setDirect]=useState(false),[status,setStatus]=useState(''),writes=useRef(Promise.resolve());
 const ledger=direct?{...group,id:'personal-defaults-qa',name:'Bea',is_direct:true,participants:group.participants.slice(0,2)}:group;
 useEffect(()=>{void SplashScreen.hideAsync();},[]);
 return <KeyboardScrollView contentContainerStyle={{padding:16,gap:12}}>
  <Text style={ui.section}>{ledger.name}</Text>
  <Button title={bill?'Back to settings':'New bill'} onPress={()=>setBill(!bill)}/>
  <Button title="Switch ledger" onPress={()=>{setBill(false);setDirect(!direct);}}/>
  <Button title="Dark appearance" onPress={()=>void changeAppearance('dark')}/>
  {status?<Text>{status}</Text>:null}
  {bill?<ExpenseForm key={ledger.id} group={ledger} selfId="a" owner={owner} writes={writes} busy={false} onSave={async(value,_,queued)=>{queued?.();setStatus(`Saved ${value.description}. ${Object.keys(value.paid).length} payers. ${value.split.mode}.`);setBill(false);}}/>:<MembersScreen key={ledger.id} group={ledger} selfId="a" owner={owner} busy={false} onAction={async()=>({})} onMembership={()=>{}}/>}
 </KeyboardScrollView>;
}
registerRootComponent(()=> <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><ToastProvider><NavigationContainer><AppFrame><AppStack initialScreen="home" scope="defaults-probe" blocked={false} render={()=> <Probe/>}/></AppFrame></NavigationContainer></ToastProvider></LoadingProvider></UIProvider></SafeAreaProvider>);
