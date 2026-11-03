import AttachmentPicker, { AttachmentOptions } from './AttachmentPicker';
import AttachmentTile from './AttachmentTile';
import KeyboardDialog from './KeyboardDialog';
import { CloseDialogActions, Dialog, DialogScrollBody } from './DialogParts';
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { clearPickedMedia, clearStagedMedia, pickMedia, stageMediaUpload } from './media';
import type { PendingMediaUpload, MediaSource } from './media';
import LocalAttachment from './LocalAttachment';
import { Button, ErrorText, useUI } from './ui';

export default function DraftAttachment({ value, path, disabled, onChange, onBusy, onError }: {
  value?: PendingMediaUpload; path: string; disabled: boolean;
  onChange: (value: PendingMediaUpload | undefined) => Promise<void>;
  onBusy: (busy: boolean) => void; onError: (error: string) => void;
}) {
  const { ui } = useUI(), [open, setOpen] = useState(false), [sourceOpen, setSourceOpen] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), trigger = useRef<React.ComponentRef<typeof View>>(null);
  const close = () => { if (!disabled && !working) { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); } };
  function fail(message: string) { setError(message); onError(message); setOpen(true); }
  async function run(action: () => Promise<void>) {
    if (disabled || lock.current) return;
    lock.current = true; setWorking(true); setError(''); onBusy(true);
    try { await action(); } catch (error) { fail(error instanceof Error ? error.message : 'Could not save this file.'); }
    finally { lock.current = false; setWorking(false); onBusy(false); }
  }
  async function add(photo: MediaSource) {
    const picked = await pickMedia(photo); if (!picked) return;
    let staged, saved = false;
    try {
      const id = Crypto.randomUUID(); staged = await stageMediaUpload(picked, id);
      await onChange({ id, path, file: staged }); saved = true;
    } finally { await clearPickedMedia(picked); if (staged && !saved) await clearStagedMedia(staged); }
  }
  return <>
    <AttachmentPicker visible={sourceOpen} disabled={disabled || working} onDismiss={() => setSourceOpen(false)} onPick={source => void run(() => add(source))} anchor={<AttachmentTile triggerRef={trigger} thumbnail={value ? <LocalAttachment file={value.file} disabled={disabled || working} onError={fail} thumbnailOnly size={80} /> : undefined}
      count={value ? 1 : 0} warning={!!error} loading={working} canAdd={!value} disabled={disabled || working} label={value ? `Draft attachment, ${value.file.name}` : 'Add attachment'}
      onPress={() => { if (disabled || working) return; if (value || error) setOpen(true); else setSourceOpen(true); }} />} />
    <KeyboardDialog visible={open} label="Attachment" placement="bottom" dismissable={!disabled && !working} onDismiss={close}>
      <Dialog.Title icon="attachment">Attachment</Dialog.Title><DialogScrollBody gap={12}>
        {value ? <><LocalAttachment file={value.file} disabled={disabled || working} onError={fail} /><Text style={ui.caption}>This file will be added when you save the bill.</Text>
          <Button title="Remove file" icon="remove" kind="text" disabled={disabled || working} onPress={() => void run(async () => { await onChange(undefined); await clearStagedMedia(value.file); })} /></>
          : <AttachmentOptions disabled={disabled || working} onPick={photo => void run(() => add(photo))} />}
        {!!error && <ErrorText live>{error}</ErrorText>}
      </DialogScrollBody><CloseDialogActions title="Done" disabled={disabled || working} onClose={close} />
    </KeyboardDialog>
  </>;
}
