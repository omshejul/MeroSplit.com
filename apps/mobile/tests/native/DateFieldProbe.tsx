// Isolated native date/time acceptance entry, never imported by production index.ts.
import React, { useEffect, useState } from 'react';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { File, Paths } from 'expo-file-system';
import { Platform, View } from 'react-native';
import { Text } from 'react-native-paper';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { AppFrame } from '../../src/AppNavigation';
import AppStack, { NavigationContainer } from '../../src/AppStack';
import { LoadingProvider } from '../../src/LoadingOverlay';
import { UIProvider } from '../../src/ui';
import DateField, { DateDialog } from '../../src/DateField';
import { useToast } from '../../src/Toast';
function Probe() {
 const [date,setDate]=useState('2026-11-01'),[time,setTime]=useState<string|null>(null),[open,setOpen]=useState(Platform.OS==='ios');
 const notify=useToast();
 useEffect(()=>{void SplashScreen.hideAsync();const timer=setTimeout(()=>new File(Paths.document,'date-dialog-ready').write('ready'),1500);return()=>clearTimeout(timer);},[]);
 const save=(date:string,time:string|null)=>{setDate(date);setTime(time);new File(Paths.document,'date-saved.json').write(JSON.stringify({date,time}));notify('Date saved.');};
 return <View style={{flex:1,padding:24,justifyContent:'center'}}><DateField label="Date" value={date} time={time} onChange={save}/><Text>Saved: {date}{time?` ${time}`:''}</Text>
 {open&&<DateDialog label="Date" value={date} time="14:09" onChange={save} onDismiss={()=>setOpen(false)}/>}</View>;
}
registerRootComponent(()=> <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><NavigationContainer><AppFrame><AppStack initialScreen="home" scope="date-probe" blocked={false} render={()=> <Probe />} /></AppFrame></NavigationContainer></LoadingProvider></UIProvider></SafeAreaProvider>);
