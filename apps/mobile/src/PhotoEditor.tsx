import { ErrorState } from './UIStates';

import Avatar, { PhotoSession } from './Avatar';
import type { ProfilePhoto as ProfilePhotoValue } from './types';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Alert } from './alerts';
import * as Crypto from 'expo-crypto';
import { accountOwner, request, cachedRead } from './api';
import { clearPickedMedia, pickMedia, uploadMedia } from './media';
import type { AvatarResult, MediaMetadata } from './media';
import KeyboardDialog from './KeyboardDialog';
import { Dialog, DialogScrollBody } from './DialogParts';
import LoadingSpinner from './LoadingSpinner';
import ProfilePhotoCrop from './ProfilePhotoCrop';
import type { PickedMedia } from './media';
import RemoveMediaMenu from './RemoveMediaMenu';
import type { Session } from './types';
import { Button, Icon, useUI } from './ui';

type PhotoResult = Partial<AvatarResult> & { group_photo?: MediaMetadata | null };
export type PhotoEditorProps = { session: Session | null; busy: boolean; onBusyChange: (busy: boolean) => void; compact?: boolean; onChanged?: () => void | Promise<void>; children?: React.ReactNode; group?: { id: string; group_photo?: MediaMetadata | null }; editable?: boolean };
export default function PhotoEditor({ session, busy, onChanged, compact = false, children, group, editable = true }: PhotoEditorProps) {
  const readPath = group ? `/groups/${group.id}/photo` : '/me', uploadPath = group ? readPath : '/me/avatar';
  const photoOf = (result: PhotoResult) => (group ? result.group_photo : result.avatar) ?? null;
  const subject = group ? 'group photo' : 'profile photo';
  const cachedProfile = group ? { avatar: group.group_photo ?? null } : session ? cachedRead<AvatarResult>(session, '/me') : undefined;
  const { ui, palette } = useUI(), [fallback, setFallback] = useState<ProfilePhotoValue | null>(cachedProfile?.profile_photo ?? null), [avatar, setAvatar] = useState<MediaMetadata | null>(cachedProfile?.avatar ?? null), [loading, setLoading] = useState(!cachedProfile), [working, setWorking] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<{ file: PickedMedia; id: string } | null>(null), [phase, setPhase] = useState<'idle' | 'uploading' | 'saved' | 'failed'>('idle');
  const [cropFile, setCropFile] = useState<PickedMedia | null>(null), cropResult = useRef<((file: PickedMedia | null) => void) | null>(null), revision = useRef(0), uploadingFile = useRef<PickedMedia | null>(null);
  useEffect(() => () => { if (preview && preview.file.uri !== uploadingFile.current?.uri) void clearPickedMedia(preview.file); }, [preview?.file.uri]);
  useEffect(() => () => { cropResult.current?.(null); }, []);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const lock = useRef(false), mounted = useRef(true), owner = session ? accountOwner(session) : '';
  const identity = `${owner}|${session?.token ?? ''}|${group?.id ?? ''}`, ownerRef = useRef(identity); ownerRef.current = identity;
  const current = () => mounted.current && ownerRef.current === identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const cached = group ? { avatar: group.group_photo ?? null } : session ? cachedRead<AvatarResult>(session, '/me') : undefined;
    const version = revision.current; let active = true; setAvatar(cached?.avatar ?? null); setFallback(cached?.profile_photo ?? null); setOptionsOpen(false); setPreview(null); setPhase('idle'); setError(''); setLoading(!cached);
    if (!session) { setLoading(false); return; }
    void request<PhotoResult>(session, readPath).then(result => { if (active && version === revision.current) { setAvatar(photoOf(result)); setFallback(result.profile_photo ?? null); } })
      .catch(() => { if (active && version === revision.current) setError(`Could not load the ${subject}. Refresh when online.`); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [owner, session?.token, group?.id, group?.group_photo?.id]);
  async function load() {
    if (!session) return;
    const result = await request<PhotoResult>(session, readPath);
    if (current()) { setAvatar(photoOf(result)); setFallback(result.profile_photo ?? null); }
    return result;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current || busy || !session || !editable) return;
    lock.current = true; revision.current++; setWorking(true); setLoading(false); setError('');
    try { await action(); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : `Could not update the ${subject}. Refresh and try again.`); }
    finally { lock.current = false; if (current()) setWorking(false); }
  }
  async function upload(value: { file: PickedMedia; id: string }) {
    if (!session) return;
    uploadingFile.current = value.file; setPhase('uploading');
    try {
      let result: PhotoResult;
      try { result = await uploadMedia<PhotoResult>(session, uploadPath, value.file, value.id, undefined, undefined, current); }
      catch (cause) { const latest = await load().catch(() => undefined); if (!latest || photoOf(latest)?.id !== value.id) throw cause; result = latest; }
      if (photoOf(result)?.id !== value.id) throw new Error('Could not confirm the photo. Refresh and try again.');
      if (current()) {
        setAvatar(photoOf(result)); setFallback(result.profile_photo ?? null); setPhase('saved');
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
    Alert.alert(group ? 'Remove group photo?' : 'Remove your photo?', group ? 'The default group icon will appear for everyone.' : 'Your account and bills will stay.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove photo', onPress: () => void run(async () => {
      await request(session!, group ? `${uploadPath}/${avatar!.id}` : uploadPath, 'DELETE'); await load(); if (current()) { setPreview(null); setPhase('idle'); void Promise.resolve().then(() => onChanged?.()).catch(() => {}); }
    }) }]);
  }
  const disabled = busy || loading || working || !editable;
  return <View style={{ gap: 10 }}>
    {!session ? <Text style={ui.caption}>Sign in to add your profile photo.</Text> : <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Button kind="plain" accessibilityRole="button" accessibilityLabel={working ? `Updating ${subject}` : group ? 'Edit group photo' : avatar ? 'Change profile photo' : 'Choose profile photo'} accessibilityState={{ disabled, busy: loading || working }} disabled={disabled} onPress={() => { if (group) setOptionsOpen(true); else void run(choose); }} style={{ flex: compact ? undefined : 1, flexShrink: compact ? 0 : undefined, width: compact ? 64 : undefined, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 }}>
          <Avatar label={phase === 'saved' ? `${subject} updated` : undefined} photo={avatar ?? fallback} source={preview ? { uri: preview.file.uri } : undefined} size={64} backgroundColor={palette.soft}><Icon name={group ? 'groups' : 'me'} size={30} /></Avatar>
          {compact && editable ? <View style={{ position: 'absolute', right: 0, bottom: 0, backgroundColor: palette.background, borderRadius: 12, padding: 3 }}>{loading || working ? <LoadingSpinner visible label={loading ? `Loading ${subject}` : phase === 'uploading' ? `Uploading ${subject}` : `Updating ${subject}`}  color={palette.accent} /> : <Icon name={!group && phase === 'saved' ? 'check' : 'edit'} size={16} />}</View> : !compact && <Text style={[ui.body, { flex: 1 }]}>{phase === 'uploading' ? 'Uploading photo…' : working ? 'Updating photo…' : phase === 'saved' ? 'Photo updated' : loading ? 'Loading photo…' : avatar ? 'Change photo' : 'Choose photo'}</Text>}
        </Button>
        {children}
        {avatar && !group && <RemoveMediaMenu open={optionsOpen} disabled={disabled} label="Photo options" removeLabel="Remove photo"
          onOpen={() => setOptionsOpen(true)} onClose={() => setOptionsOpen(false)} onRemove={remove} />}
      </View>
      {(!!error || phase === 'failed') && <ErrorState error={error || 'Photo not saved. Retry the upload.'} retryLabel={phase === 'failed' ? 'Retry upload' : 'Refresh'} retryAccessibilityLabel={phase === 'failed' ? 'Retry photo upload' : 'Refresh photo'} disabled={busy || working || !editable} onRetry={() => void run(async () => { if (phase === 'failed' && preview) await upload(preview); else await load(); })} />}
    </>}
    {group && <KeyboardDialog label="Group photo" visible={optionsOpen} onDismiss={() => setOptionsOpen(false)}>
      <Dialog.Title icon="attachment">Group photo</Dialog.Title>
      <DialogScrollBody maxHeight={320} gap={12}>
        <PhotoSession.Provider value={session}><View style={{ alignItems: 'center' }}><Avatar photo={avatar} size={112} backgroundColor={palette.soft}><Icon name="groups" size={48} /></Avatar></View></PhotoSession.Provider>
        <Button title={avatar ? 'Change photo' : 'Choose photo'} icon="attachment" disabled={disabled} onPress={() => { setOptionsOpen(false); void run(choose); }} />
        {!!avatar && <Button title="Remove photo" icon="remove" disabled={disabled} onPress={() => { setOptionsOpen(false); remove(); }} />}
      </DialogScrollBody>
    </KeyboardDialog>}
    {cropFile && <ProfilePhotoCrop file={cropFile} onDone={finishCrop} />}
  </View>;
}
