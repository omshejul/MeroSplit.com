import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { finishGoogle, prepareGoogle } from './googleSignIn';
import type { GoogleButtonProps } from './GoogleSignInButton';
import { useUI } from './ui';

export default function AppleSignInButton({ baseUrl, process, current, busy, onAuthenticate }: GoogleButtonProps) {
  const { dark } = useUI();
  const [available, setAvailable] = useState(false);
  useEffect(() => { let active = true; void AppleAuthentication.isAvailableAsync().then(value => { if (active) setAvailable(value); }).catch(() => {}); return () => { active = false; }; }, []);
  if (!available) return null;
  return <View style={{ opacity: busy ? 0.5 : 1 }} pointerEvents={busy ? 'none' : 'auto'}>
    <AppleAuthentication.AppleAuthenticationButton buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
      buttonStyle={dark ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
      cornerRadius={8} style={{ width: 312, height: 48 }} onPress={() => { if (busy) return; onAuthenticate(async stillCurrent => {
        const attempt = await prepareGoogle(baseUrl, process, 'app', current, 'apple');
        if (!stillCurrent()) return null;
        let result;
        try {
          result = await AppleAuthentication.signInAsync({ requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL], nonce: attempt.nonce, state: attempt.state });
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_REQUEST_CANCELED') return null;
          throw new Error('Apple sign-in is unavailable. Try again or use email.');
        }
        if (!result.identityToken || !result.authorizationCode || result.state !== attempt.state) throw new Error('Could not confirm Apple sign-in. Try again.');
        return finishGoogle(attempt, result.identityToken, current, stillCurrent, { authorization_code: result.authorizationCode, state: result.state,
          ...(result.fullName?.givenName ? { given_name: result.fullName.givenName.slice(0, 150) } : {}),
          ...(result.fullName?.familyName ? { family_name: result.fullName.familyName.slice(0, 150) } : {}) });
      }); }} />
  </View>;
}
