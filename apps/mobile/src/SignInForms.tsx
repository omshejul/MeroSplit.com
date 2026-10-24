import React from 'react';
import Form from './Form';
import { Text } from 'react-native-paper';
import { EmailField, TextField } from './FormFields';
import { Button, useUI } from './ui';

export function EmailSignIn({ email, busy, onEmail, onSend, sendLabel = 'Send sign-in code', children }: { email: string; busy: boolean; onEmail: (value: string) => void; onSend: () => void; sendLabel?: string; children?: React.ReactNode }) {
  const { ui } = useUI();
  return <Form label="Email sign in" onSubmit={() => { if (!busy && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) onSend(); }}>
    <Text style={ui.caption}>New accounts get email for bills still unseen after 10 minutes. Turn it off in Me → Notifications.</Text>
    <EmailField label="Email" value={email} onChangeText={onEmail} />
    <Button title={sendLabel} kind="primary" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onPress={onSend} />
    {children}
  </Form>;
}
export function CodeSignIn({ email, code, resendSeconds, busy, onCode, onConfirm, onResend, onChangeEmail }: { email: string; code: string; resendSeconds: number; busy: boolean; onCode: (value: string) => void; onConfirm: () => void; onResend: () => void; onChangeEmail: () => void }) {
  const { ui } = useUI();
  return <Form label="Sign-in code" onSubmit={() => { if (!busy && /^[0-9]{4}$/.test(code)) onConfirm(); }}>
    <Text style={ui.body}>Enter your four-digit sign-in code for {email.trim()}.</Text>
    <TextField label="4-digit code" value={code} onChangeText={value => onCode(value.replace(/\D/g, '').slice(0, 4))} maxLength={4} autoCorrect={false} autoCapitalize="none" autoComplete="one-time-code" keyboardType="number-pad" />
    <Button title="Continue" kind="primary" disabled={busy || !/^[0-9]{4}$/.test(code)} onPress={onConfirm} />
    <Button title={resendSeconds > 0 ? `Resend in ${resendSeconds}s` : 'Resend code'} kind="text" disabled={busy || resendSeconds > 0} onPress={onResend} />
    <Button title="Use another email" kind="text" disabled={busy} onPress={onChangeEmail} />
  </Form>;
}
