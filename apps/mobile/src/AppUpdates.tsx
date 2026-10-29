import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Text } from 'react-native-paper';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo';
import LoadingSpinner from './LoadingSpinner';
import { Button, ErrorText, useUI } from './ui';

type Phase = 'idle' | 'checking' | 'none' | 'downloading' | 'applying';
export default function AppUpdates({ busy, online, onRestart }: { busy: boolean; online: boolean; onRestart: (reload: () => Promise<void>) => Promise<void> }) {
  const { ui } = useUI(), native = Updates.useUpdates();
  const [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState('');
  const flight = useRef(false), live = useRef(true), downloaded = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (phase !== 'none') return;
    const timer = setTimeout(() => setPhase(current => current === 'none' ? 'idle' : current), 3000);
    return () => clearTimeout(timer);
  }, [phase]);
  const supported = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled && !!Updates.runtimeVersion && Updates.channel === 'merosplit-production';
  const checking = phase === 'checking' || native.isChecking || native.isStartupProcedureRunning;
  const downloading = phase === 'downloading' || native.isDownloading;
  const applying = phase === 'applying' || native.isRestarting;
  const working = checking || downloading || applying;
  const progress = native.downloadProgress;
  const percent = native.isDownloading && typeof progress === 'number' && Number.isFinite(progress) ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : null;
  const label = applying ? 'Restarting…' : downloading ? percent === null ? 'Downloading…' : `Downloading ${percent}%`
    : checking ? 'Checking…' : phase === 'none' ? 'No new updates' : downloaded.current || native.isUpdatePending ? 'Restart to update' : 'Check for update';
  // Read the installed binary, never an OTA manifest's mutable version/build.
  const application = Platform.OS === 'web' ? null : requireOptionalNativeModule<{ nativeApplicationVersion?: string; nativeBuildVersion?: string }>('ExpoApplication');
  const version = application?.nativeApplicationVersion;
  const build = application?.nativeBuildVersion ?? (Platform.OS === 'ios' ? Constants.platform?.ios?.buildNumber : Constants.platform?.android?.versionCode);
  const versionLabel = version ? `Version ${version}${build != null ? ` (${build})` : ''}` : build != null ? `Build ${build}` : null;
  const installed = Platform.OS === 'web' ? 'Updates arrive when you reload the page.' : __DEV__ ? 'Development build'
    : native.currentlyRunning.isEmergencyLaunch ? 'Using the built-in version after an update problem.'
    : native.currentlyRunning.isEmbeddedLaunch ? 'Built-in version' : native.currentlyRunning.updateId ? 'Update installed' : 'Update status unavailable';
  async function act() {
    if (!supported || busy || working || flight.current) return;
    flight.current = true; setError('');
    let stage: 'checking' | 'downloading' | 'applying' = 'checking', restarting = false;
    try {
      if (!downloaded.current && !native.isUpdatePending) {
        if (!online) { setError('Connect to the internet and try again.'); return; }
        if (!native.isUpdateAvailable) {
          setPhase('checking');
          const result = await Updates.checkForUpdateAsync();
          if (!live.current) return;
          if (!result.isAvailable && !result.isRollBackToEmbedded) { setPhase('none'); return; }
        }
        stage = 'downloading'; setPhase('downloading');
        const result = await Updates.fetchUpdateAsync();
        if (!live.current) return;
        if (!result.isNew && !result.isRollBackToEmbedded) { setPhase('none'); return; }
        downloaded.current = true;
      }
      if (!live.current) return;
      stage = 'applying'; setPhase('applying'); restarting = true;
      await onRestart(Updates.reloadAsync);
    } catch (cause) {
      restarting = false;
      if (live.current) {
        setPhase('idle');
        setError(stage === 'applying' ? cause instanceof Error ? cause.message : 'Could not restart. Try again.'
          : stage === 'downloading' ? 'Download failed. Try again.' : "Couldn't check for updates. Try again.");
      }
    } finally { if (!restarting) flight.current = false; }
  }
  return <View style={{ alignItems: 'center', paddingTop: 32, paddingBottom: 8, gap: 8 }}>
    {Platform.OS !== 'web' && versionLabel && <Text style={[ui.caption, { textAlign: 'center' }]}>{versionLabel}</Text>}
    <Text style={[ui.caption, { textAlign: 'center' }]}>{installed}</Text>
    {supported && <Button title={label} maxFontSizeMultiplier={2} disabled={busy || working} accessibilityLiveRegion="polite" accessibilityState={{ busy: working }}
      style={{ marginTop: 8, minWidth: 200, minHeight: 44 }} labelStyle={{ fontVariant: ['tabular-nums'] }}
      icon={working ? ({ color }) => <View style={{ width: 20, height: 20 }}><LoadingSpinner visible color={color} label={label} /></View> : phase === 'none' ? 'check' : 'refresh'} onPress={() => void act()} />}
    {!!error && <ErrorText live>{error}</ErrorText>}
    {Platform.OS !== 'web' && !supported && <Text style={[ui.caption, { textAlign: 'center' }]}>Updates aren't available in this build.</Text>}
  </View>;
}
