import React from 'react';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScrollView from './KeyboardScrollView';
import { usesNativeHomeTabs } from './HomeTabs';

// One owner for scroll content and indicator clearance, including cold launches.
export function useHomeTabScrollInsets(home = true) {
  const { bottom } = useSafeAreaInsets();
  return home && usesNativeHomeTabs ? {
    bottom, contentInsetAdjustmentBehavior: 'never' as const, scrollIndicatorInsets: { bottom },
  } : { bottom: 0 };
}

export default function HomeScrollView({ home = false, bottomClearance = 0, contentContainerStyle, ...props }:
  React.ComponentPropsWithRef<typeof ScrollView> & { home?: boolean; bottomClearance?: number }) {
  const { bottom, ...insets } = useHomeTabScrollInsets(home);
  const style = StyleSheet.flatten(contentContainerStyle);
  const padding = style?.paddingBottom ?? style?.paddingVertical ?? style?.padding ?? 0;
  return <ScrollView {...props} {...insets} contentContainerStyle={[contentContainerStyle,
    home && usesNativeHomeTabs && { paddingBottom: Math.max((typeof padding === 'number' ? padding : 0) + bottom, bottomClearance) }]} />;
}
