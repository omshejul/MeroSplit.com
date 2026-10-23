import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { Text } from 'react-native-paper';
import { TextField } from './FormFields';
import { Button, useUI } from './ui';
import { AppFrame, pageContentStyle, ScreenHeader } from './AppNavigation';

export function EmailLinkScreen({ title, busy, children }: { title: string; busy: boolean; children: React.ReactNode }) {
  return <AppFrame>
    <ScreenHeader title={title} busy={busy} />
    <ScrollView contentContainerStyle={pageContentStyle} keyboardShouldPersistTaps="handled">{children}</ScrollView>
  </AppFrame>;
}

export function EmailLinkStatus({ opening, error, sent, canRenew, busy, onRetry, onRenew, onSignIn }: { opening: boolean; error: string; sent: boolean; canRenew: boolean; busy: boolean; onRetry: () => void; onRenew: () => void; onSignIn: () => void }) {
  const { ui } = useUI();
  return <View style={{ gap: 12 }}>
    {opening ? <><ActivityIndicator accessibilityLabel="Opening" /><Text style={ui.body}>Opening…</Text></> : <>
      <Text accessibilityRole={error ? 'alert' : undefined} style={error ? ui.error : ui.body}>{sent ? 'New link sent.' : error}</Text>
      {canRenew && <Button title="Send new link" kind="primary" disabled={busy} onPress={onRenew} />}
      <Button title="Try again" disabled={busy} onPress={onRetry} />
      <Button title={canRenew ? 'Open MeroSplit' : 'Sign in'} kind="text" disabled={busy} onPress={onSignIn} />
    </>}
  </View>;
}
export function EmailLinkSent({ busy, resendSeconds, onResend, onCode, onChangeEmail }: { busy: boolean; resendSeconds: number; onResend: () => void; onCode: () => void; onChangeEmail: () => void }) {
  const { ui } = useUI();
  return <View style={{ gap: 12 }}><Text style={ui.body}>Open the sign-in link in your email.</Text>
    <Button title={resendSeconds > 0 ? `Resend in ${resendSeconds}s` : 'Send new link'} disabled={busy || resendSeconds > 0} onPress={onResend} />
    <Button title="Use a code instead" kind="text" disabled={busy} onPress={onCode} />
    <Button title="Use another email" kind="text" disabled={busy} onPress={onChangeEmail} />
  </View>;
}
export function NameOnlyForm({ busy, onSave }: { busy: boolean; onSave: (name: string) => Promise<void> }) {
  const { ui } = useUI();
  const [name, setName] = useState(''), [error, setError] = useState('');
  async function save() { setError(''); try { await onSave(name.trim()); } catch { setError('Could not save your name. Try again.'); } }
  return <View style={{ gap: 12 }}>
    <TextField label="Name" autoFocus value={name} maxLength={120} autoCapitalize="words" autoComplete="name" autoCorrect={false} editable={!busy} onChangeText={setName} returnKeyType="done" onSubmitEditing={() => { if (!busy && name.trim()) void save(); }} />
    {!!error && <Text accessibilityRole="alert" style={ui.error}>{error}</Text>}
    <Button title="Continue" kind="primary" disabled={busy || !name.trim()} onPress={() => void save()} />
  </View>;
}
