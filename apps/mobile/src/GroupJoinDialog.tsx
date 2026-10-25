import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { ApiError, request } from './api';
import type { Session } from './types';
import DialogFocus from './DialogFocus';
import { AppFrame, ScreenHeader, pageContentStyle } from './AppNavigation';
import { TextField } from './FormFields';
import { Avatar, Button, useUI } from './ui';

type Person = { id: string; name: string };
type Preview = { name: string; already_member: boolean; version: number; people: Person[] };
type JoinRequest = { token: string; command_id: string; participant_id?: string; preview_version?: number; display_name?: string };

export default function GroupJoinDialog({ session, token, onJoined, onCancel }: { session: Session; token: string; onJoined: (id: string) => Promise<void>; onCancel: () => void }) {
  const { ui } = useUI();
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false), [retry, setRetry] = useState(0);
  const [step, setStep] = useState<'choose' | 'name' | 'confirm'>('choose'), [choice, setChoice] = useState<Person | null>(null), [name, setName] = useState(''), [uncertain, setUncertain] = useState(false);
  const attempt = useRef<JoinRequest | null>(null), flight = useRef(false), live = useRef(true), scope = useRef('');
  scope.current = `${session.token}|${token}`;
  useEffect(() => {
    live.current = true; const controller = new AbortController();
    setPreview(null); setError(''); setStep('choose'); setChoice(null); setName(''); attempt.current = null; setUncertain(false);
    void request<Preview>(session, '/group-invite-links/preview', 'POST', { token }, 'json', controller.signal)
      .then(value => { if (!controller.signal.aborted) setPreview(value); }, err => { if (!controller.signal.aborted) setError(err.message); });
    return () => { live.current = false; controller.abort(); };
  }, [session.token, token, retry]);
  function choose(person: Person | null) {
    if (working || uncertain) return;
    setChoice(person); setName(person?.name ?? session.displayName ?? ''); setError(''); setStep('name');
  }
  async function join() {
    if (!preview || flight.current || !preview.already_member && (step !== 'confirm' || !name.trim() || name.trim().length > 120)) return;
    const owner = scope.current;
    flight.current = true; setWorking(true); setError('');
    try {
      attempt.current ??= { token, command_id: Crypto.randomUUID(), ...(!preview.already_member && {
        display_name: name.trim(), ...(choice && { participant_id: choice.id, preview_version: preview.version }),
      }) };
      const result = await request<{ id: string }>(session, '/group-invite-links/join', 'POST', attempt.current);
      if (live.current && scope.current === owner) await onJoined(result.id);
    } catch (err) {
      if (live.current && scope.current === owner) {
        setError(err instanceof Error ? err.message : 'Could not join. Try again.');
        const rejected = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
        if (rejected) { attempt.current = null; setUncertain(false); setPreview(null); setStep('choose'); }
        else setUncertain(true); // A lost response retries the exact confirmed request.
      }
    } finally { flight.current = false; if (live.current && scope.current === owner) setWorking(false); }
  }
  function back() { if (!working && !uncertain) { if (step === 'confirm') setStep('name'); else if (step === 'name') setStep('choose'); else onCancel(); } }
  return <Modal visible presentationStyle="fullScreen" onRequestClose={() => { if (!working) onCancel(); }}>
    <AppFrame><DialogFocus style={{ flex: 1 }} busy={working} onEscape={uncertain ? onCancel : back}>
      <ScreenHeader title={preview ? `Join ${preview.name}` : 'Join group'} busy={working} onBack={uncertain ? onCancel : back} />
      <ScrollView role="main" contentContainerStyle={pageContentStyle} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <Text style={ui.caption}>Signed in as {session.email}</Text>
        {!preview && !error && <Text style={ui.caption}>Checking invitation…</Text>}
        {!!error && <Text style={ui.error} accessibilityRole="alert">{error}</Text>}
        {!preview && !!error && <Button title="Refresh invitation" disabled={working} onPress={() => setRetry(value => value + 1)} contentStyle={{ minHeight: 48 }} />}
        {preview?.already_member ? <>
          <Text style={ui.body}>You already belong to {preview.name}.</Text>
          <Button title="Open group" kind="primary" disabled={working} onPress={() => void join()} contentStyle={{ minHeight: 48 }} />
        </> : preview && (step === 'choose' ? <>
          <Text style={ui.body}>If someone already added you, find your name.</Text>
          <View>
            {preview.people.map(person => <View key={person.id} style={ui.row}>
              <Avatar name={person.name} /><Text style={[ui.rowTitle, { flex: 1, minWidth: 0 }]}>{person.name}</Text>
              <Button title="This is me" accessibilityLabel={`This is me: ${person.name}`} disabled={working} onPress={() => choose(person)} contentStyle={{ minHeight: 48 }} />
            </View>)}
            <View style={ui.row}><Text style={[ui.rowTitle, { flex: 1, minWidth: 0 }]}>I'm not listed</Text>
              <Button title="Join as new" disabled={working} onPress={() => choose(null)} contentStyle={{ minHeight: 48 }} /></View>
          </View>
          <Text style={ui.caption}>People already linked to an account are not listed.</Text>
        </> : step === 'name' ? <>
          <TextField label="Your name in this group" value={name} onChangeText={setName} editable={!working} maxLength={120} autoCapitalize="words" autoCorrect={false} />
          <Text style={ui.caption}>This does not change your account name.</Text>
          <Button title="Continue" kind="primary" disabled={working || !name.trim() || name.trim().length > 120} onPress={() => { if (name.trim() && name.trim().length <= 120) setStep('confirm'); }} contentStyle={{ minHeight: 48 }} />
        </> : <>
          <Text style={ui.section}>Join as {name.trim()}?</Text>
          <View style={ui.row}><Avatar name={name} /><Text style={[ui.rowTitle, { flex: 1 }]}>{name.trim()}</Text></View>
          <Text style={ui.body}>{choice ? `${choice.name}'s existing bills and payments will be linked to you in this group.` : 'You will join as a new person. Existing bills and payments will stay unchanged.'}</Text>
          <Button title={working ? 'Joining…' : uncertain ? 'Try again' : `Join as ${name.trim()}`} kind="primary" disabled={working} onPress={() => void join()} contentStyle={{ minHeight: 48 }} />
          {!uncertain && <Button title="Choose again" kind="text" disabled={working} onPress={() => setStep('choose')} contentStyle={{ minHeight: 48 }} />}
        </>)}
        <Button title="Cancel" kind="text" disabled={working} onPress={onCancel} contentStyle={{ minHeight: 48 }} />
      </ScrollView>
    </DialogFocus></AppFrame>
  </Modal>;
}
