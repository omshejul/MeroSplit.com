import React, { useRef } from 'react';
import { Platform, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Alert } from './alerts';
import { clearPickedMedia, clearStagedMedia, pickMedia, stageMediaUpload } from './media';
import type { PendingMediaUpload } from './media';
import LocalAttachment from './LocalAttachment';
import { Button, SettingsRow } from './ui';

export default function DraftAttachment({ value, path, disabled, onChange, onBusy, onError }: {
  value?: PendingMediaUpload; path: string; disabled: boolean;
  onChange: (value: PendingMediaUpload | undefined) => Promise<void>;
  onBusy: (busy: boolean) => void; onError: (error: string) => void;
}) {
  const lock = useRef(false);
  async function run(action: () => Promise<void>) {
    if (disabled || lock.current) return;
    lock.current = true; onBusy(true);
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : 'Could not save this file.'); }
    finally { lock.current = false; onBusy(false); }
  }
  async function add(photo: boolean) {
    const picked = await pickMedia(photo); if (!picked) return;
    let staged, saved = false;
    try {
      const id = Crypto.randomUUID(); staged = await stageMediaUpload(picked, id);
      await onChange({ id, path, file: staged }); saved = true;
    } finally { await clearPickedMedia(picked); if (staged && !saved) await clearStagedMedia(staged); }
  }
  return value ? <View>
    <LocalAttachment file={value.file} disabled={disabled} onError={onError} />
    <Button title="Remove file" icon="remove" kind="text" disabled={disabled} onPress={() => void run(async () => { await onChange(undefined); await clearStagedMedia(value.file); })} />
  </View> : <SettingsRow label="Add photo or PDF" icon="attachment" chevron={false} disabled={disabled} onPress={() => Platform.OS === 'web' ? void run(() => add(false)) : Alert.alert('Add photo or PDF', undefined, [
    { text: 'Cancel', style: 'cancel' }, { text: 'Photo', onPress: () => void run(() => add(true)) }, { text: 'Files', onPress: () => void run(() => add(false)) },
  ])} />;
}
