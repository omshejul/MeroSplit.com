import React from 'react';
import { View } from 'react-native';
import { Icon, useUI } from './ui';
import type { IconName } from './ui';

export default function TransactionIcon({ name }: { name: IconName }) {
  const { palette } = useUI();
  return <View aria-hidden accessible={false} importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ width: 20, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
    <Icon name={name} size={18} color={palette.muted} />
  </View>;
}
