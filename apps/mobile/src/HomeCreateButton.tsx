import React from 'react';
import { View } from 'react-native';
import { pageWidthStyle } from './pageLayout';

import FloatingActionContainer from './FloatingActionContainer';
import { usesNativeHomeTabs } from './HomeTabs';

import AddActionButton from './AddActionButton';

// Native glass tabs overlay the list; custom tabs keep their normal-flow footer.
export default function HomeCreateButton({ direct, disabled, onPress, onHeight }: { direct: boolean; disabled: boolean; onPress: () => void; onHeight?: (height: number) => void }) {
  const action = <AddActionButton title={direct ? 'Add person' : 'Add group'} disabled={disabled} onPress={onPress} />;
  if (usesNativeHomeTabs) return <FloatingActionContainer onHeight={onHeight}>{action}</FloatingActionContainer>;
  return <View pointerEvents="box-none" style={[pageWidthStyle, { width: '100%', alignItems: 'flex-end', paddingHorizontal: 16, paddingBottom: 16 }]}>{action}</View>;
}
