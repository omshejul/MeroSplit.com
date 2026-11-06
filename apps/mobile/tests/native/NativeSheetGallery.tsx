// Synthetic native QA for real form-sheet routes and controlled bill drafts.
import React,{useRef,useState} from 'react';
import {ScrollView,View} from 'react-native';
import {Text} from 'react-native-paper';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import AppStack,{NavigationContainer,useAppNavigation} from '../../src/AppStack';
import {AppFrame,ScreenHeader,pageContentStyle} from '../../src/AppNavigation';
import {UIProvider,Button,useUI} from '../../src/ui';
import ExpenseForm from '../../src/ExpenseForm';
import {ExpenseDetail} from '../../src/GroupScreen';
import type {Expense,Group} from '../../src/types';
const bill:Expense={id:'sheet-qa-bill',version:1,description:'Dinner with friends',total:'30000',paid:{a:'15000',b:'15000'},shares:{a:'10000',b:'10000',c:'10000'},split:{mode:'equal',values:{a:'1',b:'1',c:'1'}},date:'2026-10-29',category:'food',category_auto:false,notes:'Native sheet QA',deleted:false};
const base:Group={id:'native-sheet-qa',name:'Weekend trip',owner_id:99999,version:1,participants:[{id:'a',name:'Me',user_id:99999},{id:'b',name:'Asha'},{id:'c',name:'Dev'}],expenses:[bill],settlements:[],activity:[],balances:{a:'5000',b:'5000',c:'-10000'},transfers:[]};
function Gallery(){
 const navigation=useAppNavigation(),writes=useRef(Promise.resolve()),{ui,dark,changeAppearance}=useUI();
 const [long,setLong]=useState(false),[saved,setSaved]=useState<Expense|null>(null);
 const group=long?{...base,id:'native-sheet-long-qa',participants:[...base.participants,...Array.from({length:21},(_,i)=>({id:'p'+i,name:'Person '+String(i+4).padStart(2,'0')}))]}:base;
 return <NavigationContainer ref={navigation.ref}><AppFrame><AppStack initialScreen="home" scope="native-sheet-gallery" blocked={false} render={(route,focused,onQueued)=>{
  if(route.name==='home')return <View style={pageContentStyle}><Button title="Add bill" onPress={()=>navigation.go('expense',{groupId:group.id,expenseId:null})}/><Button title="Edit bill" onPress={()=>navigation.go('expense',{groupId:group.id,expenseId:bill.id})}/><Button title="View bill" onPress={()=>navigation.go('expenseDetail',{groupId:group.id,expenseId:bill.id})}/><Button title={long?'Use 3 people':'Use 24 people'} onPress={()=>setLong(value=>!value)}/><Button title={dark?'Use light':'Use dark'} onPress={()=>void changeAppearance(dark?'light':'dark')}/>{saved&&<Text style={ui.caption}>{JSON.stringify(saved)}</Text>}</View>;
  return <><ScreenHeader title={route.name==='expense'?'Add or edit bill':'Bill'} busy={false} onBack={()=>navigation.back(true)}/><ScrollView contentContainerStyle={pageContentStyle} keyboardShouldPersistTaps="handled">
   {route.name==='expense'?<ExpenseForm key={route.params?.expenseId??'new'} group={group} expense={route.params?.expenseId?bill:undefined} selfId="a" busy={false} owner="native-sheet-gallery-20261029" writes={writes} onSave={async(value,_attachment,accepted)=>{setSaved(value);accepted?.();onQueued();navigation.complete('home');}}/>
    :route.name==='expenseDetail'?<ExpenseDetail expense={bill} group={group} selfId="a" busy={false} canEdit onEdit={()=>navigation.go('expense',{groupId:group.id,expenseId:bill.id})} onReverse={()=>{}}/>
    :<Button title="Open menu" onPress={()=>navigation.go('home')}/>}
  </ScrollView></>;
 }}/></AppFrame></NavigationContainer>;
}
export default function NativeSheetGallery(){return <SafeAreaProvider><UIProvider><Gallery/></UIProvider></SafeAreaProvider>;}
