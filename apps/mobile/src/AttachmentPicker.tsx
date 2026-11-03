import React, { useEffect } from 'react';
import { BackHandler, Platform } from 'react-native';
import { Menu } from 'react-native-paper';
import { Button, useUI } from './ui';
import { useDialogRegistration } from './DialogFocus';
import { canTakePhoto } from './cameraSupport';
import type { MediaSource } from './media';

export function AttachmentOptions({ disabled, onPick }: { disabled: boolean; onPick: (source: MediaSource) => void }) {
  return <>
    {canTakePhoto() && <Button title="Take photo" icon="camera" kind="menu" accessibilityRole="menuitem" disabled={disabled} onPress={() => { if (!disabled) onPick('camera'); }} />}
    <Button title="Choose photo" icon="photo" kind="menu" accessibilityRole="menuitem" disabled={disabled} onPress={() => { if (!disabled) onPick(true); }} />
    <Button title="Choose file" icon="file" kind="menu" accessibilityRole="menuitem" disabled={disabled} onPress={() => { if (!disabled) onPick(false); }} />
  </>;
}

// Paper Menu measures this exact anchor and expands from it. Its theme also
// disables the transition when the user requests reduced motion.
export default function AttachmentPicker({ visible, disabled, anchor, onDismiss, onPick }: {
  visible: boolean; disabled: boolean; anchor: React.ReactNode; onDismiss: () => void; onPick: (source: MediaSource) => void;
}) {
  const { palette } = useUI();
  useDialogRegistration(visible && !disabled);
  useEffect(() => {
    if (!visible || disabled || Platform.OS === 'web') return;
    // Paper dismisses on Back but does not consume it. Keep navigation in place.
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onDismiss(); return true; });
    return () => subscription.remove();
  }, [visible, disabled, onDismiss]);
  return <Menu visible={visible && !disabled} anchor={anchor} anchorPosition="bottom" onDismiss={onDismiss} overlayAccessibilityLabel="Close attachment picker"
    contentStyle={{ width: 248, padding: 4, borderRadius: 12, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}>
    <AttachmentOptions disabled={disabled} onPick={source => { if (!disabled) { onDismiss(); onPick(source); } }} />
  </Menu>;
}
