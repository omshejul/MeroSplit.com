import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { request } from './api';
import { NameOnlyForm } from './EmailLinkScreens';
import type { Session } from './types';
import { Button, ErrorText, useUI } from './ui';

export function oauthConsentPath(value: unknown): string | null {
  return typeof value === 'string' && /^\/oauth\/authorize\?request=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

// Browser cookies and a server-held selector determine continuation. Cached
// account metadata is never an OAuth credential or consent decision.
export default function OAuthContinuation({ session, busy, onSaveName, beforeContinue }: { session: Session; busy: boolean; onSaveName: (name: string) => Promise<void>; beforeContinue: () => Promise<void> }) {
  const { ui } = useUI();
  const [path, setPath] = useState<string | null>(null), [error, setError] = useState('');
  useEffect(() => { let active = true; void request<{ authorization_url: string | null }>(session, '/me/mcp/pending').then(value => { if (active) setPath(oauthConsentPath(value.authorization_url)); }).catch(() => {}); return () => { active = false; }; }, [session.token]);
  async function continueConnection() {
    try {
      await beforeContinue();
      const value = await request<{ authorization_url: string | null }>(session, '/me/mcp/pending');
      const current = oauthConsentPath(value.authorization_url);
      if (!current) throw new Error('This connection request expired. Start again from your agent.');
      window.location.assign(current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not continue. Try again.'); }
  }
  if (!path) return null;
  return <View style={{ gap: 12 }}><Text style={ui.body}>Continue connecting your agent to {session.email}.</Text>
    {!session.displayName?.trim() ? <NameOnlyForm busy={busy} onSave={onSaveName} />
      : <Button title="Review agent access" kind="primary" disabled={busy} onPress={() => void continueConnection()} />}
    {!!error && <ErrorText>{error}</ErrorText>}
  </View>;
}
