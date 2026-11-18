import ScrollView from './KeyboardScrollView';
import LoadingOverlay, { useLoading } from './LoadingOverlay';
import ScrollBottomInset from './ScrollBottomInset';
import PersonRow from './PersonRow';
import { ErrorState } from './UIStates';
import { LoadingState } from './UIStates';

import React, { useEffect, useRef, useState } from 'react';
import { Modal, View } from 'react-native';
import { Text } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { ApiError, request } from './api';
import type { Session } from './types';
import DialogFocus from './DialogFocus';
import { AppFrame, ScreenHeader, pageContentStyle } from './AppNavigation';
import { TextField } from './FormFields';
import { Button, useUI } from './ui';

type Person = { id: string; name: string; profile_photo?: import("./types").ProfilePhoto | null };
type Preview = { name: string; already_member: boolean; version: number; people: Person[] };
type JoinRequest = { token: string; command_id: string; participant_id?: string; preview_version?: number; display_name?: string };

export default function GroupJoinDialog({ session, token, onJoined, onCancel }: { session: Session; token: string; onJoined: (id: string) => Promise<void>; onCancel: () => void }) {
  const { ui, palette } = useUI();
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false), [retry, setRetry] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [step, setStep] = useState<'choose' | 'name' | 'confirm'>('choose'), [choice, setChoice] = useState<Person | null>(null), [name, setName] = useState(''), [uncertain, setUncertain] = useState(false);
  const attempt = useRef<JoinRequest | null>(null), flight = useRef(false), live = useRef(true), scope = useRef('');
  scope.current = `${session.token}|${token}`;
  useEffect(() => {
    live.current = true; const controller = new AbortController();
    setPreview(null); setError(''); setUnavailable(false); setStep('choose'); setChoice(null); setName(''); attempt.current = null; setUncertain(false);
    void request<Preview>(session, '/group-invite-links/preview', 'POST', { token }, 'json', controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        setPreview(value);
        if (!value.already_member && !value.people.length) { setName(session.displayName ?? ''); setStep('name'); }
      }, err => {
        if (controller.signal.aborted) return;
        setUnavailable(err instanceof ApiError && (err.status === 403 || err.status === 404));
        setError(err instanceof ApiError && err.status === 404 ? 'This invitation is no longer available. Ask the organizer for a new link.' : err.message);
      });
    return () => { live.current = false; controller.abort(); };
  }, [session.token, token, retry]);
  function choose(person: Person | null) {
    if (working || uncertain) return;
    setChoice(person); setName(session.displayName ?? ''); setError(''); setStep(person ? 'confirm' : 'name');
  }
  const validName = name.trim().length > 0 && name.trim().length <= 120;
  async function join() {
    if (!preview || flight.current || !preview.already_member && (choice ? step !== 'confirm' : step !== 'name' || !validName)) return;
    const owner = scope.current;
    flight.current = true; setWorking(true); setError('');
    try {
      attempt.current ??= { token, command_id: Crypto.randomUUID(), ...(!preview.already_member && (choice ? { participant_id: choice.id, preview_version: preview.version } : { display_name: name.trim() })) };
      const result = await request<{ id: string }>(session, '/group-invite-links/join', 'POST', attempt.current);
      if (live.current && scope.current === owner) await onJoined(result.id);
    } catch (err) {
      if (live.current && scope.current === owner) {
        setError(err instanceof Error ? err.message : 'Could not join. Try again.');
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          setUnavailable(true);
          if (err.status === 404) setError('This invitation is no longer available. Ask the organizer for a new link.');
        }
        const rejected = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
        if (rejected) { attempt.current = null; setUncertain(false); setPreview(null); setStep('choose'); }
        else setUncertain(true); // A lost response retries the exact confirmed request.
      }
    } finally { flight.current = false; if (live.current && scope.current === owner) setWorking(false); }
  }
  useLoading(working || !preview && !error);
  const choosing = !!preview?.people.length && step === 'choose';
  const canReturnToList = !!preview?.people.length && !choosing && !uncertain;
  function back() {
    if (working) return;
    if (canReturnToList) { setStep('choose'); setChoice(null); }
    else onCancel();
  }
  return <Modal visible presentationStyle="fullScreen" onRequestClose={back}>
    <SafeAreaProvider><AppFrame><DialogFocus modal={false} style={{ flex: 1 }} busy={working} onEscape={back}>
      <ScreenHeader title={preview ? `Join ${preview.name}` : 'Join group'} busy={working} onBack={back} />
      <ScrollView role="main" style={{ flex: 1 }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={pageContentStyle} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <Text style={ui.caption}>Signed in as {session.email}</Text>
        {!preview && !error && <LoadingState label="Checking invitation…" />}
        {!!error && <ErrorState error={error} retryLabel="Refresh invitation" disabled={working} onRetry={!preview && !unavailable ? () => setRetry(value => value + 1) : undefined} />}
        {preview?.already_member ? <Text style={ui.body}>You already belong to {preview.name}.</Text>
          : preview && (choosing ? <>
            <Text accessibilityRole="header" style={ui.section}>Do you see your name?</Text>
            <Text style={ui.body}>Only pick your own name.</Text>
            <View>
              {preview.people.map(person => <PersonRow key={person.id} name={person.name} photo={person.profile_photo} trailing={<Button title="This is me" accessibilityLabel={`This is me: ${person.name}`} disabled={working} onPress={() => choose(person)} style={{ minHeight: 48 }} />} />)}
            </View>
          </> : choice ? <>
            <Text accessibilityRole="header" style={ui.section}>Are you {choice.name}?</Text>
            <PersonRow name={choice.name} photo={choice.profile_photo} />
            <Text style={ui.body}>Bills and payments under this name will be linked to your account.</Text>
          </> : <>
            <Text accessibilityRole="header" style={ui.section}>Add yourself</Text>
            <Text style={ui.body}>Enter the name people in this group know you by.</Text>
            <TextField label="Your name" value={name} onChangeText={setName} editable={!working && !uncertain} maxLength={120} autoCapitalize="words" autoCorrect={false} />
          </>)}
      </ScrollView>
      <View style={{ borderTopWidth: 1, borderColor: palette.line }}>
        <View style={[pageContentStyle, { paddingVertical: 12, gap: 8 }]}>
          {choosing ? <>
            <Text style={ui.caption}>If your name isn’t here, tap Add myself.</Text>
            <Button title="Add myself to the group" kind="primary" disabled={working} onPress={() => choose(null)} style={{ minHeight: 48 }} />
          </> : preview && <Button title={working ? 'Joining…' : uncertain ? 'Try again' : preview.already_member ? 'Open group' : choice ? `Yes, I’m ${choice.name}` : 'Join group'} kind="primary" disabled={working || !preview.already_member && !choice && !validName} onPress={() => void join()} style={{ minHeight: 48 }} />}
          <Button title={canReturnToList ? 'Go back' : unavailable ? 'Back to MeroSplit' : 'Cancel'} kind="text" disabled={working} onPress={back} style={{ minHeight: 44 }} />
        </View>
        <ScrollBottomInset />
      </View>
    <LoadingOverlay inline />
    </DialogFocus></AppFrame></SafeAreaProvider>
  </Modal>;
}
