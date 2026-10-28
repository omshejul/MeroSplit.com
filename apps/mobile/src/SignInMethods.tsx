import { ErrorState } from './UIStates';
import React from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import AppleSignInButton from './AppleSignInButton';
import GoogleSignInButton from './GoogleSignInButton';
import type { GoogleAuthenticate } from './googleSignIn';
import type { Session } from './types';
import type { ProviderConnections } from './useLinkedProviders';
import { Button, Icon, useUI } from './ui';

function ConnectedProviderRow({ name, leading }: { name: string; leading: React.ReactNode }) {
  const { ui, palette } = useUI();
  return <View style={{ minHeight: 56, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line }}>{leading}<Text style={[ui.body, { flexGrow: 1 }]}>{name}</Text><Text style={ui.caption}>Connected</Text><Icon name="check" size={20} /></View>;
}
export default function SignInMethods({ session, busy, connections, onGoogle, onApple }: {
  session: Session; busy: boolean; connections: ProviderConnections;
  onGoogle: (authenticate: GoogleAuthenticate) => void; onApple: (authenticate: GoogleAuthenticate) => void;
}) {
  const { palette, ui, dark } = useUI();
  const row = { minHeight: 56, paddingVertical: 14, flexDirection: 'row' as const, alignItems: 'center' as const,
    flexWrap: 'wrap' as const, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line };
  const linked = connections.status === 'ready' ? connections.connected : null;
  return <View style={{ gap: 20 }}>
    <View style={row}>
      <Icon name="mail" /><Text style={ui.body}>Email</Text>
      <Text selectable style={[ui.caption, { flexBasis: 180, flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: '100%', textAlign: 'right' }]}>{session.email}</Text>
    </View>
    {!linked ? <View style={{ gap: 12 }}>
      <Text accessibilityLiveRegion="polite" accessibilityRole={connections.status === 'error' ? 'alert' : undefined} style={ui.caption}>
        {connections.status === 'loading' ? 'Checking sign-in methods…' : connections.status === 'error' ? 'Could not check sign-in methods. Try again when you’re online.' : 'Connect to the internet to check sign-in methods.'}
      </Text>
      {connections.status !== 'loading' && <Button title="Try again" kind="text" disabled={busy} onPress={connections.refresh} />}
    </View> : <>
      {linked.google ? <ConnectedProviderRow name="Google" leading={<Image accessible={false} importantForAccessibility="no" source={dark ? require('../assets/oauth/google-g-dark.png') : require('../assets/oauth/google-g-light.png')} resizeMode="contain" style={{ width: 22, height: 22 }} />} /> : <View style={{ gap: 12 }}>
        <Text style={ui.caption}>Add Google as another way to sign in.</Text>
        <GoogleSignInButton baseUrl={session.baseUrl} process="connect" current={session} busy={busy} onAuthenticate={onGoogle} />
      </View>}
      {linked.apple ? <ConnectedProviderRow name="Apple" leading={<Icon name="key" />} /> : Platform.OS === 'ios' && <AppleSignInButton baseUrl={session.baseUrl} process="connect" current={session} busy={busy} onAuthenticate={onApple} />}
    </>}
  </View>;
}
