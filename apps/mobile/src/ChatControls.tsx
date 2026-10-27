import { Dialog } from './DialogParts';
import React, { useState } from 'react';
import { Linking, ScrollView, View, useWindowDimensions } from 'react-native';
import { Menu, Text } from 'react-native-paper';
import type { ChatMessage } from './billChat';
import { TextField } from './FormFields';
import KeyboardDialog from './KeyboardDialog';
import { Icon, Button, SettingsRow, useUI } from './ui';

export function ChatMenu({ own, disabled, onReport, onBlock }: { own: boolean; disabled: boolean; onReport: (kind: 'message' | 'user') => void; onBlock: () => void }) {
  const [open, setOpen] = useState(false);
  if (own) return null;
  return <Menu visible={open} onDismiss={() => setOpen(false)} anchor={<Button iconOnly icon="more" kind="text" accessibilityLabel="Message options" disabled={disabled} onPress={() => setOpen(true)} />}>
    <Button kind="menu" icon="feedback" title="Report message" onPress={() => { setOpen(false); onReport('message'); }} />
    <Button kind="menu" icon="me" title="Report user" onPress={() => { setOpen(false); onReport('user'); }} />
    <Button kind="menu" icon="privacy" title="Block chat user" onPress={() => { setOpen(false); onBlock(); }} />
  </Menu>;
}
export default function ChatControls({ report, blocked, policyUrl, busy, error, onClose, onReport, onUnblock }: {
  report: { message: ChatMessage; kind: 'message' | 'user' } | null;
  blocked: { id: string; name: string }[] | null; policyUrl: string; busy: boolean; error: string;
  onClose: () => void; onReport: (reason: string) => void; onUnblock: (id: string) => void;
}) {
  const { ui } = useUI(), { height } = useWindowDimensions(), [reason, setReason] = useState('');
  return <KeyboardDialog visible={!!report || blocked !== null} onDismiss={onClose} dismissable={!busy} maxHeight={height * 0.9}>
    <Dialog.Title aria-level={2}>{report ? `Report ${report.kind}` : 'Chat settings'}</Dialog.Title>
    <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }} keyboardShouldPersistTaps="handled">
      {report ? <><Text style={ui.body}>Tell support what happened. Reports are private.</Text><TextField label="Reason" multiline maxLength={500} value={reason} onChangeText={setReason} editable={!busy} /></> : <>
        <SettingsRow icon="privacy" label="Chat policy" external onPress={() => void Linking.openURL(policyUrl)} />
        <SettingsRow icon="help" label="Support" external onPress={() => void Linking.openURL('mailto:mail@merosplit.com')} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8 }}><Icon name="privacy" size={18} /><Text style={ui.label}>Blocked chat users</Text></View>
        {!blocked?.length && <Text style={[ui.caption, { paddingLeft: 26, paddingBottom: 12 }]}>People you block will appear here.</Text>}
        {blocked?.map(row => <SettingsRow key={row.id} label={row.name} value="Unblock" icon="people" chevron={false} disabled={busy} onPress={() => onUnblock(row.id)} />)}
      </>}
      {!!error && <Text accessibilityRole="alert" style={ui.error}>{error}</Text>}
    </ScrollView>
    <Dialog.Actions>{report && <Button title="Cancel" kind="text" disabled={busy} onPress={onClose} />}<Button title={report ? 'Send report' : 'Done'} icon={report ? 'feedback' : 'check'} kind={report ? 'primary' : 'secondary'} disabled={busy || !!report && !reason.trim()} onPress={() => report ? onReport(reason) : onClose()} /></Dialog.Actions>
  </KeyboardDialog>;
}
