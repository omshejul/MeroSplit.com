import React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useUI } from './ui';

export type TabBarSurfaceProps = { children: React.ReactNode; style: StyleProp<ViewStyle> };

export default function TabBarSurface({ children, style }: TabBarSurfaceProps) {
  const { palette } = useUI();
  return <View style={[style, { backgroundColor: palette.surface }]} accessibilityRole={Platform.OS === 'web' ? undefined : 'tablist'}>{children}</View>;
}
