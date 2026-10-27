import { Dialog } from './DialogParts';
import React from 'react';
import { Text } from 'react-native-paper';
import DialogFocus from './DialogFocus';
import KeyboardDialog from './KeyboardDialog';
import { CancelDialogActions, DialogScrollBody } from './DialogParts';
import { Button, useUI } from './ui';

export default function SwitchAccountDialog({ currentEmail, targetEmail, invitation, busy, onSwitch, onCancel }: {
  currentEmail: string; targetEmail: string; invitation: boolean; busy: boolean; onSwitch: () => void; onCancel: () => void;
}) {
  const { ui } = useUI();
  return <KeyboardDialog visible onDismiss={onCancel} dismissable={!busy}>
    <DialogFocus busy={busy} onEscape={onCancel}>
    <Dialog.Title aria-level={2}>Switch account?</Dialog.Title>
    <DialogScrollBody maxHeight={320} gap={8}>
      <Text style={ui.body}>You're signed in as {currentEmail}. This {invitation ? 'invitation' : 'link'} is for {targetEmail}. Switching will sign you out of {currentEmail} on this device.</Text>
    </DialogScrollBody>
    <CancelDialogActions disabled={busy} onCancel={onCancel}>
      <Button title="Switch" kind="primary" disabled={busy} onPress={onSwitch} />
    </CancelDialogActions>
    </DialogFocus>
  </KeyboardDialog>;
}
