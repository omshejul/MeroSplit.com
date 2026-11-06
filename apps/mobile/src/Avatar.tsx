import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Image, View, type ImageSourcePropType } from 'react-native';
import type { ProfilePhoto, Session } from './types';
import { cachedProfilePhoto, peekProfilePhoto, invalidateProfilePhoto } from './profilePhotoCache';

export const PhotoSession = createContext<Session | null>(null);
export const avatarShape = (size: number) => ({ width: size, height: size, borderRadius: size / 3 });
export default function Avatar({ photo, source, size = 36, children, backgroundColor = 'transparent', label, onError }: { photo?: ProfilePhoto | null; source?: ImageSourcePropType; size?: number; children: React.ReactNode; backgroundColor?: string; label?: string; onError?: () => void }) {
  const session = useContext(PhotoSession), [loaded, setLoaded] = useState<{ scope: string; uri: string } | null>(null);
  const [failedSource, setFailedSource] = useState('');
  const failedPhoto = useRef('');
  const [retry, setRetry] = useState(0);
  const sourceKey = source ? JSON.stringify(source) : '';
  const key = photo ? 'id' in photo ? photo.id : photo.url : '';
  const scope = `${session?.baseUrl}|${session?.userId}|${session?.token}|${key}`;
  const uri = loaded?.scope === scope ? loaded.uri : session && photo ? peekProfilePhoto(session, photo) : null;
  useEffect(() => {
    let active = true;
    if (session && photo) void cachedProfilePhoto(session, photo).then(value => { if (active) setLoaded({ scope, uri: value }); }).catch(() => {});
    return () => { active = false; };
  }, [scope, retry]);
  const image = source && failedSource !== sourceKey ? source : uri ? { uri } : null;
  return <View accessible={!!label} accessibilityRole={label ? 'image' : undefined} accessibilityLabel={label}
    style={{ ...avatarShape(size), backgroundColor, overflow: 'hidden', flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
    {image ? <Image accessible={false} source={image} resizeMode="cover" style={{ width: size, height: size }} onError={() => {
      setLoaded(null);
      if (source && failedSource !== sourceKey) setFailedSource(sourceKey);
      else if (session && photo) {
        const retryAllowed = failedPhoto.current !== scope; failedPhoto.current = scope;
        void invalidateProfilePhoto(session, photo).then(() => { if (retryAllowed) setRetry(value => value + 1); }).catch(() => {});
      }
      onError?.();
    }} /> : children}
  </View>;
}
