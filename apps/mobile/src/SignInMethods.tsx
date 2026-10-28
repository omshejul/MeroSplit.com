import React from 'react';
import { Image, Platform, View } from 'react-native';
import { Text } from 'react-native-paper';
import AppleSignInButton from './AppleSignInButton';
import GoogleSignInButton from './GoogleSignInButton';
import type { GoogleAuthenticate } from './googleSignIn';
import type { Session } from './types';
import type { ProviderConnections } from './useLinkedProviders';
import type { ConnectedProvider } from './linkedProviders';
import { Alert } from './alerts';
import ListRow from './ListRow';
import RowGroup from './RowGroup';
import NotificationSwitch from './NotificationSwitch';
import { ErrorState } from './UIStates';
import { Button, Icon, useUI } from './ui';

function ConnectedProviderRow({ account, leading, disabled, onDisconnect }: { account: ConnectedProvider; leading: React.ReactNode; disabled: boolean; onDisconnect: () => void }) {
  const { ui } = useUI(), name = account.provider === 'google' ? 'Google' : 'Apple';
  return <ListRow leading={leading} style={{ minHeight: 72, paddingVertical: 14, flexWrap: 'wrap' }} bodyStyle={{ flexBasis: 160 }} trailing={
    <Button title="Disconnect" accessibilityLabel={`Disconnect ${name}: ${account.email || account.uid}`} kind="text" small disabled={disabled || !account.can_disconnect} onPress={onDisconnect} />}>
    <Text style={ui.body}>{name}</Text><Text selectable style={ui.caption}>{account.email || `${name} ID: ${account.uid}`}</Text>
    {account.email.endsWith('@privaterelay.appleid.com') && <Text style={ui.caption}>Apple private email</Text>}
    {!account.can_disconnect && <Text style={ui.caption}>Verify your email before disconnecting.</Text>}
  </ListRow>;
}
export default function SignInMethods({ session, busy, connections, onGoogle, onApple }: {
  session: Session; busy: boolean; connections: ProviderConnections;
  onGoogle: (authenticate: GoogleAuthenticate) => void; onApple: (authenticate: GoogleAuthenticate) => void;
}) {
  const { ui, dark } = useUI(), linked = connections.connected;
  const disabled = busy || connections.working || connections.status !== 'ready';
  function disconnect(account: ConnectedProvider) {
    const name = account.provider === 'google' ? 'Google' : 'Apple';
    Alert.alert(`Disconnect ${name}?`, `Remove ${account.email || account.uid} as a sign-in method. You can use your other sign-in methods.`, [
      { text: 'Cancel', style: 'cancel' }, { text: 'Disconnect', style: 'destructive', onPress: () => { void connections.disconnect(account.id); } },
    ]);
  }
  return <View style={{ gap: 20 }}>
    {linked && <NotificationSwitch icon="key" label="Auto-link accounts" description="Link Google or Apple sign-ins that use the same verified email." checked={linked.autoLink} disabled={disabled} onChange={value => { void connections.setAutoLink(value); }} />}
    <RowGroup>
      <ListRow leading={<Icon name="mail" />}><Text style={ui.body}>Email</Text><Text selectable style={ui.caption}>{session.email}</Text></ListRow>
      {linked?.accounts.map(account => <ConnectedProviderRow key={account.id} account={account} disabled={disabled} onDisconnect={() => disconnect(account)} leading={account.provider === 'google'
        ? <Image accessible={false} importantForAccessibility="no" source={dark ? require('../assets/oauth/google-g-dark.png') : require('../assets/oauth/google-g-light.png')} resizeMode="contain" style={{ width: 22, height: 22 }} /> : <Icon name="key" />} />)}
    </RowGroup>
    {linked ? <>
      {!linked.google && <View style={{ gap: 12 }}><Text style={ui.caption}>Add Google as another way to sign in.</Text><GoogleSignInButton baseUrl={session.baseUrl} process="connect" current={session} busy={disabled} onAuthenticate={onGoogle} /></View>}
      {!linked.apple && Platform.OS === 'ios' && <AppleSignInButton baseUrl={session.baseUrl} process="connect" current={session} busy={disabled} onAuthenticate={onApple} />}
    </> : <Text accessibilityLiveRegion="polite" style={ui.caption}>{connections.status === 'loading' ? 'Checking sign-in methods…' : 'Connect to the internet to check sign-in methods.'}</Text>}
    {!!connections.error && <ErrorState error={connections.error} disabled={busy || connections.working} onRetry={connections.status === 'error' ? connections.refresh : undefined} />}
    {connections.status === 'unknown' && <Button title="Try again" kind="text" disabled={busy} onPress={connections.refresh} />}
  </View>;
}
