import ScrollBottomInset from './ScrollBottomInset';
import { LoadingState } from './UIStates';
import ResendControls from './ResendControls';
import { Dialog } from './DialogParts';
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from 'react-native-paper';

import KeyboardDialog from './KeyboardDialog';
import { DialogScrollBody } from './DialogParts';
import { TextField } from './FormFields';
import { Button, ErrorText, useUI } from './ui';
import { AppFrame, pageContentStyle, ScreenHeader } from './AppNavigation';

export function EmailLinkScreen({ title, busy, children }: { title: string; busy: boolean; children: React.ReactNode }) {
  return <AppFrame>
    <ScreenHeader title={title} brand busy={busy} />
    <ScrollView role="main" contentInsetAdjustmentBehavior="automatic" contentContainerStyle={pageContentStyle} keyboardShouldPersistTaps="handled">{children}<ScrollBottomInset /></ScrollView>
  </AppFrame>;
}
export function EmailLinkDialog({ title, children }: { title: string; children: React.ReactNode }) {
  return <KeyboardDialog visible dismissable={false} onDismiss={() => {}}>

    <Dialog.Title aria-level={2}>{title}</Dialog.Title>
    <DialogScrollBody maxHeight={400} gap={12}>{children}</DialogScrollBody>

  </KeyboardDialog>;
}

export function EmailLinkStatus({ opening, error, sent, canRenew, busy, onRetry, onRenew, onSignIn }: { opening: boolean; error: string; sent: boolean; canRenew: boolean; busy: boolean; onRetry: () => void; onRenew: () => void; onSignIn: () => void }) {
  const { ui } = useUI();
  return <View style={{ gap: 12 }}>
    {opening ? <LoadingState label="Opening…" spinner /> : <>
      <Text accessibilityRole={error ? 'alert' : undefined} style={error ? ui.error : ui.body}>{sent ? 'New link sent.' : error}</Text>
      {canRenew && <Button title={busy ? 'Sending…' : 'Send new link'} kind="primary" disabled={busy} onPress={onRenew} />}
      <Button title="Try again" disabled={busy} onPress={onRetry} />
      <Button title={canRenew ? 'Open MeroSplit' : 'Sign in'} kind="text" disabled={busy} onPress={onSignIn} />
    </>}
  </View>;
}
export function EmailLinkSent({ busy, resendSeconds, onResend, onCode, onChangeEmail }: { busy: boolean; resendSeconds: number; onResend: () => void; onCode: () => void; onChangeEmail: () => void }) {
  const { ui } = useUI();
  return <View style={{ gap: 12 }}><Text style={ui.body}>Open the sign-in link in your email.</Text>
    <ResendControls busy={busy} resendSeconds={resendSeconds} onResend={onResend} onChangeEmail={onChangeEmail} onAlternative={onCode} alternativeLabel="Use a code instead" resendLabel="Send new link" primary />
  </View>;
}
export function NameOnlyForm({ busy, onSave, autoFocus = true }: { autoFocus?: boolean; busy: boolean; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(''), [error, setError] = useState('');
  async function save() { setError(''); try { await onSave(name.trim()); } catch { setError('Could not save your name. Try again.'); } }
  return <View style={{ gap: 12 }}>
    <TextField label="Name" autoFocus={autoFocus} value={name} maxLength={120} autoCapitalize="words" autoComplete="name" autoCorrect={false} editable={!busy} onChangeText={setName} returnKeyType="done" onSubmitEditing={() => { if (!busy && name.trim()) void save(); }} />
    {!!error && <ErrorText>{error}</ErrorText>}
    <Button title={busy ? 'Saving name…' : 'Save name'} kind="primary" disabled={busy || !name.trim()} onPress={() => void save()} />
  </View>;
}
