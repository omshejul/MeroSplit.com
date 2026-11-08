import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo';
import { Linking, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { appStores, checkStoreUpdate } from './storeUpdate';
import { hasOpenDialogs, subscribeDialogs } from './DialogFocus';

type Phase = 'idle' | 'checking' | 'none' | 'downloading' | 'applying' | 'opening-store';
type Options = { baseUrl: string; enabled: boolean; online: boolean; foreground: boolean; safe: boolean; busy: boolean; onRestart: (reload: () => Promise<void>) => Promise<void> };
const CHECK_INTERVAL = 5 * 60 * 1000;

export default function useAppUpdates(options: Options) {
  const native = Updates.useUpdates();
  const application = Platform.OS === 'web' ? null : requireOptionalNativeModule<{ nativeBuildVersion?: string }>('ExpoApplication');
  const build = application?.nativeBuildVersion ?? (Platform.OS === 'ios' ? Constants.platform?.ios?.buildNumber : Constants.platform?.android?.versionCode)?.toString();
  const store = Platform.OS === 'ios' ? appStores.ios : appStores.android;
  const supported = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled && !!Updates.runtimeVersion && Updates.channel === 'merosplit-production';
  const [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState('');
  const [storeBuild, setStoreBuild] = useState<string | null>(null), [dismissedStore, setDismissedStore] = useState<string | null>(null);
  const storeAvailable = !!storeBuild;
  const [downloaded, setDownloaded] = useState<string | null>(null), [dismissed, setDismissed] = useState<string | null>(null);
  const flight = useRef(false), live = useRef(true), lastAttempt = useRef(0), lastStoreAttempt = useRef(0);
  const current = useRef({ ...options, native, supported, downloaded, storeBuild, build }); current.current = { ...options, native, supported, downloaded, storeBuild, build };
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
  const openingStore = phase === 'opening-store';
  const working = !!(checking || downloading || applying || openingStore);
  const progress = native.downloadProgress;
  const percent = native.isDownloading && typeof progress === 'number' && Number.isFinite(progress) ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : null;
  const label = applying ? 'Restarting…' : downloading ? percent === null ? 'Downloading…' : `Downloading ${percent}%`
    : checking ? 'Checking…' : openingStore ? 'Opening store…' : storeAvailable ? `Update in ${store.name}` : pending ? 'Restart to update' : phase === 'none' ? 'No new updates' : 'Check for update';

  async function check(manual = false) {
    const state = current.current;
    if (!live.current || !state.supported || !state.enabled || !state.foreground || flight.current || state.native.isChecking || state.native.isDownloading || state.native.isStartupProcedureRunning || state.native.isRestarting || manual && state.busy) return;
    const hasPending = state.native.isUpdatePending || state.downloaded;
    if (manual && !state.storeBuild && !state.online && hasPending) { setError(''); setDismissed(null); return; }
    if (!state.online) { if (manual) setError('Connect to the internet and try again.'); return; }
    const now = Date.now(), nativeCheck = state.native.lastCheckForUpdateTimeSinceRestart?.getTime() ?? 0;
    const recent = (attempt: number) => attempt > 0 && now >= attempt && now - attempt < CHECK_INTERVAL;
    const checkStore = manual || !recent(lastStoreAttempt.current);
    const checkOta = manual || (!hasPending && !recent(Math.max(lastAttempt.current, state.native.isUpdateAvailable ? 0 : nativeCheck)));
    if (!checkStore && (!checkOta || state.storeBuild)) return;
    flight.current = true; setError('');
    let stage = 'checking', storeCheckFailed = false, available = state.storeBuild;
    try {
      if (checkStore) {
        lastStoreAttempt.current = now;
        setPhase('checking');
        try { available = await checkStoreUpdate(state.baseUrl, Platform.OS, state.build); }
        catch { storeCheckFailed = true; }
        if (!live.current) return;
        if (!current.current.enabled || !current.current.foreground || !current.current.online || current.current.baseUrl !== state.baseUrl) {
          lastStoreAttempt.current = 0; setPhase('idle'); return;
        }
        setStoreBuild(available);
      }
      if (available || hasPending || !checkOta) {
        if (manual && available) setDismissedStore(null);
        if (manual && !available && hasPending) setDismissed(null);
        setPhase('idle');
        return;
      }
      lastAttempt.current = now;

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
      if (live.current) { setPhase('idle'); if (manual) setError(stage === 'downloading' ? 'Download failed. Try again.' : "Couldn't check for updates. Try again."); }
    } finally { flight.current = false; }
  }

  useEffect(() => { void check(); }, [options.enabled, options.foreground, options.online, native.isStartupProcedureRunning, native.isChecking, native.isDownloading, native.isUpdateAvailable, native.isUpdatePending]);

  async function restart() {
    const state = current.current;
    if (!live.current || !pending || state.storeBuild || flight.current || !state.supported || !state.enabled || !state.foreground || !state.safe || state.busy || hasOpenDialogs()) return;
    flight.current = true; setError(''); setPhase('applying');
    try { await state.onRestart(Updates.reloadAsync); }
    catch (cause) {
      if (live.current) { setPhase('idle'); setError(cause instanceof Error ? cause.message : 'Could not restart. Try again.'); }
      flight.current = false;
    }
  }
  async function openStore() {
    const state = current.current;
    if (!live.current || !state.storeBuild || !state.enabled || !state.foreground || !state.safe || state.busy || flight.current) return;
    flight.current = true; setError(''); setPhase('opening-store');
    try {
      try { await Linking.openURL(store.native); }
      catch { if (live.current && current.current.enabled && current.current.foreground) await Linking.openURL(store.web); }
      if (live.current) setDismissedStore(state.storeBuild);
    } catch {
      if (live.current) setError("Couldn't open the store. Try again.");
    } finally {
      if (live.current) setPhase('idle');
      flight.current = false;
    }
  }

  const promptReady = supported && options.enabled && options.foreground && options.safe && !options.busy && !dialogsOpen && !checking && !downloading;
  return { native, supported, working, storeAvailable, storeName: store.name, openingStore, applying, label, error, none: phase === 'none',
    disabled: options.busy || !options.enabled || working,
    promptVisible: !!(promptReady && (storeBuild ? dismissedStore !== storeBuild : pending && dismissed !== pending)),
    check: () => void check(true), engage: () => void check(), restart: () => void restart(), openStore: () => void openStore(),
    later: () => { if (!flight.current) { if (storeBuild) setDismissedStore(storeBuild); else setDismissed(pending); setError(''); } },
  };
}
export type AppUpdateState = ReturnType<typeof useAppUpdates>;
