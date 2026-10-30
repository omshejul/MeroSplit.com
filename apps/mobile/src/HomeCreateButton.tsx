import React from 'react';
import { View } from 'react-native';
import { pageWidthStyle } from './pageLayout';

import AddActionButton from './AddActionButton';

// Navigation owns the safe area; this footer only lays out the action.
export default function HomeCreateButton({ direct, disabled, onPress }: { direct: boolean; disabled: boolean; onPress: () => void }) {
  return <View pointerEvents="box-none" style={[pageWidthStyle, { width: '100%', alignItems: 'flex-end', paddingHorizontal: 16, paddingBottom: 16 }]}><AddActionButton title={direct ? 'Add person' : 'Add group'} disabled={disabled} onPress={onPress} /></View>;
}
