import { ErrorState } from './UIStates';
import { LoadingState } from './UIStates';
import { NoticeBanner } from './UIStates';
import { ErrorText } from './ui';
import AttachmentPicker from './AttachmentPicker';
import AttachmentRow from './AttachmentRow';
import React, { useEffect, useRef, useState } from 'react';
import { useScreenRemovalLock } from './screenRemoval';
import { Platform, Text, View } from 'react-native';
import { Alert } from './alerts';
import * as Crypto from 'expo-crypto';
import { accountOwner, request } from './api';
import { clearMediaPreview, clearPickedMedia, clearStagedMedia, mediaSize, openPrivateMedia, pendingMediaUpload, pickMedia, retryMediaUpload, removePendingMediaUpload, saveMediaUpload, stageMediaUpload } from './media';
import type { MediaList, MediaMetadata, PendingMediaUpload, PickedMedia } from './media';
import { getDatabase } from './native';
import LocalAttachment from './LocalAttachment';
import PrivateMediaImage from './PrivateMediaImage';
import RemoveMediaMenu from './RemoveMediaMenu';
import type { Session } from './types';
import { SectionHeading, Button, Icon, SettingsRow, useUI } from './ui';

export type BillAttachmentsProps = { session: Session | null; groupId: string; expenseId: string; revision?: number; readOnly?: boolean; busy: boolean; onBusyChange: (busy: boolean) => void; onChanged?: () => Promise<void> };
export default function BillAttachments({ session, groupId, expenseId, revision, readOnly = false, busy, onBusyChange, onChanged }: BillAttachmentsProps) {
  const { ui } = useUI(), [items, setItems] = useState<MediaMetadata[]>([]), [canModify, setCanModify] = useState(false), [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [error, setError] = useState('');
  useScreenRemovalLock(working);
  const [optionsId, setOptionsId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMediaUpload | null>(null);
  const path = `/groups/${encodeURIComponent(groupId)}/expenses/${encodeURIComponent(expenseId)}/attachments`;
  const owner = session ? accountOwner(session) : '', identity = `${owner}|${path}`, identityRef = useRef(identity); identityRef.current = identity;
  const lock = useRef(false), mounted = useRef(true), current = () => mounted.current && identityRef.current === identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setItems([]); setCanModify(false); setPending(null); setOptionsId(null); setError(''); }, [identity]);
  useEffect(() => {
    let active = true; setLoading(true);
    if (!session) { setLoading(false); return; }
    void getDatabase().then(db => pendingMediaUpload(db, session, path)).then(saved => { if (active) setPending(saved); return request<MediaList>(session, path); })
      .then(result => { if (active) { setItems(result.attachments); setCanModify(result.can_modify); } })
      .catch(() => { if (active) setError('Could not load attachments. Refresh when online.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [identity, session?.token, revision]);
  async function load() {
    if (!session) return;
    const saved = await pendingMediaUpload(await getDatabase(), session, path);
    if (current()) setPending(saved);
    const result = await request<MediaList>(session, path);
    if (current()) { setItems(result.attachments); setCanModify(result.can_modify); }
    return result;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current || busy || !session) return;
    lock.current = true; setWorking(true); setError(''); onBusyChange(true);
    try { await action(); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not update attachments. Refresh and try again.'); }
    finally { lock.current = false; if (current()) setWorking(false); onBusyChange(false); }
  }
  async function refresh() {
    setLoading(true); setError('');
    try { await load(); if (current()) await onChanged?.(); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not load attachments. Try again.'); }
    finally { if (current()) setLoading(false); }
  }
  function refreshAccepted(message: string) {
    if (!current()) return;
    void onChanged?.().catch(() => { if (current()) setError(`${message} Could not refresh the group. Refresh when online.`); });
  }
  async function add(photo: boolean) {
    if (!session || readOnly || !canModify || pending || items.length >= 10) return;
    const file = await pickMedia(photo); if (!file) return;
    if (!current()) { await clearPickedMedia(file); return; }
    const id = Crypto.randomUUID(); let staged: PickedMedia | undefined, stored = false;
    try {
      staged = await stageMediaUpload(file, id);
      if (!current()) { await clearStagedMedia(staged); return; }
      const saved = { id, path, file: staged };
      await saveMediaUpload(await getDatabase(), session, saved); stored = true;
      if (current()) setPending(saved);
    } catch (cause) {
      if (staged && !stored) await clearStagedMedia(staged);
      throw cause;
    } finally { await clearPickedMedia(file); }
    await finishUpload();
  }
  async function finishUpload() {
    if (!session || readOnly) return;
    const db = await getDatabase();
    try {
      const accepted = await retryMediaUpload(db, session, path);
      if (current()) { setItems(previous => [...previous.filter(item => item.id !== accepted.id), accepted]); setPending(null); }
      refreshAccepted('Attachment saved.');
    } catch (cause) {
      try { const saved = await pendingMediaUpload(db, session, path); if (current()) setPending(saved); } catch { /* Keep the current pending upload visible. */ }
      throw cause;
    }
  }
  function remove(item: MediaMetadata) {
    if (readOnly || !canModify || pending) return;
    Alert.alert('Remove this attachment?', item.name, [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove attachment', onPress: () => void run(async () => {
      if (readOnly || !canModify || pending) return;
      await request(session!, `${path}/${encodeURIComponent(item.id)}`, 'DELETE');
      if (current()) setItems(previous => previous.filter(value => value.id !== item.id));
      await clearMediaPreview(item);
      refreshAccepted('Attachment removed.');
    }) }]);
  }
  const disabled = busy || loading || working, editable = !readOnly && canModify;
  return <View role="region" accessibilityLabel="Attachments" style={{ gap: 10 }}>
    <SectionHeading>Attachments{items.length ? ` (${items.length})` : ''}</SectionHeading>
    {!session ? <Text style={ui.caption}>Sign in to view attachments.</Text> : <>
      {loading && <LoadingState label="Loading attachments…" />}
      {working && <LoadingState label="Processing file…" />}
      {items.map(item => <AttachmentRow key={item.id} title={item.name} label={`Open ${item.name}`} subtitle={`${item.content_type === 'application/pdf' ? 'PDF' : 'Image'} · ${mediaSize(item.size)}`} thumbnail={<PrivateMediaImage session={session} media={item} />} disabled={disabled}
        onOpen={() => void run(() => openPrivateMedia(session, item))} options={editable && <RemoveMediaMenu open={optionsId === item.id} disabled={disabled || !!pending} label={`Options for ${item.name}`} removeLabel="Remove attachment"
          onOpen={() => setOptionsId(item.id)} onClose={() => setOptionsId(null)} onRemove={() => remove(item)} />} />)}
      {pending && <><LocalAttachment file={pending.file} disabled={disabled} onError={setError} /><NoticeBanner tone="warning">Upload not confirmed: {pending.file.name}.</NoticeBanner><Button title="Retry upload" icon="refresh" disabled={disabled || readOnly} onPress={() => void run(finishUpload)} /><Button title="Remove file" icon="remove" kind="text" disabled={disabled || readOnly} onPress={() => void run(async () => { await removePendingMediaUpload(await getDatabase(), session, path); if (current()) setPending(null); await load(); await onChanged?.(); })} /></>}
      {editable && !pending && items.length < 10 && <AttachmentPicker disabled={disabled} onPick={photo => void run(() => add(photo))} />}
      {!loading && readOnly && <Text style={ui.caption}>Read-only while archived or waiting to sync.</Text>}
      {items.length >= 10 && <Text style={ui.caption}>This bill has the maximum of 10 attachments.</Text>}
      {!!error && <ErrorState error={error} retryLabel="Refresh attachments" disabled={busy || working || loading} onRetry={!pending ? () => void refresh() : undefined} />}
    </>}
  </View>;
}
