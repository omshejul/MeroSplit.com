import FloatingActionContainer from './FloatingActionContainer';
import React from 'react';

import AddActionButton from './AddActionButton';

// Custom tabs already sit outside the content area. Native iOS tabs overlay it.
export default function HomeCreateButton({ direct, disabled, onPress, onHeight }: { direct: boolean; disabled: boolean; onPress: () => void; onHeight?: (height: number) => void }) {
  return <FloatingActionContainer home onHeight={onHeight}><AddActionButton title={direct ? 'Add person' : 'Add group'} disabled={disabled} onPress={onPress} /></FloatingActionContainer>;
}
