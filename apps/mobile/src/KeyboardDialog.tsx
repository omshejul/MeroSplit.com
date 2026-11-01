import LoadingOverlay from './LoadingOverlay';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, useWindowDimensions } from 'react-native';
import { Dialog, Modal, Portal } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUI } from './ui';
import { motionDuration } from './motion';
import { DialogContext } from './DialogContext';
import DialogFocus from './DialogFocus';

// Keep the measuring ancestor mounted, but mount native Paper content already visible.
export default function KeyboardDialog({ visible, onDismiss, dismissable = true, maxHeight, children, label, blocksAppRestart = true, placement = 'center' }: {
  visible: boolean; onDismiss: () => void; dismissable?: boolean; maxHeight?: number; children: React.ReactNode; label?: string; blocksAppRestart?: boolean; placement?: 'center' | 'bottom';
}) {
  const { width, height: windowHeight } = useWindowDimensions();
  const { motion, palette } = useUI();
  const { top, bottom, left = 0, right = 0 } = useSafeAreaInsets(), [height, setHeight] = useState<number>();
  // Bound opted-in cards to the actual keyboard-resized parent, not just the window.
  const available = Math.max(0, Math.min(maxHeight ?? Infinity, Math.min(height ?? windowHeight, windowHeight) - top - bottom - 32));
  const sheet = placement === 'bottom', Container = sheet ? Modal : Dialog;
  const card = { flexShrink: 1, paddingTop: 0, marginVertical: 0, marginHorizontal: sheet ? 0 : 16, borderRadius: 12, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, maxHeight: available, width: Math.min(480, Math.max(0, width - 2 * Math.max(sheet ? 0 : 16, left, right))), alignSelf: 'center' as const };
  return <Portal><KeyboardAvoidingView behavior="height" style={{ flex: 1 }} pointerEvents="box-none" onLayout={event => setHeight(event.nativeEvent.layout.height)}>
    {(Platform.OS === 'web' || visible) && <Container visible={visible} onDismiss={onDismiss} dismissable={dismissable} dismissableBackButton={dismissable} theme={{ animation: { scale: visible && motion?.enabled ? motionDuration.paperScale : 0 } }} {...(sheet ? { style: { justifyContent: 'flex-end' as const, marginTop: 0, marginBottom: 0 }, contentContainerStyle: { ...card, paddingBottom: bottom, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderLeftWidth: 0, borderRightWidth: 0, borderBottomWidth: 0 } } : { style: card })}>
      <DialogContext.Provider value={{ onDismiss, dismissable, bodyHeight: Math.max(64, available - 136 - (sheet ? bottom : 0)) }}>
        <DialogFocus label={label} active={visible} modal={blocksAppRestart} busy={!dismissable} onEscape={onDismiss}>{children}</DialogFocus>
      </DialogContext.Provider>
    </Container>}
    {visible && <LoadingOverlay inline />}
  </KeyboardAvoidingView></Portal>;
}
