import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { motion } from 'framer-motion';
import { useUI } from './ui';

export default function MotionReveal({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { motion: preference } = useUI();
  return <motion.div initial={preference.enabled ? { opacity: 0.88, y: 6 } : false}
    animate={{ opacity: 1, y: 0 }} transition={{ duration: preference.enabled ? 0.18 : 0, ease: 'easeOut' }}
    style={StyleSheet.flatten(style) as React.CSSProperties}>{children}</motion.div>;
}
