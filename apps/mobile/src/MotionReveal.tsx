import React, { useLayoutEffect, useState } from 'react';
import { Animated } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useUI } from './ui';
import { useMotionValue } from './motion';

export default function MotionReveal({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { motion } = useUI(), [shown, setShown] = useState(false);
  const progress = useMotionValue(shown ? 1 : 0, motion.enabled);
  useLayoutEffect(() => { setShown(true); }, []);
  return <Animated.View style={[style, motion.enabled && { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }), transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}>{children}</Animated.View>;
}
