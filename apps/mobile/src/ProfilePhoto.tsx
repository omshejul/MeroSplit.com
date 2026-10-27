import Avatar from './Avatar';
import type { ProfilePhoto as ProfilePhotoValue } from './types';
import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from './alerts';
import * as Crypto from 'expo-crypto';
import { accountOwner, request, cachedRead } from './api';
import { clearPickedMedia, pickMedia, uploadMedia } from './media';
import type { AvatarResult, MediaMetadata } from './media';
import RemoveMediaMenu from './RemoveMediaMenu';
import type { Session } from './types';
import { Button, Icon, useUI } from './ui';

export type ProfilePhotoProps = { session: Session | null; busy: boolean; onBusyChange: (busy: boolean) => void; compact?: boolean };
export default function ProfilePhoto({ session, busy, onBusyChange, compact = false }: ProfilePhotoProps) {
  const cachedProfile = session ? cachedRead<AvatarResult>(session, '/me') : undefined;
  const { ui, palette } = useUI(), [fallback, setFallback] = useState<ProfilePhotoValue | null>(cachedProfile?.profile_photo ?? null), [avatar, setAvatar] = useState<MediaMetadata | null>(cachedProfile?.avatar ?? null), [loading, setLoading] = useState(!cachedProfile), [working, setWorking] = useState(false), [error, setError] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const lock = useRef(false), mounted = useRef(true), owner = session ? accountOwner(session) : '';
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const current = () => mounted.current && ownerRef.current === owner;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const cached = session ? cachedRead<AvatarResult>(session, '/me') : undefined;
    let active = true; setAvatar(cached?.avatar ?? null); setFallback(cached?.profile_photo ?? null); setOptionsOpen(false); setError(''); setLoading(!cached);
    if (!session) { setLoading(false); return; }
    void request<AvatarResult>(session, '/me').then(result => { if (active) { setAvatar(result.avatar); setFallback(result.profile_photo ?? null); } })
      .catch(() => { if (active) setError('Could not load your photo. Refresh when online.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [owner, session?.token]);
  async function load() {
    if (!session) return;
    const result = await request<AvatarResult>(session, '/me');
    if (current()) { setAvatar(result.avatar); setFallback(result.profile_photo ?? null); }
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
      if (current()) { setAvatar(result.avatar); setFallback(result.profile_photo ?? null); }
    } catch (cause) {
      try { const latest = await load(); if (latest?.avatar?.id === id) return; } catch { /* Preserve the previous photo if reconciliation is offline. */ }
      throw cause;
    } finally { await clearPickedMedia(file); }
  }
  function remove() {
    Alert.alert('Remove your photo?', 'Your account and bills will stay.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', onPress: () => void run(async () => {
      await request(session!, '/me/avatar', 'DELETE'); await load();
    }) }]);
  }
  const disabled = busy || loading || working;
  return <View style={{ gap: 10 }}>
    {!session ? <Text style={ui.caption}>Sign in to add your profile photo.</Text> : <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Button kind="plain" accessibilityRole="button" accessibilityLabel={avatar ? 'Change profile photo' : 'Choose profile photo'} accessibilityState={{ disabled }} disabled={disabled} onPress={() => void run(choose)} style={{ flex: compact ? undefined : 1, flexShrink: compact ? 0 : undefined, width: compact ? 64 : undefined, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 }}>
          <Avatar photo={avatar ?? fallback} size={64} backgroundColor={palette.soft}><Icon name="me" size={30} /></Avatar>
          {compact ? <View style={{ position: 'absolute', right: 0, bottom: 0, backgroundColor: palette.background, borderRadius: 12, padding: 3 }}><Icon name="edit" size={16} /></View> : <Text style={[ui.body, { flex: 1 }]}>{loading ? 'Loading photo…' : working ? 'Updating photo…' : avatar ? 'Change photo' : 'Choose photo'}</Text>}
        </Button>
        {avatar && <RemoveMediaMenu open={optionsOpen} disabled={disabled} label="Photo options" removeLabel="Remove photo"
          onOpen={() => setOptionsOpen(true)} onClose={() => setOptionsOpen(false)} onRemove={remove} />}
      </View>
      {!!error && <><Text accessibilityRole="alert" style={ui.error}>{error}</Text><Button title="Refresh" accessibilityLabel="Refresh photo" kind="text" disabled={busy || working} onPress={() => void run(async () => { await load(); })} /></>}
    </>}
  </View>;
}
