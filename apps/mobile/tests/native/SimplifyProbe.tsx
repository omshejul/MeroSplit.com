// Isolated synthetic UI acceptance entry, never imported by production index.ts.
import React, { useEffect, useState } from 'react';
import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import * as SplashScreen from 'expo-splash-screen';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { AppFrame } from '../../src/AppNavigation';
import AppStack, { NavigationContainer } from '../../src/AppStack';
import KeyboardScrollView from '../../src/KeyboardScrollView';
import { UIProvider, Button } from '../../src/ui';
import { LoadingProvider } from '../../src/LoadingOverlay';
import CreateGroupForm from '../../src/CreateGroupForm';
import MembersScreen from '../../src/MembersScreen';
import GroupScreen from '../../src/GroupScreen';
import { directTransfers } from '../../src/accounting';
import type { Group, Expense } from '../../src/types';
const report = new File(Paths.document, 'simplify-probe.json');
const expense = (id: string, paid: Record<string,string>, shares: Record<string,string>): Expense => ({ id, description:id,total:'50000',paid,shares,split:{mode:'exact',values:shares},version:1,deleted:false,category:'food',notes:'',date:'2026-10-31' });
const empty: Group={id:'trip',name:'Weekend trip',version:1,owner_id:1,participants:[{id:'A',name:'Asha',user_id:2},{id:'B',name:'Bharat',user_id:1},{id:'C',name:'Charu',user_id:3}],expenses:[],settlements:[],balances:{A:'0',B:'0',C:'0'},transfers:[],activity:[],simplify_debts:true,can_change_simplify:true};
const expenses=[expense('Lunch',{B:'50000'},{A:'50000'}),expense('Dinner',{C:'50000'},{B:'50000'})];
const chain:Group={...empty,version:3,expenses,balances:{A:'-50000',B:'0',C:'50000'},transfers:directTransfers(expenses,[]),simplify_debts:false,can_change_simplify:false};
function Probe(){
 const [screen,setScreen]=useState('create'),[group,setGroup]=useState(empty),[status,setStatus]=useState('');
 useEffect(()=>{void SplashScreen.hideAsync();},[]);
 const controls=<View style={{gap:4,padding:12}}><View style={{flexDirection:'row',flexWrap:'wrap',gap:6}}>{['create','settings','readonly','locked','balances'].map(name=><Button key={name} title={name} compact small onPress={()=>{setScreen(name);setStatus('');}} />)}</View><Text>{status}</Text></View>;
 if(screen==='balances')return <View style={{flex:1}}>{controls}<GroupScreen group={chain} accepted={chain} selfId="B" pending={[]} busy={false} onExpense={()=>{}} onPayment={()=>{}} onSettle={()=>{}} onReverse={()=>{}} /></View>;
 return <KeyboardScrollView contentContainerStyle={{padding:16,gap:12}}>{controls}{screen==='create'?<CreateGroupForm direct={false} busy={false} onCreate={values=>{report.write(JSON.stringify({created:values}));setStatus(values.simplify_debts?'Created with Simplify on':'Created with Simplify off');}} />:<MembersScreen group={screen==='locked'?chain:group} selfId={screen==='readonly'?'A':'B'} busy={false} onMembership={()=>{}} onAction={async(path,body)=>{if(path!=='/simplify')throw Error('Unexpected action');report.write(JSON.stringify({path,body}));setGroup(value=>({...value,simplify_debts:body.simplify_debts as boolean,version:value.version+1}));setStatus('Setting saved');return {id:group.id,version:group.version+1};}} />}</KeyboardScrollView>;
}
function App(){return <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><NavigationContainer><AppFrame><AppStack initialScreen="home" scope="simplify-probe" blocked={false} render={()=> <Probe />} /></AppFrame></NavigationContainer></LoadingProvider></UIProvider></SafeAreaProvider>;}
registerRootComponent(App);
