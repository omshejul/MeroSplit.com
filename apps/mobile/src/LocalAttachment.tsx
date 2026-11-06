import { useLoading } from './LoadingOverlay';
import AttachmentRow from './AttachmentRow';
import MediaPreviewFrame from './MediaPreviewFrame';
import React, { useEffect, useState } from 'react';
import { Image } from 'react-native';

import type { PickedMedia } from './media';
import { mediaSize } from './media';
import { localMediaUrl, clearLocalMediaUrl, openLocalMedia } from './mediaPlatform';
import { useUI } from './ui';

// The same private, local preview is used by bill drafts and pending uploads.
export default function LocalAttachment({ file, disabled, onError, thumbnailOnly = false, size = 56, title = file.name, subtitle = `${mediaSize(file.size)} · Tap to preview` }: { thumbnailOnly?: boolean; size?: number; title?: string; subtitle?: string; file: PickedMedia; disabled: boolean; onError: (message: string) => void }) {
  const { ui, palette } = useUI(), [uri, setUri] = useState(''), [opening, setOpening] = useState(false), [failed, setFailed] = useState(false);
  useLoading(opening);
  useEffect(() => {
    let active = true, resolved = '';
    setUri(''); setFailed(false);
    void localMediaUrl(file).then(value => { resolved = value; if (active) setUri(value); else clearLocalMediaUrl(value); }).catch(() => { if (active) { setFailed(true); onError('Could not load the saved file.'); } });
    return () => { active = false; if (resolved) clearLocalMediaUrl(resolved); };
  }, [file.uri]);
  const pdf = file.type === 'application/pdf';
  const thumbnail = uri && !pdf ? <Image source={{ uri }} style={{ width: size, height: size, borderRadius: 8 }} accessibilityLabel={title} onError={() => onError('Could not load the photo preview.')} />
    : <MediaPreviewFrame size={size} loading={!uri && !failed} borderRadius={8} label={`${pdf ? 'PDF' : 'Photo'} preview`} text={pdf ? 'PDF' : 'Photo'} />;
  return thumbnailOnly ? thumbnail : <AttachmentRow title={title} label={`Preview ${title}`} subtitle={subtitle} disabled={disabled || !uri} onOpen={() => { setOpening(true); void openLocalMedia(file, uri).catch(() => onError('Could not preview this file. Try again.')).finally(() => setOpening(false)); }} thumbnail={thumbnail} />;
}
