import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { hasOpenDialogs, subscribeDialogs } from './DialogFocus';

type Phase = 'idle' | 'checking' | 'none' | 'downloading' | 'applying';
type Options = { enabled: boolean; online: boolean; foreground: boolean; safe: boolean; busy: boolean; onRestart: (reload: () => Promise<void>) => Promise<void> };
const CHECK_INTERVAL = 5 * 60 * 1000;

export default function useAppUpdates(options: Options) {
  const native = Updates.useUpdates();
  const supported = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled && !!Updates.runtimeVersion && Updates.channel === 'merosplit-production';
  const [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState<string | null>(null), [dismissed, setDismissed] = useState<string | null>(null);
  const flight = useRef(false), live = useRef(true), lastAttempt = useRef(0);
  const current = useRef({ ...options, native, supported, downloaded }); current.current = { ...options, native, supported, downloaded };
  const dialogsOpen = useSyncExternalStore(subscribeDialogs, hasOpenDialogs, () => false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (phase !== 'none') return;
    const timer = setTimeout(() => setPhase(value => value === 'none' ? 'idle' : value), 3000);
    return () => clearTimeout(timer);
  }, [phase]);
  const pending = native.isUpdatePending ? native.downloadedUpdate?.updateId ?? downloaded ?? 'rollback' : downloaded;
  const checking = phase === 'checking' || native.isChecking || native.isStartupProcedureRunning;
  const downloading = phase === 'downloading' || native.isDownloading;
  const applying = phase === 'applying' || native.isRestarting;
  const working = !!(checking || downloading || applying);
  const progress = native.downloadProgress;
  const percent = native.isDownloading && typeof progress === 'number' && Number.isFinite(progress) ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : null;
  const label = applying ? 'Restarting…' : downloading ? percent === null ? 'Downloading…' : `Downloading ${percent}%`
    : checking ? 'Checking…' : pending ? 'Restart to update' : phase === 'none' ? 'No new updates' : 'Check for update';

  async function check(manual = false) {
    const state = current.current;
    if (!live.current || !state.supported || !state.enabled || !state.foreground || flight.current || state.native.isChecking || state.native.isDownloading || state.native.isStartupProcedureRunning || state.native.isRestarting || manual && state.busy) return;
    if (state.native.isUpdatePending || state.downloaded) { if (manual) { setError(''); setDismissed(null); } return; }
    if (!state.online) { if (manual) setError('Connect to the internet and try again.'); return; }
    const now = Date.now(), nativeCheck = state.native.lastCheckForUpdateTimeSinceRestart?.getTime() ?? 0;
    const recent = Math.max(lastAttempt.current, state.native.isUpdateAvailable ? 0 : nativeCheck);
    if (!manual && recent > 0 && now >= recent && now - recent < CHECK_INTERVAL) return;
    flight.current = true; lastAttempt.current = now; setError('');
    let stage = 'checking';
    try {
      if (!state.native.isUpdateAvailable) {
        setPhase('checking');
        const result = await Updates.checkForUpdateAsync();
        if (!live.current) return;
        if (!result.isAvailable && !result.isRollBackToEmbedded) { setPhase(manual ? 'none' : 'idle'); return; }
      }
      if (!current.current.enabled || !current.current.foreground || !current.current.online) { lastAttempt.current = 0; setPhase('idle'); return; }
      stage = 'downloading'; setPhase('downloading');
      const result = await Updates.fetchUpdateAsync();
      if (!live.current) return;
      if (result.isNew || result.isRollBackToEmbedded) setDownloaded(result.isNew ? result.manifest.id : 'rollback');
      setPhase(manual && !result.isNew && !result.isRollBackToEmbedded ? 'none' : 'idle');
    } catch {
      if (live.current) { setPhase('idle'); if (manual) setError(stage === 'downloading' ? 'Download failed. Try again.' : "Couldn't check for updates. Try again."); }
    } finally { flight.current = false; }
  }

  useEffect(() => { void check(); }, [options.enabled, options.foreground, options.online, native.isStartupProcedureRunning, native.isChecking, native.isDownloading, native.isUpdateAvailable, native.isUpdatePending]);

  async function restart() {
    const state = current.current;
    if (!live.current || !pending || flight.current || !state.supported || !state.enabled || !state.foreground || !state.safe || state.busy || hasOpenDialogs()) return;
    flight.current = true; setError(''); setPhase('applying');
    try { await state.onRestart(Updates.reloadAsync); }
    catch (cause) {
      if (live.current) { setPhase('idle'); setError(cause instanceof Error ? cause.message : 'Could not restart. Try again.'); }
      flight.current = false;
    }
  }
  return { native, supported, working, applying, label, error, none: phase === 'none',
    disabled: options.busy || !options.enabled || working,
    promptVisible: !!(supported && options.enabled && options.foreground && options.safe && !options.busy && !dialogsOpen && pending && dismissed !== pending && !checking && !downloading),
    check: () => void check(true), engage: () => void check(), restart: () => void restart(),
    later: () => { if (!flight.current) { setDismissed(pending); setError(''); } },
  };
}
export type AppUpdateState = ReturnType<typeof useAppUpdates>;
