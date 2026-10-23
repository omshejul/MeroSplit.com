import React from 'react';
import { KeyboardAvoidingView } from 'react-native';
import { Dialog, Portal } from 'react-native-paper';

// Keep mounted while hidden so height is measured before an input opens the keyboard.
export default function KeyboardDialog({ visible, onDismiss, dismissable = true, maxHeight, children }: {
  visible: boolean; onDismiss: () => void; dismissable?: boolean; maxHeight?: number; children: React.ReactNode;
}) {
  return <Portal><KeyboardAvoidingView behavior="height" style={{ flex: 1 }} pointerEvents="box-none">
    <Dialog visible={visible} onDismiss={onDismiss} dismissable={dismissable} style={{ flexShrink: 1, marginVertical: 0, maxHeight }}>
      {children}
    </Dialog>
  </KeyboardAvoidingView></Portal>;
}
