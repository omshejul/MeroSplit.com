import OverflowMenu from './OverflowMenu';
import React from 'react';

import { Button } from './ui';

export default function RemoveMediaMenu({ open, disabled, label, removeLabel, onOpen, onClose, onRemove }: {
  open: boolean; disabled: boolean; label: string; removeLabel: string;
  onOpen: () => void; onClose: () => void; onRemove: () => void;
}) {
  return <OverflowMenu open={open} onClose={onClose} onOpen={onOpen} disabled={disabled} label={label}>
    <Button kind="menu" icon="remove" title={removeLabel} disabled={disabled} onPress={() => { onClose(); onRemove(); }} />
  </OverflowMenu>;
}
