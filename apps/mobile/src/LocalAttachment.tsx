import AttachmentRow from './AttachmentRow';
import MediaPreviewFrame from './MediaPreviewFrame';
import React, { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { Text } from 'react-native-paper';
import type { PickedMedia } from './media';
import { mediaSize } from './media';
import { localMediaUrl, clearLocalMediaUrl, openLocalMedia } from './mediaPlatform';
import { Button, Icon, useUI } from './ui';

// The same private, local preview is used by bill drafts and pending uploads.
export default function LocalAttachment({ file, disabled, onError }: { file: PickedMedia; disabled: boolean; onError: (message: string) => void }) {
  const { ui, palette } = useUI(), [uri, setUri] = useState('');
  useEffect(() => {
    let active = true, resolved = '';
    setUri('');
    void localMediaUrl(file).then(value => { resolved = value; if (active) setUri(value); else clearLocalMediaUrl(value); }).catch(() => { if (active) onError('Could not load the saved file.'); });
    return () => { active = false; if (resolved) clearLocalMediaUrl(resolved); };
  }, [file.uri]);
  const pdf = file.type === 'application/pdf';
  return <AttachmentRow title={file.name} label={`Preview ${file.name}`} subtitle={`${mediaSize(file.size)} · Tap to preview`} disabled={disabled || !uri} onOpen={() => void openLocalMedia(file, uri).catch(() => onError('Could not preview this file. Try again.'))} thumbnail={uri && !pdf ? <Image source={{ uri }} style={{ width: 56, height: 56, borderRadius: 8 }} accessibilityLabel={file.name} onError={() => onError('Could not load the photo preview.')} />
      : <MediaPreviewFrame borderRadius={8} label={`${pdf ? 'PDF' : 'Photo'} preview`} text={pdf ? 'PDF' : 'Photo'} />} />;
}
