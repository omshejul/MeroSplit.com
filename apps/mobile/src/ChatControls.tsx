import React, { useState } from 'react';
import { Linking, ScrollView, View, useWindowDimensions } from 'react-native';
import { Dialog, IconButton, Menu, Text } from 'react-native-paper';
import { HugeiconsIcon } from '@hugeicons/react-native';
import MoreVerticalIcon from '@hugeicons/core-free-icons/MoreVerticalIcon';
import type { ChatMessage } from './billChat';
import { TextField } from './FormFields';
import KeyboardDialog from './KeyboardDialog';
import { Button, SettingsRow, useUI } from './ui';

export function ChatMenu({ own, disabled, onReport, onBlock }: { own: boolean; disabled: boolean; onReport: (kind: 'message' | 'user') => void; onBlock: () => void }) {
  const [open, setOpen] = useState(false);
  if (own) return null;
  return <Menu visible={open} onDismiss={() => setOpen(false)} anchor={<IconButton accessibilityLabel="Message options" disabled={disabled} onPress={() => setOpen(true)} style={{ margin: 0 }} icon={({ color, size }) => <HugeiconsIcon icon={MoreVerticalIcon} color={color} size={size} />} />}>
    <Menu.Item title="Report message" onPress={() => { setOpen(false); onReport('message'); }} />
    <Menu.Item title="Report user" onPress={() => { setOpen(false); onReport('user'); }} />
    <Menu.Item title="Block chat user" onPress={() => { setOpen(false); onBlock(); }} />
  </Menu>;
}
export default function ChatControls({ report, blocked, policyUrl, busy, error, onClose, onReport, onUnblock }: {
  report: { message: ChatMessage; kind: 'message' | 'user' } | null;
  blocked: { id: string; name: string }[] | null; policyUrl: string; busy: boolean; error: string;
  onClose: () => void; onReport: (reason: string) => void; onUnblock: (id: string) => void;
}) {
  const { ui } = useUI(), { height } = useWindowDimensions(), [reason, setReason] = useState('');
  return <KeyboardDialog visible={!!report || blocked !== null} onDismiss={onClose} dismissable={!busy} maxHeight={height * 0.9}>
    <Dialog.Title>{report ? `Report ${report.kind}` : 'Chat settings'}</Dialog.Title>
    <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingHorizontal: 24, gap: 12 }} keyboardShouldPersistTaps="handled">
      {report ? <><Text style={ui.body}>Tell support what happened. Reports are private.</Text><TextField label="Reason" multiline maxLength={500} value={reason} onChangeText={setReason} editable={!busy} /></> : <>
        <Button title="Chat policy" kind="text" onPress={() => void Linking.openURL(policyUrl)} />
        <Button title="Support" kind="text" onPress={() => void Linking.openURL('mailto:mail@merosplit.com')} />
        <Text style={ui.section}>Blocked chat users</Text>
        {!blocked?.length && <Text style={ui.caption}>No blocked users.</Text>}
        {blocked?.map(row => <SettingsRow key={row.id} label={row.name} value="Unblock" icon="people" chevron={false} disabled={busy} onPress={() => onUnblock(row.id)} />)}
      </>}
      {!!error && <Text accessibilityRole="alert" style={ui.error}>{error}</Text>}
    </ScrollView>
    <Dialog.Actions><View style={{ flex: 1, gap: 8 }}>{report && <Button title="Send report" kind="primary" disabled={busy || !reason.trim()} onPress={() => onReport(reason)} />}<Button title="Done" kind="text" disabled={busy} onPress={onClose} /></View></Dialog.Actions>
  </KeyboardDialog>;
}
