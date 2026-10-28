import { Dialog } from './DialogParts';
import React, { useEffect, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import { request } from './api';
import { NameOnlyForm } from './EmailLinkScreens';
import DialogFocus from './DialogFocus';
import KeyboardDialog from './KeyboardDialog';
import { CancelDialogActions, DialogScrollBody } from './DialogParts';
import type { Session } from './types';
import { Button, ErrorText, useUI } from './ui';

export function oauthConsentPath(value: unknown): string | null {
  return typeof value === 'string' && /^\/oauth\/authorize\?request=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

// Browser cookies and the server-held selector own consent. Not now only hides this UI.
export default function OAuthContinuation({ session, busy, onSaveName, beforeContinue }: { session: Session; busy: boolean; onSaveName: (name: string) => Promise<void>; beforeContinue: () => Promise<void> }) {
  const { ui } = useUI(), { height } = useWindowDimensions();
  const scope = `${session.baseUrl}|${session.userId}|${session.token}`, current = useRef(scope), flight = useRef(false);
  current.current = scope;
  const [pending, setPending] = useState<{ scope: string; path: string } | null>(null), [working, setWorking] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true; current.current = scope;
    setPending(null); setError('');
    void request<{ authorization_url: string | null }>(session, '/me/mcp/pending').then(value => {
      const path = oauthConsentPath(value.authorization_url);
      if (active && current.current === scope && path) setPending({ scope, path });
    }).catch(() => {});
    return () => { active = false; current.current = ''; };
  }, [scope]);
  function dismiss() { if (!busy && !flight.current) setPending(null); }
  async function continueConnection() {
    if (busy || flight.current || pending?.scope !== scope) return;
    flight.current = true; setWorking(true); setError('');
    try {
      await beforeContinue();
      if (current.current !== scope) return;
      const value = await request<{ authorization_url: string | null }>(session, '/me/mcp/pending');
      if (current.current !== scope) return;
      if (oauthConsentPath(value.authorization_url) !== pending.path) throw new Error('This connection request changed or expired. Start again from your agent.');
      window.location.assign(pending.path);
    } catch (cause) { if (current.current === scope) setError(cause instanceof Error ? cause.message : 'Could not continue. Try again.'); }
    finally { flight.current = false; if (current.current === scope) setWorking(false); }
  }
  async function saveName(name: string) {
    if (busy || flight.current || current.current !== scope) return;
    flight.current = true; setWorking(true);
    try { await onSaveName(name); } finally { flight.current = false; if (current.current === scope) setWorking(false); }
  }
  if (pending?.scope !== scope) return null;
  const disabled = busy || working;
  return <KeyboardDialog label="Review agent access" visible dismissable={false} onDismiss={dismiss} maxHeight={Math.max(0, height - 48)}>

      <Dialog.Title aria-level={2}>Review agent access</Dialog.Title>
      <DialogScrollBody maxHeight={Math.min(360, Math.max(40, height - 220))} gap={12}>
        <Text style={ui.body}>An agent is asking to connect to MeroSplit as {session.email}. Review what it can do before allowing it.</Text>
        {!session.displayName?.trim() && <NameOnlyForm autoFocus={false} busy={disabled} onSave={saveName} />}
        {!!error && <ErrorText>{error}</ErrorText>}
      </DialogScrollBody>
      <CancelDialogActions cancelTitle="Not now" disabled={disabled} onCancel={dismiss}>
        {!!session.displayName?.trim() && <Button title="Review access" kind="primary" disabled={disabled} onPress={() => void continueConnection()} />}
      </CancelDialogActions>

  </KeyboardDialog>;
}
