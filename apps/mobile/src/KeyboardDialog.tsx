import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, useWindowDimensions } from 'react-native';
import { Dialog, Portal } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Keep mounted while hidden so height is measured before an input opens the keyboard.
export default function KeyboardDialog({ visible, onDismiss, dismissable = true, maxHeight, children }: {
  visible: boolean; onDismiss: () => void; dismissable?: boolean; maxHeight?: number; children: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  const { top, bottom, left = 0, right = 0 } = useSafeAreaInsets(), [height, setHeight] = useState<number>();
  // Bound opted-in cards to the actual keyboard-resized parent, not just the window.
  const available = maxHeight === undefined || height === undefined ? maxHeight : Math.max(0, Math.min(maxHeight, height - top - bottom));
  return <Portal><KeyboardAvoidingView behavior="height" style={{ flex: 1 }} pointerEvents="box-none" onLayout={event => setHeight(event.nativeEvent.layout.height)}>
    <Dialog visible={visible} onDismiss={onDismiss} dismissable={dismissable} style={{ flexShrink: 1, marginVertical: 0, maxHeight: available, ...(Platform.OS === 'web' && { width: Math.min(520, Math.max(0, width - 2 * Math.max(26, left, right))), alignSelf: 'center' }) }}>
      {children}
    </Dialog>
  </KeyboardAvoidingView></Portal>;
}
