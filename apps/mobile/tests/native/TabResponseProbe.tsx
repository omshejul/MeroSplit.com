// Isolated navigation performance fixture. Never imported by production index.ts.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import HomeTabs from '../../src/HomeTabs';
import { UIProvider } from '../../src/ui';
import { AppFrame } from '../../src/AppNavigation';

function Probe() {
  const [selected, setSelected] = useState('Groups');
  const [loaded, setLoaded] = useState('Groups');
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { void SplashScreen.hideAsync(); return () => clearTimeout(pending.current); }, []);
  return <AppFrame windowOnly={Platform.OS === 'ios'}><HomeTabs selected={selected} busy={false} onSelect={tab => {
    // Deliberately hold JS work so a native selection round trip is visible.
    const until = performance.now() + Number(process.env.EXPO_PUBLIC_TAB_RESPONSE_WORK_MS ?? '0');
    while (performance.now() < until) { /* QA-only render pressure. */ }
    setSelected(tab);
    clearTimeout(pending.current);
    pending.current = setTimeout(() => setLoaded(tab), 3000);
  }} render={tab => <View style={{ flex: 1, padding: 24, paddingTop: 100 }}>
    <Text accessibilityRole="header" testID={`page-${tab}`}>{tab}</Text>
    <Text>{loaded === tab ? 'Page ready' : 'Loading page'}</Text>
    <Text>{process.env.EXPO_PUBLIC_TAB_RESPONSE_REVISION}</Text>
  </View>} /></AppFrame>;
}
registerRootComponent(() => <UIProvider><Probe /></UIProvider>);
