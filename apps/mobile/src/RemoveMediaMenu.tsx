import React from 'react';
import { IconButton, Menu } from 'react-native-paper';
import { HugeiconsIcon } from '@hugeicons/react-native';
import MoreVerticalIcon from '@hugeicons/core-free-icons/MoreVerticalIcon';

export default function RemoveMediaMenu({ open, disabled, label, removeLabel, onOpen, onClose, onRemove }: {
  open: boolean; disabled: boolean; label: string; removeLabel: string;
  onOpen: () => void; onClose: () => void; onRemove: () => void;
}) {
  return <Menu visible={open} onDismiss={onClose} anchor={<IconButton accessibilityLabel={label} disabled={disabled}
    style={{ width: 48, height: 48, margin: 0 }} icon={({ color, size }) => <HugeiconsIcon icon={MoreVerticalIcon} color={color} size={size} />} onPress={onOpen} />}>
    <Menu.Item title={removeLabel} disabled={disabled} onPress={() => { onClose(); onRemove(); }} />
  </Menu>;
}
