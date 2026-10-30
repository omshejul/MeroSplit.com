import MediaPreviewFrame, { mediaPreviewShape } from './MediaPreviewFrame';
import Avatar from './Avatar';
import React, { useEffect, useRef, useState } from 'react';
import { Image, Platform } from 'react-native';
import { mediaThumbnail } from './media';
import type { MediaMetadata } from './media';
import type { Session } from './types';
import { Icon, useUI } from './ui';

export default function PrivateMediaThumbnail({ session, media, size = 56, profile = false }: { session: Session; media: MediaMetadata; size?: number; profile?: boolean }) {
  const { palette, ui } = useUI(), [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false);
  const generation = useRef(0), retried = useRef(false);
  useEffect(() => {
    if (profile) return;
    const current = ++generation.current; retried.current = false; setUrl(null); setFailed(false);
    void mediaThumbnail(session, media).then(value => { if (generation.current === current) setUrl(value); }).catch(() => { if (generation.current === current) setFailed(true); });
    return () => { generation.current++; };
  }, [session.baseUrl, session.userId, session.token, media.id, profile]);
  function retry() {
    if (retried.current) { setUrl(null); setFailed(true); return; }
    const current = generation.current; retried.current = true; setUrl(null);
    void mediaThumbnail(session, media).then(value => { if (generation.current === current) setUrl(value); }).catch(() => { if (generation.current === current) setFailed(true); });
  }
  const shape = mediaPreviewShape(size);
  const preview = media.content_type === 'application/pdf' ? 'PDF' : 'photo';
  if (failed && Platform.OS !== 'web') return <MediaPreviewFrame size={size} label={`Retry ${preview} preview`} text="Retry" onRetry={() => { retried.current = false; setFailed(false); retry(); }} />;
  if (failed) return <MediaPreviewFrame size={size} label={`${preview} preview unavailable`} text={preview === 'PDF' ? 'PDF' : 'Photo'} />;
  if (profile) return <Avatar size={size} photo={media} backgroundColor={palette.soft} label="Your profile photo"><Icon name="me" size={24} color={palette.muted} /></Avatar>;
  return url ? <Image source={{ uri: url }} style={[shape, { backgroundColor: palette.soft }]} resizeMode={preview === 'PDF' ? 'contain' : 'cover'} accessibilityLabel={profile ? 'Your profile photo' : media.name} onError={retry} />
    : <MediaPreviewFrame loading size={size} label={`Loading ${preview} preview`} />;
}
