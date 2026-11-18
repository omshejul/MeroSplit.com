import React, { useLayoutEffect, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { transactionLiftTiming } from './motionShared';
import { useUI } from './ui';

// Owned by the transaction list, so recycling a row cannot replay its entrance.
export type ListEntry = { delay: number; played: boolean };
export default function StaggerItem({ entry, children, lifted = false }: { entry?: ListEntry; lifted?: boolean; children: React.ReactNode }) {
  const { motion } = useUI();
  const lift = useRef(new Animated.Value(0)).current;
  useLayoutEffect(() => {
    if (!lifted || !motion.enabled) return;
    const driver = { useNativeDriver: Platform.OS !== 'web', isInteraction: false };
    const animation = Animated.sequence([
      Animated.timing(lift, { ...driver, toValue: -2, duration: transactionLiftTiming.rise, easing: Easing.bezier(0.22, 0.61, 0.36, 1) }),
      Animated.delay(transactionLiftTiming.hold),
      Animated.timing(lift, { ...driver, toValue: 0, duration: transactionLiftTiming.return, easing: Easing.bezier(0.32, 0, 0.28, 1) }),
    ]);
    animation.start();
    return () => { animation.stop(); lift.setValue(0); };
  }, [lift, lifted, motion.enabled]);
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
  return <Animated.View testID="stagger-item" style={{ opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }), transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }, { translateY: lift }] }}>{children}</Animated.View>;
}
