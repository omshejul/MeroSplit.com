import React, { useEffect, useRef, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { freshMediaUrl } from './media';
import type { MediaMetadata } from './media';
import type { Session } from './types';
import { Icon, radii, useUI } from './ui';

export default function PrivateMediaImage({ session, media, size = 56, profile = false }: { session: Session; media: MediaMetadata; size?: number; profile?: boolean }) {
  const { palette, ui } = useUI(), [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false);
  const generation = useRef(0), retried = useRef(false);
  useEffect(() => {
    const current = ++generation.current; retried.current = false; setUrl(null); setFailed(false);
    void freshMediaUrl(session, media.id).then(value => { if (generation.current === current) setUrl(value); }).catch(() => { if (generation.current === current) setFailed(true); });
    return () => { generation.current++; };
  }, [session.baseUrl, session.userId, session.token, media.id]);
  function retry() {
    if (retried.current) { setUrl(null); setFailed(true); return; }
    const current = generation.current; retried.current = true; setUrl(null);
    void freshMediaUrl(session, media.id).then(value => { if (generation.current === current) setUrl(value); }).catch(() => { if (generation.current === current) setFailed(true); });
  }
  const shape = { width: size, height: size, borderRadius: profile ? size / 2 : radii.control };
  if (failed) return <Pressable accessibilityRole="button" accessibilityLabel="Retry photo preview" onPress={() => { retried.current = false; setFailed(false); retry(); }} style={[shape, { backgroundColor: palette.soft, alignItems: 'center', justifyContent: 'center' }]}><Text style={ui.caption}>Retry</Text></Pressable>;
  return url ? <Image source={{ uri: url }} style={shape} resizeMode="cover" accessibilityLabel={profile ? 'Your profile photo' : media.name} onError={retry} />
    : <View accessible accessibilityRole="image" accessibilityLabel="Loading photo preview" style={[shape, { backgroundColor: palette.soft, alignItems: 'center', justifyContent: 'center' }]}><Icon name={profile ? 'me' : 'bill'} size={24} color={palette.muted} /></View>;
}
