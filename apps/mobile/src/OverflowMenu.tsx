import React from 'react';
import { Menu } from 'react-native-paper';
import { Button } from './ui';

export default function OverflowMenu({ open, disabled, label, onOpen, onClose, children }: {
  open: boolean; disabled: boolean; label: string; onOpen: () => void; onClose: () => void; children: React.ReactNode;
}) {
  return <Menu visible={open} onDismiss={onClose} anchor={<Button iconOnly icon="more" kind="text" accessibilityLabel={label} disabled={disabled} onPress={onOpen} />}>{children}</Menu>;
}
