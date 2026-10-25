import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { GoogleOneTapSignIn } from 'react-native-nitro-google-signin';
import { finishGoogle, prepareGoogle, GOOGLE_WEB_CLIENT_ID, GOOGLE_IOS_CLIENT_ID, type GoogleAuthenticate, type GoogleProcess } from './googleSignIn';
import GoogleBrandButton from './GoogleBrandButton';
import type { Session } from './types';
import { useUI } from './ui';

export type GoogleButtonProps = { baseUrl: string; process: GoogleProcess; current?: Session; busy: boolean; onAuthenticate: (authenticate: GoogleAuthenticate) => void };
export default function GoogleSignInButton({ baseUrl, process, current, busy, onAuthenticate }: GoogleButtonProps) {
  const { ui } = useUI();
  return <View style={{ gap: 8 }}>
    {process === 'connect' && <Text style={ui.caption}>Connect Google to {current?.email}.</Text>}
    <GoogleBrandButton disabled={busy} onPress={() => onAuthenticate(async stillCurrent => {
      const attempt = await prepareGoogle(baseUrl, process, 'app', current);
      if (!stillCurrent()) return null;
      let result;
      try {
        GoogleOneTapSignIn.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: GOOGLE_IOS_CLIENT_ID, nonce: attempt.nonce, offlineAccess: false, autoSelectOnSignIn: false });
        await GoogleOneTapSignIn.checkPlayServices(false);
        result = await GoogleOneTapSignIn.presentExplicitSignIn();
      } catch { throw new Error('Google sign-in is unavailable. Try again or use email.'); }
      if (result.type === 'cancelled') return null;
      if (result.type !== 'success' || !result.data?.idToken) throw new Error('Could not sign in with Google. Try again or use email.');
      return finishGoogle(attempt, result.data.idToken, current, stillCurrent);
    })} />
  </View>;
}
