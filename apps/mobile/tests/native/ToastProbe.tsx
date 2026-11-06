// Isolated native toast layout probe, never imported by production index.ts.
import React, { useEffect } from 'react';
import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import * as SplashScreen from 'expo-splash-screen';
import { View } from 'react-native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { UIProvider, Button, useUI } from '../../src/ui';
import { useToast } from '../../src/Toast';
function Probe() {
 const notify=useToast(), {changeColorFamily}=useUI();
 useEffect(()=>{
  void SplashScreen.hideAsync();
  const timer=setTimeout(()=>{notify('Repayment setting saved.');new File(Paths.document,'toast-ready').write('ready');},3000);
  return ()=>clearTimeout(timer);
 },[]);
 return <View style={{flex:1,padding:24,justifyContent:'center',backgroundColor:'#000'}}>
  <Button title="Dark theme" onPress={()=>void changeColorFamily('obsidian')} />
  <Button title="Show confirmation" onPress={()=>notify('Repayment setting saved.')} />
  <Button title="Long confirmation" onPress={()=>notify('Repayment setting saved. Your existing payments stay credited and your remaining repayments have been updated.')} />
 </View>;
}
registerRootComponent(()=> <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><Probe /></UIProvider></SafeAreaProvider>);
