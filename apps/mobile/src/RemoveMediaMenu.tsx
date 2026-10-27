import React from 'react';
import { Menu } from 'react-native-paper';
import { Button } from './ui';

export default function RemoveMediaMenu({ open, disabled, label, removeLabel, onOpen, onClose, onRemove }: {
  open: boolean; disabled: boolean; label: string; removeLabel: string;
  onOpen: () => void; onClose: () => void; onRemove: () => void;
}) {
  return <Menu visible={open} onDismiss={onClose} anchor={<Button iconOnly icon="more" kind="text" accessibilityLabel={label} disabled={disabled} onPress={onOpen} />}>
    <Button kind="menu" icon="remove" title={removeLabel} disabled={disabled} onPress={() => { onClose(); onRemove(); }} />
  </Menu>;
}
