import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { accountOwner, request } from './api';
import { clearMediaPreview, clearPickedMedia, clearStagedMedia, mediaSize, openPrivateMedia, pendingMediaUpload, pickMedia, retryMediaUpload, saveMediaUpload, stageMediaUpload } from './media';
import type { MediaList, MediaMetadata, PendingMediaUpload, PickedMedia } from './media';
import { getDatabase } from './native';
import PrivateMediaImage from './PrivateMediaImage';
import type { Session } from './types';
import { Button, Icon, useUI } from './ui';

export type BillAttachmentsProps = { session: Session | null; groupId: string; expenseId: string; revision?: number; readOnly?: boolean; busy: boolean; onBusyChange: (busy: boolean) => void; onChanged?: () => Promise<void> };
export default function BillAttachments({ session, groupId, expenseId, revision, readOnly = false, busy, onBusyChange, onChanged }: BillAttachmentsProps) {
  const { ui, palette } = useUI(), [items, setItems] = useState<MediaMetadata[]>([]), [canModify, setCanModify] = useState(false), [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<PendingMediaUpload | null>(null);
  const path = `/groups/${encodeURIComponent(groupId)}/expenses/${encodeURIComponent(expenseId)}/attachments`;
  const owner = session ? accountOwner(session) : '', identity = `${owner}|${path}`, identityRef = useRef(identity); identityRef.current = identity;
  const lock = useRef(false), mounted = useRef(true), current = () => mounted.current && identityRef.current === identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setItems([]); setCanModify(false); setPending(null); setError(''); }, [identity]);
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
  async function refreshAccepted(message: string) {
    if (!current()) return;
    try { await onChanged?.(); }
    catch { if (current()) setError(`${message} Could not refresh the group. Refresh when online.`); }
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
      await refreshAccepted('Attachment saved.');
    } catch (cause) {
      try { const saved = await pendingMediaUpload(db, session, path); if (current()) setPending(saved); } catch { /* Keep the current pending upload visible. */ }
      throw cause;
    }
  }
  function remove(item: MediaMetadata) {
    if (readOnly || !canModify || pending) return;
    Alert.alert('Remove this attachment?', item.name, [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', onPress: () => void run(async () => {
      if (readOnly || !canModify || pending) return;
      await request(session!, `${path}/${encodeURIComponent(item.id)}`, 'DELETE');
      if (current()) setItems(previous => previous.filter(value => value.id !== item.id));
      await clearMediaPreview(item);
      await refreshAccepted('Attachment removed.');
    }) }]);
  }
  const disabled = busy || loading || working, editable = !readOnly && canModify;
  return <View style={{ gap: 10 }}>
    <Text style={ui.section}>Attachments{items.length ? ` (${items.length})` : ''}</Text>
    {!session ? <Text style={ui.caption}>Share this group and sign in to add bill photos or PDFs.</Text> : <>
      {loading && <Text style={ui.caption}>Loading attachments…</Text>}
      {working && <Text accessibilityLiveRegion="polite" style={ui.caption}>Processing file…</Text>}
      {items.map(item => <View key={item.id} style={{ borderBottomWidth: 0.5, borderBottomColor: palette.line, paddingBottom: 8, gap: 4 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} disabled={disabled} onPress={() => void run(() => openPrivateMedia(session, item))} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56 }}>
          {item.content_type.startsWith('image/') ? <PrivateMediaImage session={session} media={item} /> : <View style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: palette.soft, alignItems: 'center', justifyContent: 'center' }}><Icon name="bill" /></View>}
          <View style={{ flex: 1, gap: 2 }}><Text style={ui.body}>{item.name}</Text><Text style={ui.caption}>{item.content_type === 'application/pdf' ? 'PDF' : 'Image'} · {mediaSize(item.size)}</Text></View><Icon name="next" size={18} />
        </Pressable>
        {editable && <Button title="Remove" accessibilityLabel={`Remove ${item.name}`} kind="text" disabled={disabled || !!pending} onPress={() => remove(item)} />}
      </View>)}
      {pending && <><Text style={ui.notice}>{pending.file.name} is saved on this phone. Retry to confirm the same upload without adding another copy. You can leave this screen and finish later.</Text><Button title="Retry upload" disabled={disabled || readOnly} onPress={() => void run(finishUpload)} /></>}
      {editable && !pending && items.length < 10 && <><Button title="Add photo" disabled={disabled} onPress={() => void run(() => add(true))} /><Button title="Add PDF or image from Files" disabled={disabled} onPress={() => void run(() => add(false))} /></>}
      {!loading && !editable && <Text style={ui.caption}>{readOnly ? 'Attachments are read-only while this group is archived or changes are waiting to sync.' : 'You can view attachments here.'}</Text>}
      {items.length >= 10 && <Text style={ui.caption}>This bill has the maximum of 10 attachments.</Text>}
      {!!error && <><Text accessibilityRole="alert" style={ui.error}>{error}</Text><Button title="Refresh attachments" kind="text" disabled={busy || working} onPress={() => void run(async () => { await load(); await onChanged?.(); })} /></>}
    </>}
  </View>;
}
