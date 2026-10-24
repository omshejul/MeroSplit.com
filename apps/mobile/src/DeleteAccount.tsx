import React, { useRef, useState } from 'react';
import { ScrollView, useWindowDimensions } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import { accountDeletionInput } from './accountDeletion';
import { EmailField, TextField } from './FormFields';
import KeyboardDialog from './KeyboardDialog';
import { Button, ErrorText, SettingsRow, useUI } from './ui';

export default function DeleteAccount({ email: currentEmail, busy, onDelete }: { email: string; busy: boolean; onDelete: (body: { confirmation: 'delete'; email: string }) => Promise<void> }) {
  const { ui } = useUI(), { height } = useWindowDimensions();
  const [open, setOpen] = useState(false), [confirmation, setConfirmation] = useState(''), [email, setEmail] = useState(''), [error, setError] = useState(''), [working, setWorking] = useState(false);
  const lock = useRef(false), disabled = busy || working;
  let valid = false;
  try { accountDeletionInput(confirmation, email, currentEmail); valid = true; } catch { /* The button stays disabled until both fields match. */ }
  async function remove() {
    if (disabled || lock.current) return;
    try {
      const body = accountDeletionInput(confirmation, email, currentEmail);
      lock.current = true; setWorking(true); setError(''); await onDelete(body); setOpen(false);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not delete the account. Try again.'); }
    finally { lock.current = false; setWorking(false); }
  }
  return <>
    <SettingsRow label="Delete account" icon="remove" danger chevron={false} disabled={busy} onPress={() => { setConfirmation(''); setEmail(''); setError(''); setOpen(true); }} />
    <KeyboardDialog visible={open} onDismiss={() => { if (!disabled) setOpen(false); }} dismissable={!disabled} maxHeight={height}>
      <Dialog.Title>Delete account?</Dialog.Title>
      <Dialog.Content style={{ flexShrink: 1 }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
        <Text style={ui.body}>Export first. Your account, files and unsent work will be deleted. Other members keep anonymous amounts and payment history.</Text>
        <TextField label="Type delete" value={confirmation} onChangeText={setConfirmation} autoCorrect={false} autoCapitalize="none" editable={!disabled} />
        <EmailField label="Current email" value={email} onChangeText={setEmail} editable={!disabled} />
        {!!error && <ErrorText live>{error}</ErrorText>}
      </ScrollView></Dialog.Content>
      <Dialog.Actions><Button title="Cancel" kind="text" disabled={disabled} onPress={() => setOpen(false)} /><Button title="Delete account" icon="remove" disabled={disabled || !valid} onPress={() => void remove()} /></Dialog.Actions>
    </KeyboardDialog>
  </>;
}
