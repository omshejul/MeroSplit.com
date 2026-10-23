import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import KeyboardDialog from './KeyboardDialog';
import { Button, SettingsRow, useUI } from './ui';

export default function ExportData({ busy, onAccount, onSaved }: {
  busy: boolean; onAccount: () => Promise<unknown>; onSaved: () => Promise<unknown>;
}) {
  const { ui } = useUI(), [open, setOpen] = useState(false), [selection, setSelection] = useState<'account' | 'saved' | null>(null);
  const { height } = useWindowDimensions(), { top, bottom } = useSafeAreaInsets();
  const locked = useRef(false), trigger = useRef<React.ComponentRef<typeof View>>(null);
  const close = () => { Keyboard.dismiss(); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  function choose(value: NonNullable<typeof selection>) { if (busy || locked.current) return; locked.current = true; setOpen(false); setSelection(value); }
  useEffect(() => {
    if (!selection) return;
    let active = true;
    // The chooser's Portal is removed in this commit before native sharing starts.
    void Promise.resolve().then(() => { if (active) return selection === 'account' ? onAccount() : onSaved(); })
      .finally(() => { locked.current = false; if (active) setSelection(null); }).catch(() => {});
    return () => { active = false; };
  }, [selection]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !open || busy) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open, busy]);
  return <>
    <SettingsRow rowRef={trigger} label="Export data" icon="export" disabled={busy || !!selection} onPress={() => { if (!busy && !locked.current) setOpen(true); }} />
    {!selection && <KeyboardDialog visible={open} onDismiss={() => { if (!busy) close(); }} dismissable={!busy} maxHeight={Math.max(0, height - top - bottom)}>
      <Dialog.Title>Export data</Dialog.Title>
      <Dialog.Content style={{ flexShrink: 1 }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
        <SettingsRow label="Account data" icon="export" chevron={false} disabled={busy} onPress={() => choose('account')} />
        <Text style={ui.body}>Synced account history. Requires a connection.</Text>
        <SettingsRow label="Saved work" icon="export" chevron={false} disabled={busy} onPress={() => choose('saved')} />
        <Text style={ui.body}>Drafts, unsent changes and recovery records on this device. Available offline.</Text>
      </ScrollView></Dialog.Content>
      <Dialog.Actions><Button title="Done" kind="text" disabled={busy} onPress={close} /></Dialog.Actions>
    </KeyboardDialog>}
  </>;
}
