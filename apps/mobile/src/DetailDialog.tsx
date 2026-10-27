import React, { useState } from 'react';
import { View } from 'react-native';
import KeyboardDialog from './KeyboardDialog';
import { Dialog, DialogScrollBody } from './DialogParts';
import { Button, SettingsRow, type IconName } from './ui';

// Details open in a separate surface, leaving the surrounding screen in place.
export default function DetailDialog({ title, children, initialOpen = false, icon = 'info', busy = false }: {
  title: string; children: React.ReactNode; initialOpen?: boolean; icon?: IconName; busy?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return <>
    <SettingsRow icon={icon} label={title} disabled={busy} onPress={() => setOpen(true)} />
    <KeyboardDialog visible={open} dismissable={!busy} onDismiss={() => { if (!busy) setOpen(false); }}>
      <Dialog.Title icon={icon}>{title}</Dialog.Title>
      <DialogScrollBody maxHeight={520} gap={12}><View style={{ gap: 12 }}>{children}</View></DialogScrollBody>
      <Dialog.Actions><Button title="Done" icon="check" disabled={busy} onPress={() => setOpen(false)} /></Dialog.Actions>
    </KeyboardDialog>
  </>;
}
