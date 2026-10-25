import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import * as Updates from 'expo-updates';
import KeyboardDialog from './KeyboardDialog';
import DialogFocus from './DialogFocus';
import { DialogScrollBody } from './DialogParts';
import LoadingSpinner from './LoadingSpinner';
import { Button, SettingsRow, useUI } from './ui';

type Phase = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'applying';
export default function AppUpdates({ busy, online, onRestart }: { busy: boolean; online: boolean; onRestart: (reload: () => Promise<void>) => Promise<void> }) {
  const { ui } = useUI(), native = Updates.useUpdates();
  const [open, setOpen] = useState(false), [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState(''), [rollback, setRollback] = useState(false);
  const flight = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const supported = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled && !!Updates.runtimeVersion && Updates.channel === 'merosplit-1-1-testing';
  const working = native.isStartupProcedureRunning || phase === 'checking' || phase === 'downloading' || phase === 'applying' || native.isChecking || native.isDownloading || native.isRestarting;
  const ready = native.isUpdatePending || phase === 'ready', available = phase === 'available' || phase === 'idle' && native.isUpdateAvailable;
  const restoring = rollback || native.downloadedUpdate?.type === Updates.UpdateInfoType.ROLLBACK || native.availableUpdate?.type === Updates.UpdateInfoType.ROLLBACK;
  const label = ready ? 'Restart' : available ? 'Download' : 'Check';
  const status = Platform.OS === 'web' ? 'Updates arrive when you reload the page.' : !supported ? "Updates aren't available in this build."
    : native.isStartupProcedureRunning ? 'Getting the app ready…' : phase === 'applying' || native.isRestarting ? 'Restarting…' : phase === 'checking' || native.isChecking ? 'Checking…'
    : phase === 'downloading' || native.isDownloading ? 'Downloading…'
    : ready ? restoring ? 'The built-in version is ready. Restart to use it.' : 'Update downloaded. Restart to apply.'
    : available ? restoring ? 'An update to the built-in version is available.' : 'An update is available.'
    : phase === 'none' ? 'No update is available for this build.'
    : native.currentlyRunning.isEmergencyLaunch ? 'Using the built-in version after an update problem.' : 'Not checked yet.';
  async function act() {
    if (!supported || busy || working || flight.current) return;
    flight.current = true; setError('');
    if (ready) {
      setPhase('applying');
      try { await onRestart(Updates.reloadAsync); }
      catch (cause) {
        flight.current = false;
        if (live.current) { setPhase('ready'); setError(cause instanceof Error ? cause.message : 'Could not restart. Try again.'); }
      }
      return;
    }
    if (!online) { flight.current = false; setError('Connect to the internet and try again.'); return; }
    setPhase(available ? 'downloading' : 'checking');
    try {
      if (available) {
        const result = await Updates.fetchUpdateAsync();
        if (live.current) {
          setRollback(result.isRollBackToEmbedded);
          setPhase(result.isNew || result.isRollBackToEmbedded ? 'ready' : 'none');
          if (!result.isNew && !result.isRollBackToEmbedded) setError('No update was downloaded. Check again.');
        }
      } else {
        const result = await Updates.checkForUpdateAsync();
        if (live.current) { setRollback(result.isRollBackToEmbedded); setPhase(result.isAvailable || result.isRollBackToEmbedded ? 'available' : 'none'); }
      }
    } catch {
      if (live.current) { setPhase(available ? 'available' : 'idle'); setError(available ? 'Download failed. Try again.' : "Couldn't check for updates. Try again."); }
    } finally { flight.current = false; }
  }
  function close() { if (!working) setOpen(false); }
  return <>
    <SettingsRow label="App updates" icon="refresh" value={supported && ready ? 'Ready' : undefined} disabled={busy} onPress={() => setOpen(true)} />
    <KeyboardDialog visible={open} dismissable={!working} onDismiss={close}>
      <DialogFocus active={open} busy={working} onEscape={close}>
        <Dialog.Title aria-level={2}>App updates</Dialog.Title>
        <DialogScrollBody maxHeight={240} gap={12}>
          <Text style={ui.body} accessibilityLiveRegion="polite">{status}</Text>
          {supported && (ready || available) && <Text style={ui.caption}>Downloaded updates may also apply the next time you open the app.</Text>}
          {!!error && <Text style={ui.error} accessibilityRole="alert">{error}</Text>}
        </DialogScrollBody>
        <Dialog.Actions><Button title="Close" kind="text" disabled={working} onPress={close} />
          {supported && <Button title={label} kind="primary" style={{ width: 132 }} disabled={busy || working}
            icon={({ color }) => <View style={{ width: 20, height: 20 }}><LoadingSpinner visible={working} color={color} label={status} /></View>} onPress={() => void act()} />}
        </Dialog.Actions>
      </DialogFocus>
    </KeyboardDialog>
  </>;
}
