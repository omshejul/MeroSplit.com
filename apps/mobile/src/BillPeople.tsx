import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import KeyboardDialog from './KeyboardDialog';
import { Button, Icon, useUI } from './ui';

export default function BillPeople({ title, summary, inline, disabled, children }: {
  title: string; summary: string; inline: boolean; disabled: boolean; children: React.ReactNode;
}) {
  const { ui } = useUI(), [open, setOpen] = useState(false);
  const trigger = useRef<React.ComponentRef<typeof View>>(null);
  const close = () => { Keyboard.dismiss(); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open]);
  if (inline) return <View style={{ gap: 10 }}><Text style={ui.section}>{title}</Text>{children}</View>;
  return <>
    <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={`${title}. ${summary}`} disabled={disabled} accessibilityState={{ disabled }} onPress={() => { if (!disabled) setOpen(true); }} style={ui.row}>
      <View style={ui.rowBody}><Text style={ui.label}>{title}</Text><Text style={ui.body}>{summary}</Text></View><Icon name="next" size={18} />
    </Pressable>
    <KeyboardDialog visible={open} onDismiss={close}>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Content style={{ flexShrink: 1 }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>{children}</ScrollView></Dialog.Content>
      <Dialog.Actions><Button title="Done" kind="text" onPress={close} /></Dialog.Actions>
    </KeyboardDialog>
  </>;
}
