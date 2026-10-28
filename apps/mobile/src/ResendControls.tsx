import React from 'react';
import { Button } from './ui';
export default function ResendControls({ busy, sending = busy, resendSeconds, onResend, onChangeEmail, onAlternative, alternativeLabel, resendLabel = 'Resend code', primary = false }: {
  busy: boolean; sending?: boolean; resendSeconds: number; onResend: () => void; onChangeEmail: () => void; onAlternative?: () => void; alternativeLabel?: string; resendLabel?: string; primary?: boolean;
}) {
  return <><Button title={sending ? 'Sending…' : resendSeconds > 0 ? `Resend in ${resendSeconds}s` : resendLabel} kind={primary ? 'secondary' : 'text'} contentStyle={{ minHeight: 48 }} disabled={busy || resendSeconds > 0} onPress={onResend} />
    {onAlternative && <Button title={alternativeLabel} kind="text" contentStyle={{ minHeight: 48 }} disabled={busy} onPress={onAlternative} />}
    <Button title="Use another email" kind="text" contentStyle={{ minHeight: 48 }} disabled={busy} onPress={onChangeEmail} /></>;
}
