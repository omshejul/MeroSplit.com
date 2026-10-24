import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import KeyboardDialog from './KeyboardDialog';
import { SectionHeading, Button, Icon, useUI, type IconName } from './ui';

export default function BillPeople({ title, icon, summary, inline, disabled, children }: {
  title: string; icon: IconName; summary: string; inline: boolean; disabled: boolean; children: React.ReactNode;
}) {
  const { ui } = useUI(), [open, setOpen] = useState(false);
  const { height } = useWindowDimensions(), { top, bottom } = useSafeAreaInsets();
  const trigger = useRef<React.ComponentRef<typeof View>>(null);
  const close = () => { Keyboard.dismiss(); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open]);
  if (inline) return <View style={{ gap: 10 }}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Icon name={icon} /><SectionHeading>{title}</SectionHeading></View>{children}</View>;
  return <>
    <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={`${title}. ${summary}`} disabled={disabled} accessibilityState={{ disabled }} onPress={() => { if (!disabled) setOpen(true); }} style={ui.row}>
      <Icon name={icon} /><View style={ui.rowBody}><Text style={ui.label}>{title}</Text><Text style={ui.body}>{summary}</Text></View><Icon name="next" size={18} />
    </Pressable>
    <KeyboardDialog visible={open} onDismiss={close} maxHeight={Math.max(0, height - top - bottom)}>
      <Dialog.Title aria-level={2}><Icon name={icon} /> {title}</Dialog.Title>
      <Dialog.Content style={{ flexShrink: 1 }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>{children}</ScrollView></Dialog.Content>
      <Dialog.Actions><Button title="Done" icon="check" kind="text" onPress={close} /></Dialog.Actions>
    </KeyboardDialog>
  </>;
}
