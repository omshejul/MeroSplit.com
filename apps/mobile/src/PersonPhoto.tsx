import React, { createContext, useContext, useEffect, useState } from 'react';
import { Image } from 'react-native';
import type { ProfilePhoto, Session } from './types';
import { cachedProfilePhoto } from './profilePhotoCache';

export const PhotoSession = createContext<Session | null>(null);
export default function PersonPhoto({ photo, size = 36, children }: { photo?: ProfilePhoto | null; size?: number; children: React.ReactNode }) {
  const session = useContext(PhotoSession), [loaded, setLoaded] = useState<{ scope: string; uri: string } | null>(null);
  const key = photo ? 'id' in photo ? photo.id : photo.url : '';
  const scope = `${session?.baseUrl}|${session?.userId}|${session?.token}|${key}`;
  const uri = loaded?.scope === scope ? loaded.uri : null;
  useEffect(() => {
    let active = true; setLoaded(null);
    if (session && photo) void cachedProfilePhoto(session, photo).then(value => { if (active) setLoaded({ scope, uri: value }); }).catch(() => {});
    return () => { active = false; };
  }, [scope]);
  return uri ? <Image accessible={false} source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} onError={() => setLoaded(null)} /> : <>{children}</>;
}
