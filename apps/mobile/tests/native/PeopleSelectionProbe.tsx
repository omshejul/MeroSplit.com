// Isolated bulk-selection acceptance entry, never imported by production index.ts.
import React, { useEffect, useRef } from 'react';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { AppFrame } from '../../src/AppNavigation';
import AppStack, { NavigationContainer } from '../../src/AppStack';
import KeyboardScrollView from '../../src/KeyboardScrollView';
import { LoadingProvider } from '../../src/LoadingOverlay';
import { UIProvider } from '../../src/ui';
import ExpenseForm from '../../src/ExpenseForm';
import type { Group } from '../../src/types';
const group:Group={id:'bulk-probe',name:'Weekend trip',version:1,owner_id:1,participants:[{id:'a',name:'Asha',user_id:1},{id:'b',name:'Bharat',user_id:2},{id:'c',name:'Charu',user_id:3}],expenses:[],settlements:[],balances:{a:'0',b:'0',c:'0'},transfers:[],activity:[]};
function Probe(){
 const writes=useRef(Promise.resolve());
 useEffect(()=>{void SplashScreen.hideAsync();},[]);
 return <KeyboardScrollView contentContainerStyle={{padding:16}}><ExpenseForm group={group} selfId="a" busy={false} owner="native-bulk-fixture" writes={writes} onSave={async()=>{}} /></KeyboardScrollView>;
}
registerRootComponent(()=> <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><NavigationContainer><AppFrame><AppStack initialScreen="home" scope="bulk-probe" blocked={false} render={()=> <Probe />} /></AppFrame></NavigationContainer></LoadingProvider></UIProvider></SafeAreaProvider>);
