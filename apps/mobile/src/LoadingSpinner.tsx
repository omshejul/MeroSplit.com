import React from 'react';
import { ActivityIndicator } from 'react-native';
import { useUI } from './ui';

export default function LoadingSpinner({ visible, label = 'Working', color }: { visible: boolean; label?: string; color?: string }) {
  const { palette } = useUI();
  return visible ? <ActivityIndicator accessibilityLabel={label} color={color ?? palette.accent} /> : null;
}
