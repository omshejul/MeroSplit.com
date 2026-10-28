import FloatingActionContainer from './FloatingActionContainer';
import React from 'react';
import { Platform } from 'react-native';

import AddActionButton from './AddActionButton';

// Custom tabs already sit outside the content area. Native iOS tabs overlay it.
export default function HomeCreateButton({ direct, disabled, onPress, onHeight }: { direct: boolean; disabled: boolean; onPress: () => void; onHeight?: (height: number) => void }) {
  return <FloatingActionContainer home onHeight={onHeight}><AddActionButton title={direct ? 'Add person' : 'Add group'} disabled={disabled} onPress={onPress} /></FloatingActionContainer>;
}

// Native tab bars overlay scroll content, so its footer needs their real inset too.
export function HomeCreateInset() {
  if (Platform.OS !== 'ios' || Number.parseInt(String(Platform.Version), 10) < 26) return null;
  const { SafeAreaView } = require('react-native-screens/experimental') as typeof import('react-native-screens/experimental');
  return <SafeAreaView pointerEvents="none" edges={{ bottom: true }} style={{ flex: 0 }} />;
}
