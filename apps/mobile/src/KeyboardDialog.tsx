import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, useWindowDimensions } from 'react-native';
import { Dialog, Portal } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUI } from './ui';
import { motionDuration } from './motion';
import { DialogContext } from './DialogContext';
import DialogFocus from './DialogFocus';

// Keep the measuring ancestor mounted, but mount native Paper content already visible.
export default function KeyboardDialog({ visible, onDismiss, dismissable = true, maxHeight, children, label, blocksAppRestart = true }: {
  visible: boolean; onDismiss: () => void; dismissable?: boolean; maxHeight?: number; children: React.ReactNode; label?: string; blocksAppRestart?: boolean;
}) {
  const { width, height: windowHeight } = useWindowDimensions();
  const { motion, palette } = useUI();
  const { top, bottom, left = 0, right = 0 } = useSafeAreaInsets(), [height, setHeight] = useState<number>();
  // Bound opted-in cards to the actual keyboard-resized parent, not just the window.
  const available = Math.max(0, Math.min(maxHeight ?? Infinity, Math.min(height ?? windowHeight, windowHeight) - top - bottom - 32));
  return <Portal><KeyboardAvoidingView behavior="height" style={{ flex: 1 }} pointerEvents="box-none" onLayout={event => setHeight(event.nativeEvent.layout.height)}>
    {(Platform.OS === 'web' || visible) && <Dialog visible={visible} onDismiss={onDismiss} dismissable={dismissable} dismissableBackButton={dismissable} theme={{ animation: { scale: visible && motion?.enabled ? motionDuration.paperScale : 0 } }} style={{ flexShrink: 1, paddingTop: 0, marginVertical: 0, marginHorizontal: 16, borderRadius: 12, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, maxHeight: available, width: Math.min(480, Math.max(0, width - 2 * Math.max(16, left, right))), alignSelf: 'center' }}>
      <DialogContext.Provider value={{ onDismiss, dismissable, bodyHeight: Math.max(64, available - 136) }}>
        <DialogFocus label={label} active={visible} modal={blocksAppRestart} busy={!dismissable} onEscape={onDismiss}>{children}</DialogFocus>
      </DialogContext.Provider>
    </Dialog>}
  </KeyboardAvoidingView></Portal>;
}
