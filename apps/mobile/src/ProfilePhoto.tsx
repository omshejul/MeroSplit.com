import { ErrorState } from './UIStates';

import Avatar from './Avatar';
import type { ProfilePhoto as ProfilePhotoValue } from './types';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Alert } from './alerts';
import * as Crypto from 'expo-crypto';
import { accountOwner, request, cachedRead } from './api';
import { clearPickedMedia, pickMedia, uploadMedia } from './media';
import type { AvatarResult, MediaMetadata } from './media';
import LoadingSpinner from './LoadingSpinner';
import ProfilePhotoCrop from './ProfilePhotoCrop';
import type { PickedMedia } from './media';
import RemoveMediaMenu from './RemoveMediaMenu';
import type { Session } from './types';
import { Button, Icon, useUI } from './ui';

export type ProfilePhotoProps = { session: Session | null; busy: boolean; onBusyChange: (busy: boolean) => void; compact?: boolean; onChanged?: () => void | Promise<void> };
export default function ProfilePhoto({ session, busy, onChanged, compact = false }: ProfilePhotoProps) {
  const cachedProfile = session ? cachedRead<AvatarResult>(session, '/me') : undefined;
  const { ui, palette } = useUI(), [fallback, setFallback] = useState<ProfilePhotoValue | null>(cachedProfile?.profile_photo ?? null), [avatar, setAvatar] = useState<MediaMetadata | null>(cachedProfile?.avatar ?? null), [loading, setLoading] = useState(!cachedProfile), [working, setWorking] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<{ file: PickedMedia; id: string } | null>(null), [phase, setPhase] = useState<'idle' | 'uploading' | 'saved' | 'failed'>('idle');
  const [cropFile, setCropFile] = useState<PickedMedia | null>(null), cropResult = useRef<((file: PickedMedia | null) => void) | null>(null), revision = useRef(0), uploadingFile = useRef<PickedMedia | null>(null);
  useEffect(() => () => { if (preview && preview.file.uri !== uploadingFile.current?.uri) void clearPickedMedia(preview.file); }, [preview?.file.uri]);
  useEffect(() => () => { cropResult.current?.(null); }, []);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const lock = useRef(false), mounted = useRef(true), owner = session ? accountOwner(session) : '';
  const identity = `${owner}|${session?.token ?? ''}`, ownerRef = useRef(identity); ownerRef.current = identity;
  const current = () => mounted.current && ownerRef.current === identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const cached = session ? cachedRead<AvatarResult>(session, '/me') : undefined;
    const version = revision.current; let active = true; setAvatar(cached?.avatar ?? null); setFallback(cached?.profile_photo ?? null); setOptionsOpen(false); setPreview(null); setPhase('idle'); setError(''); setLoading(!cached);
    if (!session) { setLoading(false); return; }
    void request<AvatarResult>(session, '/me').then(result => { if (active && version === revision.current) { setAvatar(result.avatar); setFallback(result.profile_photo ?? null); } })
      .catch(() => { if (active && version === revision.current) setError('Could not load your photo. Refresh when online.'); })
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
    lock.current = true; revision.current++; setWorking(true); setLoading(false); setError('');
    try { await action(); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not update your photo. Refresh and try again.'); }
    finally { lock.current = false; if (current()) setWorking(false); }
  }
  async function upload(value: { file: PickedMedia; id: string }) {
    if (!session) return;
    uploadingFile.current = value.file; setPhase('uploading');
    try {
      let result: AvatarResult;
      try { result = await uploadMedia<AvatarResult>(session, '/me/avatar', value.file, value.id); }
      catch (cause) { const latest = await load().catch(() => undefined); if (latest?.avatar?.id !== value.id) throw cause; result = latest; }
      if (current()) {
        setAvatar(result.avatar); setFallback(result.profile_photo ?? null); setPhase('saved');
        void Promise.resolve().then(() => onChanged?.()).catch(() => {});
      }
    } catch (cause) { if (current()) setPhase('failed'); throw cause; }
    finally { uploadingFile.current = null; if (!current()) await clearPickedMedia(value.file); }
  }
  async function choose() {
    if (!session) return;
    const original = await pickMedia(true, true); if (!original) return;
    if (!current()) { await clearPickedMedia(original); return; }
    let file: PickedMedia | null = original;
    if (Platform.OS === 'web') {
      try { file = await new Promise(resolve => { cropResult.current = resolve; setCropFile(original); }); }
      finally { await clearPickedMedia(original); }
    }
    if (!file) return;
    if (!current()) { await clearPickedMedia(file); return; }
    const value = { file, id: Crypto.randomUUID() }; setPreview(value);
    await upload(value);
  }
  function finishCrop(file: PickedMedia | null) { const resolve = cropResult.current; cropResult.current = null; setCropFile(null); resolve?.(file); }
  function remove() {
    Alert.alert('Remove your photo?', 'Your account and bills will stay.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove photo', onPress: () => void run(async () => {
      await request(session!, '/me/avatar', 'DELETE'); await load(); if (current()) { setPreview(null); setPhase('idle'); void Promise.resolve().then(() => onChanged?.()).catch(() => {}); }
    }) }]);
  }
  const disabled = busy || loading || working;
  return <View style={{ gap: 10 }}>
    {!session ? <Text style={ui.caption}>Sign in to add your profile photo.</Text> : <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Button kind="plain" accessibilityRole="button" accessibilityLabel={avatar ? 'Change profile photo' : 'Choose profile photo'} accessibilityState={{ disabled }} disabled={disabled} onPress={() => void run(choose)} style={{ flex: compact ? undefined : 1, flexShrink: compact ? 0 : undefined, width: compact ? 64 : undefined, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 }}>
          <Avatar label={phase === 'saved' ? 'Profile photo updated' : undefined} photo={avatar ?? fallback} source={preview ? { uri: preview.file.uri } : undefined} size={64} backgroundColor={palette.soft}><Icon name="me" size={30} /></Avatar>
          {compact ? <View style={{ position: 'absolute', right: 0, bottom: 0, backgroundColor: palette.background, borderRadius: 12, padding: 3 }}>{phase === 'uploading' ? <LoadingSpinner visible label="Uploading profile photo" color={palette.accent} /> : <Icon name={phase === 'saved' ? 'check' : 'edit'} size={16} />}</View> : <Text style={[ui.body, { flex: 1 }]}>{phase === 'uploading' ? 'Uploading photo…' : phase === 'saved' ? 'Photo updated' : loading ? 'Loading photo…' : avatar ? 'Change photo' : 'Choose photo'}</Text>}
        </Button>
        {avatar && <RemoveMediaMenu open={optionsOpen} disabled={disabled} label="Photo options" removeLabel="Remove photo"
          onOpen={() => setOptionsOpen(true)} onClose={() => setOptionsOpen(false)} onRemove={remove} />}
      </View>
      {(!!error || phase === 'failed') && <ErrorState error={error || 'Photo not saved. Retry the upload.'} retryLabel={phase === 'failed' ? 'Retry upload' : 'Refresh'} retryAccessibilityLabel={phase === 'failed' ? 'Retry photo upload' : 'Refresh photo'} disabled={busy || working} onRetry={() => void run(async () => { if (phase === 'failed' && preview) await upload(preview); else await load(); })} />}
    </>}
    {cropFile && <ProfilePhotoCrop file={cropFile} onDone={finishCrop} />}
  </View>;
}
