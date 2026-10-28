import React, { useEffect, useRef } from 'react';
import { Animated, Platform, Text, View } from 'react-native';
import { useUI } from './ui';

export default function ChatLoadingState() {
  const { palette, ui, motion } = useUI(), opacity = useRef(new Animated.Value(0.65)).current;
  useEffect(() => {
    if (!motion.enabled) { opacity.setValue(1); return; }
    const timing = (toValue: number) => Animated.timing(opacity, { toValue, duration: 900, useNativeDriver: Platform.OS !== 'web', isInteraction: false });
    const pulse = Animated.loop(Animated.sequence([timing(1), timing(0.55)])); pulse.start();
    return () => { pulse.stop(); opacity.setValue(1); };
  }, [motion.enabled, opacity]);
  return <View accessible accessibilityRole="progressbar" accessibilityLabel="Loading messages" accessibilityLiveRegion="polite" pointerEvents="none" style={{ flex: 1 }}>
    <Text accessible={false} style={[ui.caption, { textAlign: 'center', paddingTop: 12, paddingBottom: 18 }]}>Loading messages…</Text>
    <Animated.View aria-hidden importantForAccessibility="no-hide-descendants" style={{ gap: 16, opacity }}>
      <View style={{ width: '74%', height: 58, borderRadius: 18, borderBottomLeftRadius: 4, backgroundColor: palette.soft }} />
      <View style={{ width: '56%', height: 43, alignSelf: 'flex-end', borderRadius: 18, borderBottomRightRadius: 4, backgroundColor: palette.soft }} />
      <View style={{ width: '65%', height: 76, borderRadius: 18, borderBottomLeftRadius: 4, backgroundColor: palette.soft }} />
      <View style={{ width: '44%', height: 43, alignSelf: 'flex-end', borderRadius: 18, borderBottomRightRadius: 4, backgroundColor: palette.soft }} />
    </Animated.View>
  </View>;
}
