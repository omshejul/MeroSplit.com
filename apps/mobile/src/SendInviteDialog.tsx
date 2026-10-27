import { Dialog } from './DialogParts';
import React from 'react';
import DialogFocus from './DialogFocus';
import { Text } from 'react-native-paper';
import { CancelDialogActions, DialogScrollBody } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import { Button, ErrorText, useUI } from './ui';

export default function SendInviteDialog({ visible, email, busy, error, onSend, onCancel }: {
  visible: boolean; email: string; busy: boolean; error: string; onSend: () => void; onCancel: () => void;
}) {
  const { ui } = useUI();
  return <KeyboardDialog visible={visible} dismissable={!busy} onDismiss={() => { if (!busy) onCancel(); }}>
    <DialogFocus active={visible} busy={busy} onEscape={onCancel}>
      <Dialog.Title aria-level={2}>Send invite?</Dialog.Title>
      <DialogScrollBody maxHeight={280} gap={8}>
        <Text style={ui.body}>Send an invite to {email}?</Text>
        {!!error && <ErrorText live>{error}</ErrorText>}
      </DialogScrollBody>
      <CancelDialogActions disabled={busy} onCancel={onCancel}>
        <Button title={busy ? 'Sending' : 'Send'} kind="primary" disabled={busy} onPress={onSend} />
      </CancelDialogActions>
    </DialogFocus>
  </KeyboardDialog>;
}
