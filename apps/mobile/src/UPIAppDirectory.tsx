import React, { useState } from 'react';
import { Linking, Platform } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import KeyboardDialog from './KeyboardDialog';
import DialogFocus from './DialogFocus';
import { DialogScrollBody } from './DialogParts';
import { TextField } from './FormFields';
import { Button, ErrorText, SettingsRow, useUI } from './ui';
import { upiDirectory, upiDirectoryLink } from './upiDirectory';

// Store discovery is separate from launching or recording a payment.
export default function UPIAppDirectory({ disabled = false }: { disabled?: boolean }) {
  const { ui } = useUI();
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [error, setError] = useState('');
  function close() { setOpen(false); setQuery(''); setError(''); }
  return <>
    <Button title="Find another UPI app" kind="text" disabled={disabled} onPress={() => setOpen(true)} />
    <KeyboardDialog visible={open} onDismiss={close}>
      <DialogFocus active={open} onEscape={close}>
        <Dialog.Title aria-level={2}>Find a UPI app</Dialog.Title>
        <DialogScrollBody maxHeight={400} gap={8}>
          <TextField label="Search apps" value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" />
          {upiDirectory.filter(app => app.name.toLowerCase().includes(query.trim().toLowerCase())).map(app => {
            const link = upiDirectoryLink(app, Platform.OS);
            return <SettingsRow key={app.name} icon="phone" label={app.name} external onPress={() => {
              setError('');
              void Linking.openURL(link.url).catch(() => setError(`Could not open ${app.name}. Try again.`));
            }} />;
          })}
          {!upiDirectory.some(app => app.name.toLowerCase().includes(query.trim().toLowerCase())) && <Text style={ui.caption}>No apps found</Text>}
          {!!error && <ErrorText live>{error}</ErrorText>}
        </DialogScrollBody>
        <Dialog.Actions><Button title="Done" kind="text" onPress={close} /></Dialog.Actions>
      </DialogFocus>
    </KeyboardDialog>
  </>;
}
