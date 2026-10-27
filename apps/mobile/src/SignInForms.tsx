import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import Form from './Form';
import { Text } from 'react-native-paper';
import { EmailField, TextField } from './FormFields';
import { Button, useUI } from './ui';

export function EmailSignIn({ email, busy, onEmail, onSend, sendLabel = 'Send sign-in code', children, secondary }: { email: string; busy: boolean; onEmail: (value: string) => void; onSend: () => void; sendLabel?: string; children?: React.ReactNode; secondary?: React.ReactNode }) {
  const { palette, ui } = useUI();
  const [sending, setSending] = useState(false);
  useEffect(() => { if (!busy) setSending(false); }, [busy]);
  const send = () => { if (busy) return; setSending(true); onSend(); };
  return <Form style={{ gap: 24, width: '100%' }} label="Email sign in" onSubmit={() => { if (!busy && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) send(); }}>
    <View style={{ gap: 12 }}>{children}</View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: palette.line }} /><Text style={ui.caption}>or</Text><View style={{ flex: 1, height: 1, backgroundColor: palette.line }} />
    </View>
    <View style={{ gap: 12 }}>
      <EmailField label="Email" placeholder="you@example.com" value={email} onChangeText={onEmail} style={{ minHeight: 48, borderRadius: 12 }} />
      <Button title={busy && sending ? 'Sending…' : sendLabel} accessibilityLabel={sendLabel} kind="primary" style={{ borderRadius: 12 }} contentStyle={{ minHeight: 48 }} disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onPress={send} />
      {secondary}
    </View>
  </Form>;
}
export function CodeSignIn({ email, code, resendSeconds, busy, onCode, onConfirm, onResend, onChangeEmail }: { email: string; code: string; resendSeconds: number; busy: boolean; onCode: (value: string) => void; onConfirm: () => void; onResend: () => void; onChangeEmail: () => void }) {
  const { ui } = useUI();
  const [action, setAction] = useState<'confirm' | 'resend' | null>(null);
  useEffect(() => { if (!busy) setAction(null); }, [busy]);
  const confirm = () => { if (busy) return; setAction('confirm'); onConfirm(); };
  const resend = () => { if (busy) return; setAction('resend'); onResend(); };
  return <Form style={{ gap: 12 }} label="Sign-in code" onSubmit={() => { if (!busy && /^[0-9]{4}$/.test(code)) confirm(); }}>
    <Text style={ui.body}>Enter your four-digit sign-in code for {email.trim()}.</Text>
    <TextField label="4-digit code" value={code} onChangeText={value => onCode(value.replace(/\D/g, '').slice(0, 4))} maxLength={4} autoCorrect={false} autoCapitalize="none" autoComplete="one-time-code" keyboardType="number-pad" />
    <Button title={busy && action === 'confirm' ? 'Signing in…' : 'Continue'} accessibilityLabel="Continue" kind="primary" style={{ borderRadius: 12 }} contentStyle={{ minHeight: 48 }} disabled={busy || !/^[0-9]{4}$/.test(code)} onPress={confirm} />
    <Button title={busy && action === 'resend' ? 'Sending…' : resendSeconds > 0 ? `Resend in ${resendSeconds}s` : 'Resend code'} kind="text" contentStyle={{ minHeight: 48 }} disabled={busy || resendSeconds > 0} onPress={resend} />
    <Button title="Use another email" kind="text" contentStyle={{ minHeight: 48 }} disabled={busy} onPress={onChangeEmail} />
  </Form>;
}
