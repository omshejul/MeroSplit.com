import React from 'react';
import { Platform } from 'react-native';

// Native tabs overlay content; consume their current inset inside the tab screen.
export default function HomeTabInset() {
  if (Platform.OS !== 'ios' || Number.parseInt(String(Platform.Version), 10) < 26) return null;
  const { SafeAreaView } = require('react-native-screens/experimental') as typeof import('react-native-screens/experimental');
  return <SafeAreaView collapsable={false} pointerEvents="none" edges={{ bottom: true }} style={{ flex: 0 }} />;
}
