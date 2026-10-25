import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useUI } from './ui';
import GoogleBrandButton from './GoogleBrandButton';
import type { GoogleButtonProps } from './GoogleSignInButton';

// GIS runs in its own top-level page, leaving the SQLite shell's COOP/COEP intact.
export default function GoogleSignInButton({ baseUrl, process, current, busy, onAuthenticate }: GoogleButtonProps) {
  const { ui } = useUI();
  return <View style={{ gap: 8 }}>
    {process === 'connect' && <Text style={ui.caption}>Connect Google to {current?.email}.</Text>}
    <GoogleBrandButton disabled={busy} onPress={() => onAuthenticate(async stillCurrent => {
      if (new URL(baseUrl, window.location.origin).origin !== window.location.origin) throw new Error('Open MeroSplit from its account server to sign in.');
      if (stillCurrent()) window.location.assign(`/auth/google?process=${process}${current ? `&account=${encodeURIComponent(current.userId)}` : ''}`);
      return null;
    })} />
  </View>;
}
