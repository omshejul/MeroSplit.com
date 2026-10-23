import React from 'react';
import { ScrollView } from 'react-native';
import { Dialog } from 'react-native-paper';
import { Button } from './ui';

// Inputs/choices scroll while the separate action footer remains reachable.
export function DialogScrollBody({ maxHeight, gap, paddingVertical = 12, children }: {
  maxHeight: number; gap: number; paddingVertical?: number; children: React.ReactNode;
}) {
  return <Dialog.ScrollArea style={{ maxHeight }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical, gap }}>{children}</ScrollView>
  </Dialog.ScrollArea>;
}

export function CancelDialogActions({ disabled, onCancel, children }: {
  disabled: boolean; onCancel: () => void; children?: React.ReactNode;
}) {
  return <Dialog.Actions>
    <Button title="Cancel" kind="text" disabled={disabled} onPress={onCancel} />
    {children}
  </Dialog.Actions>;
}
