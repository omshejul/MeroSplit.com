import React from 'react';
import { Platform, View } from 'react-native';
import { Text } from 'react-native-paper';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo';
import KeyboardDialog from './KeyboardDialog';
import { Dialog, DialogScrollBody } from './DialogParts';
import type { AppUpdateState } from './useAppUpdates';
import LoadingSpinner from './LoadingSpinner';
import { Button, ErrorText, useUI } from './ui';

export default function AppUpdates({ update }: { update: AppUpdateState }) {
  const { ui } = useUI(), { native } = update;
  // Read the installed binary, never an OTA manifest's mutable version/build.
  const application = Platform.OS === 'web' ? null : requireOptionalNativeModule<{ nativeApplicationVersion?: string; nativeBuildVersion?: string }>('ExpoApplication');
  const version = application?.nativeApplicationVersion;
  const build = application?.nativeBuildVersion ?? (Platform.OS === 'ios' ? Constants.platform?.ios?.buildNumber : Constants.platform?.android?.versionCode);
  const versionLabel = version ? `Version ${version}${build != null ? ` (${build})` : ''}` : build != null ? `Build ${build}` : null;
  const installed = Platform.OS === 'web' ? 'Updates arrive when you reload the page.' : __DEV__ ? 'Development build'
    : native.currentlyRunning.isEmergencyLaunch ? 'Using the built-in version after an update problem.'
    : native.currentlyRunning.isEmbeddedLaunch ? 'Built-in version' : native.currentlyRunning.updateId ? 'Update installed' : 'Update status unavailable';
  return <View style={{ alignItems: 'center', paddingTop: 32, paddingBottom: 8, gap: 8 }}>
    {Platform.OS !== 'web' && versionLabel && <Text style={[ui.caption, { textAlign: 'center' }]}>{versionLabel}</Text>}
    <Text style={[ui.caption, { textAlign: 'center' }]}>{installed}</Text>
    {update.supported && <Button title={update.label} maxFontSizeMultiplier={2} disabled={update.disabled} accessibilityLiveRegion="polite" accessibilityState={{ busy: update.working }}
      style={{ marginTop: 8, minWidth: 200, minHeight: 44 }} labelStyle={{ fontVariant: ['tabular-nums'] }}
      icon={update.working ? ({ color }) => <View style={{ width: 20, height: 20 }}><LoadingSpinner visible color={color} label={update.label} /></View> : update.none ? 'check' : 'refresh'} onPress={update.check} />}
    {!!update.error && <ErrorText live>{update.error}</ErrorText>}
    {Platform.OS !== 'web' && !update.supported && <Text style={[ui.caption, { textAlign: 'center' }]}>Updates aren't available in this build.</Text>}
  </View>;
}

export function AppUpdatePrompt({ update }: { update: AppUpdateState }) {
  const { ui } = useUI();
  return <KeyboardDialog visible={update.promptVisible} label="Restart to update" placement="bottom" onDismiss={update.later} dismissable={!update.applying} blocksAppRestart={false}>
    <Dialog.Title icon="refresh">Restart to update</Dialog.Title>
    <DialogScrollBody gap={8}><Text style={ui.body}>MeroSplit will reopen with the update.</Text><Text style={ui.caption}>You can also restart from Me.</Text>{!!update.error && <ErrorText live>{update.error}</ErrorText>}</DialogScrollBody>
    <Dialog.Actions style={{ flexWrap: 'wrap' }}><Button title="Later" icon="history" kind="text" disabled={update.applying} onPress={update.later} />
      <Button title={update.applying ? 'Restarting…' : 'Restart now'} icon="refresh" kind="primary" disabled={update.applying} onPress={update.restart} /></Dialog.Actions>
  </KeyboardDialog>;
}
