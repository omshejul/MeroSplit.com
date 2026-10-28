import React, { useLayoutEffect, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { useUI } from './ui';

// Owned by the transaction list, so recycling a row cannot replay its entrance.
export type ListEntry = { delay: number; played: boolean };
export default function StaggerItem({ entry, children }: { entry?: ListEntry; children: React.ReactNode }) {
  const { motion } = useUI();
  const progress = useRef(new Animated.Value(1)).current, played = useRef(false);
  useLayoutEffect(() => {
    if (!entry || played.current) return;
    played.current = true;
    const animate = !entry.played && motion.enabled;
    entry.played = true;
    if (!animate) { progress.setValue(1); return; }
    progress.setValue(0);
    const animation = Animated.timing(progress, { toValue: 1, delay: entry.delay, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web', isInteraction: false });
    animation.start();
    return () => { animation.stop(); progress.setValue(1); };
  }, [entry, motion.enabled, progress]);
  return <Animated.View testID="stagger-item" style={{ opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }), transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }}>{children}</Animated.View>;
}
