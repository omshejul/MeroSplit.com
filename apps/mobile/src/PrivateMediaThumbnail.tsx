import React, { useEffect, useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { mediaThumbnail } from './media';
import type { MediaMetadata } from './media';
import type { Session } from './types';
import { Icon, radii, useUI } from './ui';

export default function PrivateMediaThumbnail({ session, media, size = 56, profile = false }: { session: Session; media: MediaMetadata; size?: number; profile?: boolean }) {
  const { palette, ui } = useUI(), [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false);
  const generation = useRef(0), retried = useRef(false);
  useEffect(() => {
    const current = ++generation.current; retried.current = false; setUrl(null); setFailed(false);
    void mediaThumbnail(session, media).then(value => { if (generation.current === current) setUrl(value); }).catch(() => { if (generation.current === current) setFailed(true); });
    return () => { generation.current++; };
  }, [session.baseUrl, session.userId, session.token, media.id]);
  function retry() {
    if (retried.current) { setUrl(null); setFailed(true); return; }
    const current = generation.current; retried.current = true; setUrl(null);
    void mediaThumbnail(session, media).then(value => { if (generation.current === current) setUrl(value); }).catch(() => { if (generation.current === current) setFailed(true); });
  }
  const shape = { width: size, height: size, borderRadius: profile ? size / 2 : radii.control };
  const preview = media.content_type === 'application/pdf' ? 'PDF' : 'photo';
  if (failed) return <View accessibilityLabel={`${preview} preview unavailable`} style={[shape, { backgroundColor: palette.soft, alignItems: 'center', justifyContent: 'center' }]}><Icon name="bill" size={24} color={palette.muted} /><Text style={ui.caption}>{preview === 'PDF' ? 'PDF' : 'Photo'}</Text></View>;
  return url ? <Image source={{ uri: url }} style={[shape, { backgroundColor: palette.soft }]} resizeMode={preview === 'PDF' ? 'contain' : 'cover'} accessibilityLabel={profile ? 'Your profile photo' : media.name} onError={retry} />
    : <View accessible accessibilityRole="image" accessibilityLabel={`Loading ${preview} preview`} style={[shape, { backgroundColor: palette.soft, alignItems: 'center', justifyContent: 'center' }]}><Icon name={profile ? 'me' : 'bill'} size={24} color={palette.muted} /></View>;
}
