import React from 'react';
import { View } from 'react-native';
import BottomSafeArea from './BottomSafeArea';
import { pageWidthStyle } from './pageLayout';
export default function FloatingActionContainer({ children, onHeight }: { children: React.ReactNode; onHeight?: (height: number) => void }) {
  return <BottomSafeArea collapsable={false} pointerEvents="box-none" onLayout={event => onHeight?.(event.nativeEvent.layout.height)} style={{ flex: 0, position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: 16 }}>
    <View pointerEvents="box-none" style={[pageWidthStyle, { width: '100%', alignItems: 'flex-end', paddingHorizontal: 16 }]}>{children}</View>
  </BottomSafeArea>;
}
