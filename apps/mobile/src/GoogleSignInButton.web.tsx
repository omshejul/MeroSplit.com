import React from 'react';
import { View } from 'react-native';
import GoogleBrandButton from './GoogleBrandButton';
import type { GoogleButtonProps } from './GoogleSignInButton';

// A CSRF-protected top-level code redirect leaves SQLite isolation unchanged.
export default function GoogleSignInButton({ baseUrl, process, current, busy, onAuthenticate }: GoogleButtonProps) {
  return <View style={{ gap: 8 }}>
    <GoogleBrandButton disabled={busy} onPress={() => onAuthenticate(async stillCurrent => {
      if (new URL(baseUrl, window.location.origin).origin !== window.location.origin) throw new Error('Open MeroSplit from its account server to sign in.');
      const csrf = decodeURIComponent(document.cookie.split('; ').find(value => value.startsWith('csrftoken='))?.slice(10) ?? '');
      if (!csrf) throw new Error('Could not prepare Google sign-in. Reload MeroSplit and try again.');
      if (!stillCurrent()) return null;
      const form = document.createElement('form'); form.method = 'POST'; form.action = '/auth/google'; form.hidden = true;
      for (const [name, value] of Object.entries({ process, csrfmiddlewaretoken: csrf, ...(current ? { account: current.userId } : {}) })) {
        const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.appendChild(input);
      }
      document.body.appendChild(form);
      try { form.submit(); } finally { form.remove(); }
      return null;
    })} />
  </View>;
}
