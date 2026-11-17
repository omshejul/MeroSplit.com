// Isolated synthetic navigation check. Never imported by the production entry.
import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { File, Paths } from 'expo-file-system';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppStack, { NavigationContainer, useAppNavigation } from '../../src/AppStack';
import { UIProvider } from '../../src/ui';
function Probe() {
 const navigation = useAppNavigation(), [scope, setScope] = useState(1), step = useRef(0), results = useRef<string[]>([]), [status, setStatus] = useState('Starting');
 const initialScreen = useRef<'home' | 'login'>('home');
 useEffect(() => {
  const timer = setTimeout(() => {
   const state = navigation.ref.getRootState(); if (!state) return;
   const route = state.routes[state.index].name;
   const save = (message: string) => { setStatus(message); new File(Paths.document, 'navigation-probe.json').write(JSON.stringify({ status: message, results: results.current, routes: state.routes.map(r => r.name) })); };
   if (step.current === 0 && route === 'home') { step.current++; navigation.go('login'); }
   else if (step.current === 1 && route === 'login') { results.current.push('Login opened above Groups'); step.current++; setScope(2); }
   else if (step.current === 2 && scope === 2) {
    if (route !== 'home' || state.routes.length !== 1) { save('FAIL: reauthentication remained on ' + route); return; }
    results.current.push('Same-account reauthentication opens Groups without Back'); step.current++; navigation.go('group', {groupId:'synthetic'});
   } else if (step.current === 3 && route === 'group') { step.current++; initialScreen.current = 'login'; setScope(3); }
   else if (step.current === 4 && scope === 3) {
    if (route !== 'login' || state.routes.length !== 1) { save('FAIL: logout kept old stack'); return; }
    results.current.push('Logout removes all old routes'); step.current++; initialScreen.current = 'home'; setScope(4);
   } else if (step.current === 5 && scope === 4) {
    if (route !== 'home' || state.routes.length !== 1) { save('FAIL: first login remained on ' + route); return; }
    results.current.push('First login opens Groups'); step.current++; save('PASS');
   }
  }, 500);
  return () => clearTimeout(timer);
 }, [scope, navigation.route.key, navigation.route.name]);
 return <NavigationContainer ref={navigation.ref}><AppStack scope={'synthetic-account|' + scope} initialScreen={initialScreen.current} blocked={false} render={route => <View style={{flex:1,padding:60,backgroundColor:'#fff'}}><Text style={{fontSize:26,color:'#111'}}>Login redirect verification</Text><Text style={{fontSize:22,color:'#111'}}>{status}</Text><Text style={{fontSize:18,color:'#111'}}>{route.name}</Text>{results.current.map(text => <Text key={text} style={{fontSize:16,color:'#111',marginTop:20}}>{text}</Text>)}</View>} /></NavigationContainer>;
}
void SplashScreen.hideAsync();
registerRootComponent(() => <SafeAreaProvider><UIProvider><Probe /></UIProvider></SafeAreaProvider>);
