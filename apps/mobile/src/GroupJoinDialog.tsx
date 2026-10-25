import React, { useEffect, useRef, useState } from 'react';
import { Dialog, Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { request } from './api';
import type { Session } from './types';
import KeyboardDialog from './KeyboardDialog';
import DialogFocus from './DialogFocus';
import { DialogScrollBody, CancelDialogActions } from './DialogParts';
import { Button, useUI } from './ui';

export default function GroupJoinDialog({ session, token, onJoined, onCancel }: { session: Session; token: string; onJoined: (id: string) => Promise<void>; onCancel: () => void }) {
  const { ui } = useUI();
  const [preview, setPreview] = useState<{ name: string; already_member: boolean } | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false), [retry, setRetry] = useState(0);
  const commandId = useRef<string | null>(null), flight = useRef(false), live = useRef(true);
  useEffect(() => {
    live.current = true; const controller = new AbortController();
    setPreview(null); setError('');
    void request<{ name: string; already_member: boolean }>(session, '/group-invite-links/preview', 'POST', { token }, 'json', controller.signal)
      .then(value => { if (!controller.signal.aborted) setPreview(value); }, err => { if (!controller.signal.aborted) setError(err.message); });
    return () => { live.current = false; controller.abort(); };
  }, [session.token, token, retry]);
  async function join() {
    if (!preview || flight.current) return;
    flight.current = true; setWorking(true); setError('');
    try {
      commandId.current ??= Crypto.randomUUID();
      const result = await request<{ id: string }>(session, '/group-invite-links/join', 'POST', { token, command_id: commandId.current });
      if (live.current) await onJoined(result.id);
    } catch (err) { if (live.current) setError(err instanceof Error ? err.message : 'Could not join. Try again.'); }
    finally { flight.current = false; if (live.current) setWorking(false); }
  }
  return <KeyboardDialog visible dismissable={!working} onDismiss={() => { if (!working) onCancel(); }}>
    <DialogFocus busy={working} onEscape={onCancel}>
    <Dialog.Title aria-level={2}>{preview ? preview.already_member ? 'Already a member' : `Join ${preview.name}?` : 'Join group'}</Dialog.Title>
    <DialogScrollBody maxHeight={300} gap={12}>
      <Text style={ui.body}>{preview?.already_member ? `You already belong to ${preview.name}.` : 'Join to see this group’s shared bills and balances.'}</Text>
      <Text style={ui.caption}>Signed in as {session.email}</Text>
      {!preview && !error && <Text style={ui.caption}>Checking invitation…</Text>}
      {!!error && <Text style={ui.error} accessibilityRole="alert">{error}</Text>}
      {!preview && !!error && <Button title="Try again" disabled={working} onPress={() => setRetry(value => value + 1)} />}
    </DialogScrollBody>
    <CancelDialogActions disabled={working} onCancel={onCancel}><Button title={working ? 'Joining…' : preview?.already_member ? 'Open group' : 'Join group'} kind="primary" disabled={working || !preview} onPress={() => void join()} /></CancelDialogActions>
    </DialogFocus>
  </KeyboardDialog>;
}
