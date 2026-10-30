import FloatingActionContainer from './FloatingActionContainer';
import React from 'react';

import AddActionButton from './AddActionButton';

// Reserve a footer in layout so tab switches cannot place the action under navigation.
export default function HomeCreateButton({ direct, disabled, onPress }: { direct: boolean; disabled: boolean; onPress: () => void }) {
  return <FloatingActionContainer home><AddActionButton title={direct ? 'Add person' : 'Add group'} disabled={disabled} onPress={onPress} /></FloatingActionContainer>;
}
