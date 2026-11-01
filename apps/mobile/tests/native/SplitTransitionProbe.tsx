// Synthetic acceptance entry. Never imported by production index.ts.
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import BillPeople from '../../src/BillPeople';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { AppFrame } from '../../src/AppNavigation';
import AppStack, { NavigationContainer } from '../../src/AppStack';
import { LoadingProvider } from '../../src/LoadingOverlay';
import { UIProvider, useUI, Button } from '../../src/ui';
import ExpenseForm from '../../src/ExpenseForm';
import type { Group, Expense } from '../../src/types';
const names=['Anishk','Harshit Dutta','Aryan','Om Shejul','Aditya','om','Anish'];
const expense:Expense={id:'inline-native-bill',description:'Dinner',total:'120000',date:'2026-11-01',paid:{a:'120000'},split:{mode:'shares',values:{a:'1',b:'1',c:'1',d:'1',e:'1',f:'1',g:'1'}},shares:{a:'17143',b:'17143',c:'17143',d:'17143',e:'17143',f:'17143',g:'17142'},category:'food',notes:'',deleted:false,version:1};
const group:Group={id:'inline-probe',name:'Weekend trip',version:1,owner_id:1,participants:names.map((name,index)=>({id:String.fromCharCode(97+index),name,user_id:index+1})),expenses:[expense],settlements:[],balances:{},transfers:[],activity:[]};
function Probe(){
 const writes=useRef(Promise.resolve()), [stage,setStage]=useState(0), {changeColorFamily,motion}=useUI();
 useEffect(()=>{void SplashScreen.hideAsync();void changeColorFamily('obsidian');},[changeColorFamily]);
 const form=ExpenseForm({group,expense,selfId:'d',busy:false,owner:'native-transition-fixture',writes,onSave:async()=>{}});
 const split=React.Children.toArray(form.props.children).find(child=>React.isValidElement(child)&&child.type===BillPeople&&(child.props as {icon?:string}).icon==='people') as React.ReactElement<React.ComponentProps<typeof BillPeople>>;
 // Drive the real trigger and modal state, including Button's layout transaction.
 const selector=BillPeople(split.props);
 const children=React.Children.toArray(selector.props.children) as React.ReactElement[];
 const trigger=children[0], modal=children[1];
 const control=(Button as unknown as {render:(props:unknown,ref:null)=>React.ReactElement<{onPress:(event:object)=>void}>}).render(trigger.props,null);
 const fields=split.props.children as React.ReactElement;
 const fieldTree=(fields.type as (props:unknown)=>React.ReactElement<{children:React.ReactNode}>)(fields.props);
 const bulkElement=React.Children.toArray(fieldTree.props.children)[2] as React.ReactElement;
 const bulk=(bulkElement.type as (props:unknown)=>React.ReactElement)(bulkElement.props);
 const bulkControl=(Button as unknown as {render:(props:unknown,ref:null)=>React.ReactElement<{onPress:(event:object)=>void}>}).render(bulk.props,null);
 const latest=useRef({press:()=>control.props.onPress({}),bulk:()=>bulkControl.props.onPress({}),dismiss:()=>{}});
 latest.current={press:()=>control.props.onPress({}),bulk:()=>bulkControl.props.onPress({}),dismiss:(modal.props as {onDismiss:()=>void}).onDismiss};
 useEffect(()=>{new File(Paths.document,'inline-motion').write(JSON.stringify(motion));},[motion]);
 useEffect(()=>{
  const ready=new File(Paths.document,'inline-ready'), next=new File(Paths.document,'inline-next');
  const timeout=setTimeout(()=>ready.write(String(stage)),700);
  const poll=setInterval(()=>{if(!next.exists)return;next.delete();const nextStage=stage+1;
   if(nextStage===1||nextStage===5)latest.current.press();else if(nextStage===4)latest.current.dismiss();else latest.current.bulk();
   setStage(nextStage);
  },150);
  return()=>{clearTimeout(timeout);clearInterval(poll);};
 },[stage]);
 return <View style={{padding:20}}>{selector}</View>;
}

registerRootComponent(()=> <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><NavigationContainer><AppFrame><AppStack initialScreen="home" scope="inline-probe" blocked={false} render={()=> <Probe />} /></AppFrame></NavigationContainer></LoadingProvider></UIProvider></SafeAreaProvider>);
