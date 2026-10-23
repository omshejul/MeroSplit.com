import React, { useState } from 'react';
import { Image, Pressable, Text } from 'react-native';
import { browserMediaUrl } from './mediaPlatform.web';
import type { MediaMetadata } from './media';
import type { Session } from './types';
import { radii, useUI } from './ui';
export default function PrivateMediaImage({ session, media, size = 56, profile = false }: { session: Session; media: MediaMetadata; size?: number; profile?: boolean }) {
  const { ui, palette } = useUI(), [attempt, setAttempt] = useState(0), [failed, setFailed] = useState(false);
  const shape = { width: size, height: size, borderRadius: profile ? size / 2 : radii.control };
  return failed ? <Pressable accessibilityRole="button" accessibilityLabel="Retry photo preview" onPress={() => { setFailed(false); setAttempt(value => value + 1); }} style={[shape, { backgroundColor: palette.soft }]}><Text style={ui.caption}>Retry</Text></Pressable>
    : <Image key={`${session.userId}:${media.id}:${attempt}`} source={{ uri: `${browserMediaUrl(session, media.id)}?v=${attempt}` }} style={shape} resizeMode="cover" accessibilityLabel={profile ? 'Your profile photo' : media.name} onError={() => setFailed(true)} />;
}
