import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo';
import { Linking, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { appStores, checkStoreUpdate } from './storeUpdate';
import { hasOpenDialogs, subscribeDialogs } from './DialogFocus';

type Phase = 'idle' | 'checking' | 'none' | 'downloading' | 'applying';
type Options = { baseUrl: string; enabled: boolean; online: boolean; foreground: boolean; safe: boolean; busy: boolean; onRestart: (reload: () => Promise<void>) => Promise<void> };
const CHECK_INTERVAL = 5 * 60 * 1000;

export default function useAppUpdates(options: Options) {
  const native = Updates.useUpdates();
  const application = Platform.OS === 'web' ? null : requireOptionalNativeModule<{ nativeBuildVersion?: string }>('ExpoApplication');
  const build = application?.nativeBuildVersion ?? (Platform.OS === 'ios' ? Constants.platform?.ios?.buildNumber : Constants.platform?.android?.versionCode)?.toString();
  const store = Platform.OS === 'ios' ? appStores.ios : appStores.android;
  const supported = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled && !!Updates.runtimeVersion && Updates.channel === 'merosplit-production';
  const [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState('');
  const [storeAvailable, setStoreAvailable] = useState(false);
  const [downloaded, setDownloaded] = useState<string | null>(null), [dismissed, setDismissed] = useState<string | null>(null);
  const flight = useRef(false), live = useRef(true), lastAttempt = useRef(0);
  const current = useRef({ ...options, native, supported, downloaded, storeAvailable, build }); current.current = { ...options, native, supported, downloaded, storeAvailable, build };
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
    : checking ? 'Checking…' : storeAvailable ? `Update in ${store.name}` : pending ? 'Restart to update' : phase === 'none' ? 'No new updates' : 'Check for update';

  async function check(manual = false) {
    const state = current.current;
    if (!live.current || !state.supported || !state.enabled || !state.foreground || flight.current || state.native.isChecking || state.native.isDownloading || state.native.isStartupProcedureRunning || state.native.isRestarting || manual && state.busy) return;
    if (!manual && (state.storeAvailable || state.native.isUpdatePending || state.downloaded)) return;
    if (manual && !state.storeAvailable && !state.online && (state.native.isUpdatePending || state.downloaded)) { setError(''); setDismissed(null); return; }
    if (!state.online) { if (manual) setError('Connect to the internet and try again.'); return; }
    const now = Date.now(), nativeCheck = state.native.lastCheckForUpdateTimeSinceRestart?.getTime() ?? 0;
    const recent = Math.max(lastAttempt.current, state.native.isUpdateAvailable ? 0 : nativeCheck);
    if (!manual && recent > 0 && now >= recent && now - recent < CHECK_INTERVAL) return;
    flight.current = true; lastAttempt.current = now; setError('');
    let stage = 'checking', storeCheckFailed = false;
    try {
      if (manual) {
        setPhase('checking');
        let available = state.storeAvailable;
        if (!available) {
          try { available = await checkStoreUpdate(state.baseUrl, Platform.OS, state.build); }
          catch { storeCheckFailed = true; }
        }
        if (!live.current) return;
        if (!current.current.enabled || !current.current.foreground || !current.current.online || current.current.baseUrl !== state.baseUrl) { setPhase('idle'); return; }
        if (available) {
          setStoreAvailable(true); stage = 'store';
          try { await Linking.openURL(store.native); } catch { await Linking.openURL(store.web); }
          if (live.current) setPhase('idle');
          return;
        }
        if (state.native.isUpdatePending || state.downloaded) { setDismissed(null); setPhase('idle'); return; }
      }

      if (!state.native.isUpdateAvailable) {
        setPhase('checking');
        const result = await Updates.checkForUpdateAsync();
        if (!live.current) return;
        if (!result.isAvailable && !result.isRollBackToEmbedded) { if (storeCheckFailed) throw new Error('Release check failed.'); setPhase(manual ? 'none' : 'idle'); return; }
      }
      if (!current.current.enabled || !current.current.foreground || !current.current.online) { lastAttempt.current = 0; setPhase('idle'); return; }
      stage = 'downloading'; setPhase('downloading');
      const result = await Updates.fetchUpdateAsync();
      if (!live.current) return;
      if (result.isNew || result.isRollBackToEmbedded) setDownloaded(result.isNew ? result.manifest.id : 'rollback');
      if (storeCheckFailed && !result.isNew && !result.isRollBackToEmbedded) { stage = 'checking'; throw new Error('Release check failed.'); }
      setPhase(manual && !result.isNew && !result.isRollBackToEmbedded ? 'none' : 'idle');
    } catch {
      if (live.current) { setPhase('idle'); if (manual) setError(stage === 'store' ? "Couldn't open the store. Try again." : stage === 'downloading' ? 'Download failed. Try again.' : "Couldn't check for updates. Try again."); }
    } finally { flight.current = false; }
  }

  useEffect(() => { void check(); }, [options.enabled, options.foreground, options.online, native.isStartupProcedureRunning, native.isChecking, native.isDownloading, native.isUpdateAvailable, native.isUpdatePending]);

  async function restart() {
    const state = current.current;
    if (!live.current || !pending || state.storeAvailable || flight.current || !state.supported || !state.enabled || !state.foreground || !state.safe || state.busy || hasOpenDialogs()) return;
    flight.current = true; setError(''); setPhase('applying');
    try { await state.onRestart(Updates.reloadAsync); }
    catch (cause) {
      if (live.current) { setPhase('idle'); setError(cause instanceof Error ? cause.message : 'Could not restart. Try again.'); }
      flight.current = false;
    }
  }
  return { native, supported, working, storeAvailable, applying, label, error, none: phase === 'none',
    disabled: options.busy || !options.enabled || working,
    promptVisible: !!(supported && options.enabled && options.foreground && options.safe && !options.busy && !dialogsOpen && !storeAvailable && pending && dismissed !== pending && !checking && !downloading),
    check: () => void check(true), engage: () => void check(), restart: () => void restart(),
    later: () => { if (!flight.current) { setDismissed(pending); setError(''); } },
  };
}
export type AppUpdateState = ReturnType<typeof useAppUpdates>;
