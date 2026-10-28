import Avatar from './Avatar';
import React, { useState } from 'react';
import { Image, View, Text } from 'react-native';
import { browserMediaUrl } from './mediaPlatform.web';
import type { MediaMetadata } from './media';
import type { Session } from './types';
import PrivateMediaThumbnail from './PrivateMediaThumbnail';
import { radii, useUI } from './ui';
export default function PrivateMediaImage({ session, media, size = 56, profile = false }: { session: Session; media: MediaMetadata; size?: number; profile?: boolean }) {
  const { ui, palette } = useUI(), [failed, setFailed] = useState(false);
  const shape = { width: size, height: size, borderRadius: radii.control };
  if (media.content_type === 'application/pdf') return <PrivateMediaThumbnail session={session} media={media} size={size} profile={profile} />;
  if (profile) return <Avatar size={size} photo={media} backgroundColor={palette.soft} label="Your profile photo"><Text style={ui.caption}>Photo</Text></Avatar>;
  return failed ? <View accessibilityLabel="Photo preview unavailable" style={[shape, { backgroundColor: palette.soft }]}><Text style={ui.caption}>Photo</Text></View>
    : <Image key={`${session.userId}:${media.id}`} source={{ uri: `${browserMediaUrl(session, media.id)}` }} style={shape} resizeMode="cover" accessibilityLabel={profile ? 'Your profile photo' : media.name} onError={() => setFailed(true)} />;
}
