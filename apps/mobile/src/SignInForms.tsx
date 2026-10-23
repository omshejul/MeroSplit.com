import React from 'react';
import { Text } from 'react-native-paper';
import { TextField } from './FormFields';
import { Button, useUI } from './ui';

export function EmailSignIn({ email, busy, onEmail, onSend }: { email: string; busy: boolean; onEmail: (value: string) => void; onSend: () => void }) {
  const { ui } = useUI();
  return <>
    <Text style={ui.caption}>New accounts get daily unread email reminders. Turn them off in Me → Notifications.</Text>
    <TextField label="Email" value={email} onChangeText={onEmail} autoCorrect={false} autoCapitalize="none" autoComplete="email" keyboardType="email-address" />
    <Button title="Send sign-in code" kind="primary" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onPress={onSend} />
  </>;
}
export function CodeSignIn({ email, code, resendSeconds, busy, onCode, onConfirm, onResend, onChangeEmail }: { email: string; code: string; resendSeconds: number; busy: boolean; onCode: (value: string) => void; onConfirm: () => void; onResend: () => void; onChangeEmail: () => void }) {
  const { ui } = useUI();
  return <>
    <Text style={ui.body}>Enter your four-digit sign-in code for {email.trim()}.</Text>
    <TextField label="4-digit code" value={code} onChangeText={value => onCode(value.replace(/\D/g, '').slice(0, 4))} maxLength={4} autoCorrect={false} autoCapitalize="none" autoComplete="one-time-code" keyboardType="number-pad" />
    <Button title="Continue" kind="primary" disabled={busy || !/^[0-9]{4}$/.test(code)} onPress={onConfirm} />
    <Button title={resendSeconds > 0 ? `Resend in ${resendSeconds}s` : 'Resend code'} kind="text" disabled={busy || resendSeconds > 0} onPress={onResend} />
    <Button title="Use another email" kind="text" disabled={busy} onPress={onChangeEmail} />
  </>;
}
