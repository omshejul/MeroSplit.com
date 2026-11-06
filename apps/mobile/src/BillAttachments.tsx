import { useLoading } from './LoadingOverlay';
import { useToast } from './Toast';
import { animateLayout } from './layoutTransition';
import { ErrorState } from './UIStates';
import { LoadingState } from './UIStates';
import { NoticeBanner } from './UIStates';

import AttachmentPicker from './AttachmentPicker';
import AttachmentGallery from './AttachmentGallery';
import AttachmentTile from './AttachmentTile';
import BottomSheet from './BottomSheet';
import React, { useEffect, useRef, useState } from 'react';
import { useScreenRemovalLock } from './screenRemoval';
import { Text, View, useWindowDimensions } from 'react-native';
import { Alert } from './alerts';
import * as Crypto from 'expo-crypto';
import { accountOwner, request } from './api';
import { clearMediaPreview, clearPickedMedia, clearStagedMedia, openPrivateMedia, pendingMediaUpload, pickMedia, retryMediaUpload, removePendingMediaUpload, saveMediaUpload, stageMediaUpload } from './media';
import type { MediaList, MediaMetadata, PendingMediaUpload, PickedMedia, MediaSource } from './media';
import { getDatabase } from './native';
import LocalAttachment from './LocalAttachment';
import PrivateMediaImage from './PrivateMediaImage';
import type { Session } from './types';
import { Button, useUI } from './ui';

