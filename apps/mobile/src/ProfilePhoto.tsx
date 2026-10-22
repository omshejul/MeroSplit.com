import React, { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { accountOwner, request } from './api';
import { clearPickedMedia, pickMedia, uploadMedia } from './media';
import type { AvatarResult, MediaMetadata } from './media';
import PrivateMediaImage from './PrivateMediaImage';
import type { Session } from './types';
import { Button, Icon, useUI } from './ui';

export type ProfilePhotoProps = { session: Session | null; busy: boolean; onBusyChange: (busy: boolean) => void };
export default function ProfilePhoto({ session, busy, onBusyChange }: ProfilePhotoProps) {
  const { ui, palette } = useUI(), [avatar, setAvatar] = useState<MediaMetadata | null>(null), [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), mounted = useRef(true), owner = session ? accountOwner(session) : '';
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const current = () => mounted.current && ownerRef.current === owner;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setAvatar(null); setError(''); setLoading(true);
    if (!session) { setLoading(false); return; }
    void request<AvatarResult>(session, '/me').then(result => { if (active) setAvatar(result.avatar); })
      .catch(() => { if (active) setError('Could not load your photo. Refresh when online.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [owner, session?.token]);
  async function load() {
    if (!session) return;
    const result = await request<AvatarResult>(session, '/me');
    if (current()) setAvatar(result.avatar);
    return result;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current || busy || !session) return;
    lock.current = true; setWorking(true); setError(''); onBusyChange(true);
    try { await action(); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not update your photo. Refresh and try again.'); }
    finally { lock.current = false; if (current()) setWorking(false); onBusyChange(false); }
  }
  async function choose() {
    if (!session) return;
    const file = await pickMedia(true, true); if (!file) return;
    if (!current()) { await clearPickedMedia(file); return; }
    const id = Crypto.randomUUID();
    try {
      const result = await uploadMedia<AvatarResult>(session, '/me/avatar', file, id);
      if (current()) setAvatar(result.avatar);
    } catch (cause) {
      try { const latest = await load(); if (latest?.avatar?.id === id) return; } catch { /* Preserve the previous photo if reconciliation is offline. */ }
      throw cause;
    } finally { await clearPickedMedia(file); }
  }
  function remove() {
    Alert.alert('Remove your photo?', 'Your account and bills will stay.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', onPress: () => void run(async () => {
      await request(session!, '/me/avatar', 'DELETE'); if (current()) setAvatar(null);
    }) }]);
  }
  const disabled = busy || loading || working;
  return <View style={{ gap: 10 }}>
    <Text style={ui.section}>Profile photo</Text>
    {!session ? <Text style={ui.caption}>Sign in to add your profile photo.</Text> : <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {avatar ? <PrivateMediaImage session={session} media={avatar} size={64} profile /> : <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: palette.soft, alignItems: 'center', justifyContent: 'center' }}><Icon name="me" size={30} /></View>}
        <View style={{ flex: 1, gap: 4 }}><Text style={ui.body}>{loading ? 'Loading photo…' : working ? 'Processing photo…' : avatar ? 'Your photo' : 'No photo yet'}</Text><Text style={ui.caption}>JPEG, PNG or WebP · Up to 5 MB</Text></View>
      </View>
      <Button title={avatar ? 'Change photo' : 'Choose photo'} onPress={() => void run(choose)} disabled={disabled} />
      {avatar && <Button title="Remove photo" kind="text" onPress={remove} disabled={disabled} />}
      {!!error && <><Text accessibilityRole="alert" style={ui.error}>{error}</Text><Button title="Refresh photo" kind="text" disabled={busy || working} onPress={() => void run(async () => { await load(); })} /></>}
    </>}
  </View>;
}
