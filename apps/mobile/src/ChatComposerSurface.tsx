import React from 'react';
import { View, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { useUI } from './ui';

export type ChatComposerSurfaceProps = { children: React.ReactNode; style: StyleProp<ViewStyle>; interactive?: boolean; tintColor?: ColorValue };
export default function ChatComposerSurface({ children, style, tintColor }: ChatComposerSurfaceProps) {
  const { palette } = useUI();
  return <View style={[style, { backgroundColor: tintColor ?? palette.surface }]}>{children}</View>;
}
