import React from 'react';
import { Platform, ScrollView } from 'react-native';
import { Dialog } from 'react-native-paper';
import { Button } from './ui';

// Inputs/choices scroll while the separate action footer remains reachable.
export function DialogScrollBody({ maxHeight, gap, paddingVertical = 12, paddingHorizontal, children }: {
  maxHeight: number; gap: number; paddingVertical?: number; paddingHorizontal?: number; children: React.ReactNode;
}) {
  return <Dialog.ScrollArea style={{ maxHeight, ...(paddingHorizontal !== undefined && { paddingHorizontal }) }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical, gap, paddingRight: Platform.OS === 'web' ? 16 : 0 }}>{children}</ScrollView>
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