export type BillAttachmentsProps = { session: Session | null; groupId: string; expenseId: string; revision?: number; billTitle?: string; readOnly?: boolean; busy: boolean; onBusyChange: (busy: boolean) => void; onChanged?: () => Promise<void> };
export default function BillAttachments({ session, groupId, expenseId, revision, billTitle = '', readOnly = false, busy, onBusyChange, onChanged }: BillAttachmentsProps) {
  const notify = useToast(), { height } = useWindowDimensions();
  const { ui, motion } = useUI(), [items, setItems] = useState<MediaMetadata[]>([]), [canModify, setCanModify] = useState(false), [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [error, setError] = useState('');
  useScreenRemovalLock(working);
  const [open, setOpen] = useState(false), [sourceOpen, setSourceOpen] = useState(false), trigger = useRef<React.ComponentRef<typeof View>>(null);
  const close = () => { if (!busy && !working) { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); } };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMediaUpload | null>(null);
  const path = `/groups/${encodeURIComponent(groupId)}/expenses/${encodeURIComponent(expenseId)}/attachments`;
  const owner = session ? accountOwner(session) : '', identity = `${owner}|${path}`, identityRef = useRef(identity); identityRef.current = identity;
  const lock = useRef(false), mounted = useRef(true), current = () => mounted.current && identityRef.current === identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setItems([]); setCanModify(false); setPending(null); setSelectedId(null); setError(''); setOpen(false); setSourceOpen(false); }, [identity]);
  useEffect(() => {
    let active = true; setLoading(true);
    if (!session) { setLoading(false); return; }
    void getDatabase().then(db => pendingMediaUpload(db, session, path)).then(saved => { if (active) setPending(saved); return request<MediaList>(session, path); })
      .then(result => { if (active) { animateLayout(!!motion?.enabled); adoptItems(result.attachments); setCanModify(result.can_modify); setLoading(false); } })
      .catch(() => { if (active) { animateLayout(!!motion?.enabled); setError('Could not load attachments. Refresh when online.'); setLoading(false); } });
    return () => { active = false; };
  }, [identity, session?.token, revision]);
  function adoptItems(attachments: MediaMetadata[]) {
    setItems(attachments);
    setSelectedId(id => attachments.find(item => item.id === id)?.id ?? attachments[0]?.id ?? null);
  }
  async function load() {
    if (!session) return;
    const saved = await pendingMediaUpload(await getDatabase(), session, path);
    if (current()) setPending(saved);
    const result = await request<MediaList>(session, path);
    if (current()) { animateLayout(!!motion?.enabled); adoptItems(result.attachments); setCanModify(result.can_modify); }
    return result;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current || busy || !session) return;
    lock.current = true; setWorking(true); setError(''); onBusyChange(true);
    try { await action(); }
    catch (cause) { if (current()) { setError(cause instanceof Error ? cause.message : 'Could not update attachments. Refresh and try again.'); setOpen(true); } }
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
  async function add(photo: MediaSource) {
    if (!session || readOnly || !canModify || pending || items.length >= 10) return;
    const file = await pickMedia(photo); if (!file) return;
    if (current()) setOpen(true);
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
      if (current()) { setItems(previous => [...previous.filter(item => item.id !== accepted.id), accepted]); setPending(null); setSelectedId(accepted.id); notify('Attachment uploaded.'); }
      refreshAccepted('Attachment saved.');
    } catch (cause) {
      try { const saved = await pendingMediaUpload(db, session, path); if (current()) setPending(saved); } catch { /* Keep the current pending upload visible. */ }
      throw cause;
    }
  }
  function remove(item: MediaMetadata) {
    if (readOnly || !canModify || pending) return;
    Alert.alert('Remove this attachment?', `Remove this ${item.content_type === 'application/pdf' ? 'PDF' : 'photo'} from the bill?`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove attachment', style: 'destructive', onPress: () => void run(async () => {
      if (readOnly || !canModify || pending) return;
      await request(session!, `${path}/${encodeURIComponent(item.id)}`, 'DELETE');
      if (current()) {
        const index = items.findIndex(value => value.id === item.id);
        setSelectedId(items[index + 1]?.id ?? items[index - 1]?.id ?? null);
        setItems(previous => previous.filter(value => value.id !== item.id));
      }
      await clearMediaPreview(item);
      refreshAccepted('Attachment removed.');
    }) }]);
  }
  const selected = items.find(item => item.id === selectedId) ?? items[0];
  const selectedLabel = selected ? `${selected.content_type === 'application/pdf' ? 'PDF' : 'Photo'} ${items.indexOf(selected) + 1} of ${items.length}` : '';
  const disabled = busy || loading || working, editable = !readOnly && canModify;
  useLoading(working);
  const preview = session && items[0] ? <PrivateMediaImage session={session} media={items[0]} label="Attachment preview" size={80} interactive={false} /> : pending ? <LocalAttachment file={pending.file} disabled={disabled} onError={setError} title="Pending attachment" thumbnailOnly size={80} /> : undefined;
  const needsAttention = !!(pending || error), hasFiles = !!(items.length || pending);
  return <>
    <AttachmentPicker visible={sourceOpen} disabled={disabled} onDismiss={() => setSourceOpen(false)} onPick={source => void run(() => add(source))} anchor={<AttachmentTile triggerRef={trigger} thumbnail={preview} count={items.length} loading={loading || working} warning={needsAttention} canAdd={editable && !hasFiles} disabled={disabled}
      label={loading ? 'Loading attachments' : working ? 'Processing file' : needsAttention ? `Attachments, ${items.length} saved ${items.length === 1 ? 'file' : 'files'}, needs attention` : hasFiles ? `Attachments, ${items.length} ${items.length === 1 ? 'file' : 'files'}` : editable ? 'Add attachment' : 'View attachments'}
      onPress={() => { if (disabled) return; if (!hasFiles && editable && !error) setSourceOpen(true); else setOpen(true); }} />} />
    <BottomSheet visible={open} title="Photos & documents" icon="attachment" closeIconOnly doneAccessibilityLabel="Close attachments" disabled={busy || working} maxHeight={height} gap={10} onDismiss={close}>
    {!session ? <Text style={ui.caption}>Sign in to view attachments.</Text> : <>
      {loading && <LoadingState label="Loading attachments…" />}
      {working && <LoadingState label="Processing file…" />}
      {!!billTitle && <Text style={ui.caption}>{billTitle}</Text>}
      <AttachmentGallery session={session} items={items} selectedId={selected?.id ?? null} disabled={disabled}
        onSelect={setSelectedId} onOpen={item => void run(() => openPrivateMedia(session, item))}
        onAdd={editable && !pending && items.length < 10 ? () => { setOpen(false); setSourceOpen(true); } : undefined}
        options={selected && editable && <Button iconOnly icon="more" kind="text" accessibilityLabel={`Options for ${selectedLabel}`} disabled={disabled || !!pending} onPress={() => remove(selected)} />} />
      {pending && <><LocalAttachment file={pending.file} title={`${pending.file.type === 'application/pdf' ? 'PDF' : 'Photo'} waiting to upload`} subtitle="Saved on this device" disabled={disabled} onError={setError} />
        {!working && <NoticeBanner tone={pending.rejection ? 'error' : 'warning'}>{pending.rejection
          ? `File not uploaded. ${pending.rejection} Your file is saved on this device. Remove it to choose another file.`
          : 'Upload not confirmed. Your file is saved on this device. Retry when online.'}</NoticeBanner>}
        {!pending.rejection && <Button title="Retry upload" icon="refresh" disabled={disabled || readOnly} onPress={() => void run(finishUpload)} />}
        <Button title="Remove file" icon="remove" kind="text" disabled={disabled || readOnly} onPress={() => void run(async () => { await removePendingMediaUpload(await getDatabase(), session, path, undefined, undefined, pending ?? undefined); if (current()) setPending(null); await load(); await onChanged?.(); })} /></>}
      {!loading && readOnly && <Text style={ui.caption}>Read-only while archived or waiting to sync.</Text>}
      {items.length >= 10 && <Text style={ui.caption}>This bill has the maximum of 10 attachments.</Text>}
      {!!error && error !== pending?.rejection && <ErrorState error={error} retryLabel="Refresh attachments" disabled={busy || working || loading} onRetry={!pending ? () => void refresh() : undefined} />}
    </>}
    </BottomSheet>
  </>;
}
