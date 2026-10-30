import React from 'react';
import { Platform, View } from 'react-native';
import BottomSafeArea from './BottomSafeArea';
import { pageWidthStyle } from './pageLayout';
export default function FloatingActionContainer({ children, home = false, onHeight }: { children: React.ReactNode; home?: boolean; onHeight?: (height: number) => void }) {
  const nativeTabs = home && Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;
  const Surface = nativeTabs ? (require('react-native-screens/experimental') as typeof import('react-native-screens/experimental')).SafeAreaView : home ? View : BottomSafeArea;
  return <Surface collapsable={false} pointerEvents="box-none" {...(nativeTabs ? { edges: { bottom: true } } : {})} onLayout={!home ? event => onHeight?.(event.nativeEvent.layout.height) : undefined} style={{ flex: 0, ...(home ? {} : { position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: 16 }) }}>
    <View pointerEvents="box-none" onLayout={home ? event => onHeight?.(event.nativeEvent.layout.height) : undefined} style={[pageWidthStyle, { width: '100%', alignItems: 'flex-end', paddingHorizontal: 16, ...(home ? { paddingBottom: 16 } : {}) }]}>{children}</View>
  </Surface>;
}
