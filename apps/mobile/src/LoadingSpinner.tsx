import React from 'react';
import { ActivityIndicator } from 'react-native';
import { useUI } from './ui';

export default function LoadingSpinner({ visible, label = 'Working' }: { visible: boolean; label?: string }) {
  const { palette } = useUI();
  return visible ? <ActivityIndicator accessibilityLabel={label} color={palette.accent} /> : null;
}
