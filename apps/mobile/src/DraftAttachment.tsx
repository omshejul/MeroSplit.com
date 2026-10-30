import { useLoading } from './LoadingOverlay';
import AttachmentPicker from './AttachmentPicker';
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';

import { clearPickedMedia, clearStagedMedia, pickMedia, stageMediaUpload } from './media';
import type { PendingMediaUpload } from './media';
import LocalAttachment from './LocalAttachment';
import { Button } from './ui';

export default function DraftAttachment({ value, path, disabled, onChange, onBusy, onError }: {
  value?: PendingMediaUpload; path: string; disabled: boolean;
  onChange: (value: PendingMediaUpload | undefined) => Promise<void>;
  onBusy: (busy: boolean) => void; onError: (error: string) => void;
}) {
  const lock = useRef(false), [working, setWorking] = useState(false);
  useLoading(working);
  async function run(action: () => Promise<void>) {
    if (disabled || lock.current) return;
    lock.current = true; setWorking(true); onBusy(true);
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : 'Could not save this file.'); }
    finally { lock.current = false; setWorking(false); onBusy(false); }
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
  </View> : <AttachmentPicker disabled={disabled} onPick={photo => void run(() => add(photo))} />;
}
