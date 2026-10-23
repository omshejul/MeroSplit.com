import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Alert } from './alerts';
import * as Crypto from 'expo-crypto';
import { IconButton, Menu } from 'react-native-paper';
import { HugeiconsIcon } from '@hugeicons/react-native';
import MoreVerticalIcon from '@hugeicons/core-free-icons/MoreVerticalIcon';
import { accountOwner, request } from './api';
import { clearPickedMedia, pickMedia, uploadMedia } from './media';
import type { AvatarResult, MediaMetadata } from './media';
import PrivateMediaImage from './PrivateMediaImage';
import type { Session } from './types';
import { Button, Icon, useUI } from './ui';

export type ProfilePhotoProps = { session: Session | null; busy: boolean; onBusyChange: (busy: boolean) => void; compact?: boolean };
export default function ProfilePhoto({ session, busy, onBusyChange, compact = false }: ProfilePhotoProps) {
  const { ui, palette } = useUI(), [avatar, setAvatar] = useState<MediaMetadata | null>(null), [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [error, setError] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const lock = useRef(false), mounted = useRef(true), owner = session ? accountOwner(session) : '';
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const current = () => mounted.current && ownerRef.current === owner;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setAvatar(null); setOptionsOpen(false); setError(''); setLoading(true);
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
    {!session ? <Text style={ui.caption}>Sign in to add your profile photo.</Text> : <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={avatar ? 'Change profile photo' : 'Choose profile photo'} accessibilityState={{ disabled }} disabled={disabled} onPress={() => void run(choose)} style={{ flex: compact ? undefined : 1, flexShrink: compact ? 0 : undefined, width: compact ? 64 : undefined, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 }}>
          {avatar ? <PrivateMediaImage session={session} media={avatar} size={64} profile /> : <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: palette.soft, alignItems: 'center', justifyContent: 'center' }}><Icon name="me" size={30} /></View>}
          {compact ? <View style={{ position: 'absolute', right: 0, bottom: 0, backgroundColor: palette.background, borderRadius: 12, padding: 3 }}><Icon name="edit" size={16} /></View> : <Text style={[ui.body, { flex: 1 }]}>{loading ? 'Loading photo…' : working ? 'Updating photo…' : avatar ? 'Change photo' : 'Choose photo'}</Text>}
        </Pressable>
        {avatar && <Menu visible={optionsOpen} onDismiss={() => setOptionsOpen(false)} anchor={<IconButton accessibilityLabel="Photo options" disabled={disabled} style={{ width: 48, height: 48, margin: 0 }} icon={({ color, size }) => <HugeiconsIcon icon={MoreVerticalIcon} color={color} size={size} />} onPress={() => setOptionsOpen(true)} />}>
          <Menu.Item title="Remove photo" disabled={disabled} onPress={() => { setOptionsOpen(false); remove(); }} />
        </Menu>}
      </View>
      {!!error && <><Text accessibilityRole="alert" style={ui.error}>{error}</Text><Button title="Refresh photo" kind="text" disabled={busy || working} onPress={() => void run(async () => { await load(); })} /></>}
    </>}
  </View>;
}
