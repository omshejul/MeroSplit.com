import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useUI } from './ui';

export type ChatComposerSurfaceProps = { children: React.ReactNode; style: StyleProp<ViewStyle> };
export default function ChatComposerSurface({ children, style }: ChatComposerSurfaceProps) {
  const { palette } = useUI();
  return <View style={[style, { backgroundColor: palette.surface }]}>{children}</View>;
}
