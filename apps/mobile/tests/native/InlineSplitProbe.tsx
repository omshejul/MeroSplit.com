// Synthetic acceptance entry. Never imported by production index.ts.
import React, { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import BillPeople from '../../src/BillPeople';
import PeopleSheet from '../../src/PeopleSheet';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { AppFrame } from '../../src/AppNavigation';
import AppStack, { NavigationContainer } from '../../src/AppStack';
import KeyboardScrollView from '../../src/KeyboardScrollView';
import { LoadingProvider } from '../../src/LoadingOverlay';
import { UIProvider, useUI } from '../../src/ui';
import ExpenseForm from '../../src/ExpenseForm';
import type { Group, Expense } from '../../src/types';
const names=['Anishk','Harshit Dutta','Aryan','Om Shejul','Aditya','om'];
const expense:Expense={id:'inline-native-bill',description:'Dinner',total:'120000',date:'2026-11-01',paid:{a:'120000'},split:{mode:'exact',values:{a:'30000',b:'24000',c:'24000',d:'18000',e:'12000',f:'12000'}},shares:{a:'30000',b:'24000',c:'24000',d:'18000',e:'12000',f:'12000'},category:'food',notes:'',deleted:false,version:1};
const group:Group={id:'inline-probe',name:'Weekend trip',version:1,owner_id:1,participants:names.map((name,index)=>({id:String.fromCharCode(97+index),name,user_id:index+1})),expenses:[expense],settlements:[],balances:{},transfers:[],activity:[]};
function Probe(){
 const writes=useRef(Promise.resolve()), [stage,setStage]=useState(0), {changeColorFamily}=useUI();
 useEffect(()=>{void SplashScreen.hideAsync();if(Platform.OS==='ios')void changeColorFamily('obsidian');},[changeColorFamily]);
 // Call the production form unconditionally so the iOS gallery can render its actual split fields.
 const form=ExpenseForm({group,expense,selfId:'d',busy:false,owner:'native-inline-fixture',writes,onSave:async()=>{}});
 const split=React.Children.toArray(form.props.children).find(child=>React.isValidElement(child)&&child.type===BillPeople&&(child.props as {icon?:string}).icon==='people') as React.ReactElement<{children:React.ReactElement<{onChange:(patch:object)=>void}>}>;
 const fields=split.props.children, latest=useRef(fields);latest.current=fields;
 useEffect(()=>{
  if(Platform.OS!=='ios')return;
  const ready=new File(Paths.document,'inline-ready'), next=new File(Paths.document,'inline-next');
  const timeout=setTimeout(()=>ready.write(String(stage)),700);
  const poll=setInterval(()=>{if(!next.exists)return;next.delete();const nextStage=stage+1;
   if(nextStage===1)latest.current.props.onChange({mode:'percent',splitValues:{a:'25',b:'20',c:'20',d:'15',e:'10',f:'10'}});
   if(nextStage===2)latest.current.props.onChange({mode:'shares',splitValues:{a:'5',b:'4',c:'4',d:'3',e:'2',f:'2'}});
   setStage(nextStage);
  },150);
  return()=>{clearTimeout(timeout);clearInterval(poll);};
 },[stage]);
 if(Platform.OS==='ios')return <PeopleSheet visible onDismiss={()=>{}} title="Split expense" icon="people" total="₹1,200.00" count={6} disabled={false} maxHeight={900}>{fields}</PeopleSheet>;
 return <KeyboardScrollView contentContainerStyle={{padding:16}}>{form}</KeyboardScrollView>;
}

registerRootComponent(()=> <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><NavigationContainer><AppFrame><AppStack initialScreen="home" scope="inline-probe" blocked={false} render={()=> <Probe />} /></AppFrame></NavigationContainer></LoadingProvider></UIProvider></SafeAreaProvider>);
