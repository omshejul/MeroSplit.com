import React, { useLayoutEffect, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { useUI } from './ui';

export const staggerDelay = (index: number) => Math.min(Math.max(0, index), 7) * 30;

// Only the first eight rows enter. Updates, scrolling later rows and resume stay still.
export default function StaggerItem({ index, children }: { index: number; children: React.ReactNode }) {
  const { motion } = useUI();
  const progress = useRef(new Animated.Value(1)).current, played = useRef(false);
  useLayoutEffect(() => {
    if (played.current || !motion.enabled || index >= 8) { played.current = true; progress.setValue(1); return; }
    played.current = true;
    progress.setValue(0);
    const animation = Animated.timing(progress, { toValue: 1, delay: staggerDelay(index), duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web', isInteraction: false });
    animation.start();
    return () => { animation.stop(); progress.setValue(1); };
  }, [index, motion.enabled, progress]);
  return <Animated.View testID="stagger-item" style={{ opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }), transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}>{children}</Animated.View>;
}
