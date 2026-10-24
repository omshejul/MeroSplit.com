import React from 'react';
import { Animated, View } from 'react-native';
import { useUI } from './ui';
import { useRouteMotion, type MotionRoute } from './motion';

export default function MotionScreen({ route, children }: { route: MotionRoute; children: React.ReactNode }) {
  const { motion } = useUI();
  const position = useRouteMotion(route, motion.enabled);
  return <View pointerEvents="box-none" style={{ flex: 1, overflow: 'hidden' }}>
    <Animated.View pointerEvents="box-none" style={{ flex: 1, transform: position.getTranslateTransform() }}>{children}</Animated.View>
  </View>;
}
