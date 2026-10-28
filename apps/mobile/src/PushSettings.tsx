import { ErrorState } from './UIStates';

import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Text, View } from 'react-native';
import NotificationSwitch from './NotificationSwitch';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { accountOwner } from './api';
import { consentToPush, dismissReadPushes, emptyPushPreferences, notificationForAccount, notificationTarget, pushPermission, refreshPushDevice, unregisterPushDevice } from './notifications';
import type { PushPermission, PushPreferences, PushTarget } from './notifications';
import type { Session } from './types';
import { Button, useUI } from './ui';

const CHOICE_KEY = 'splitdumb.push', INSTALL_KEY = 'splitdumb.push.installation';
type Callbacks = { onOpen: (target: PushTarget | null) => Promise<void>; onForeground: () => Promise<void>; shouldSuppress?: (data: unknown) => boolean };
let suppressForeground = (_data: unknown) => true;
Notifications.setNotificationHandler({ handleNotification: async notification => { const show = !suppressForeground(notification.request.content.data); return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false }; } });

export function usePushNotifications(session: Session | null, callbacks: Callbacks) {
  const { currency } = useUI();
  const [preferences, setPreferences] = useState<PushPreferences | null>(null), [permission, setPermission] = useState<PushPermission>('ask');
  const [working, setWorking] = useState(false), [verified, setVerified] = useState(false), [error, setError] = useState('');
  const saved = useRef<PushPreferences | null>(null), activeSession = useRef(session), handlers = useRef(callbacks), mounted = useRef(true);
  activeSession.current = session; handlers.current = callbacks;
  suppressForeground = data => !notificationForAccount(activeSession.current, data) || !!handlers.current.shouldSuppress?.(data);
  const serial = useRef<Promise<unknown>>(Promise.resolve()), running = useRef(false), seen = useRef(new Set<string>()), previousOwner = useRef<string | null>(null);
  const owner = session ? accountOwner(session) : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(value: PushPreferences) {
    await SecureStore.setItemAsync(CHOICE_KEY, JSON.stringify(value)); saved.current = value;
    if (mounted.current) setPreferences(value);
  }
  async function state() {
    if (saved.current) return saved.current;
    let installation = await SecureStore.getItemAsync(INSTALL_KEY);
    if (!installation) { installation = Crypto.randomUUID(); await SecureStore.setItemAsync(INSTALL_KEY, installation); }
    const raw = await SecureStore.getItemAsync(CHOICE_KEY);
    let value: PushPreferences;
    try { value = raw ? JSON.parse(raw) as PushPreferences : emptyPushPreferences(installation); }
    catch { throw new Error('Could not restore notification settings. Sign out and sign in again.'); }
    if (value.installation_id !== installation) throw new Error('Could not restore notification settings. Sign out and sign in again.');
    saved.current = value; if (mounted.current) setPreferences(value); return value;
  }
  function run(action: () => Promise<void>) {
    const result = serial.current.catch(() => {}).then(async () => {
      running.current = true; if (mounted.current) { setWorking(true); setError(''); }
      try { await action(); }
      catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not update notifications. Try again when connected.'); throw cause; }
      finally { running.current = false; if (mounted.current) setWorking(false); }
    });
    serial.current = result; return result;
  }
  async function channel() {
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('shared-bills', { name: 'Shared bills', importance: Notifications.AndroidImportance.DEFAULT, lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE });
  }
  async function refreshNow(token?: Notifications.DevicePushToken) {
    try {
    const current = activeSession.current, value = await state();
    const status = pushPermission(await Notifications.getPermissionsAsync()); if (mounted.current) { setPermission(status); if (status !== 'granted') setVerified(false); }
    if (!current) return;
    await refreshPushDevice(current, value, status, async () => {
      await channel();
      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      if (typeof projectId !== 'string') throw new Error('Notifications are not configured yet.');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: Notifications.ExpoPushToken;
      try {
        result = await Promise.race([Notifications.getExpoPushTokenAsync({ projectId, ...(token ? { devicePushToken: token } : {}) }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Notification service timed out.')), 30_000); })]);
      } catch { throw new Error('Could not connect to notifications on this device. Check your connection and retry.'); }
      finally { if (timer) clearTimeout(timer); }
      if (activeSession.current?.token !== current.token || accountOwner(activeSession.current) !== accountOwner(current)) throw new Error('The signed-in account changed. Review notification settings again.');
      return { provider: 'expo', token: result.data, platform: Platform.OS === 'ios' ? 'ios' : 'android' };
    }, save);
    if (mounted.current && activeSession.current?.token === current.token && accountOwner(activeSession.current) === accountOwner(current)) setVerified(true);
    } catch (cause) { if (mounted.current) setVerified(false); throw cause; }
  }
  const refresh = () => run(() => refreshNow());
  async function clearReadPrompts() {
    const current = activeSession.current;
    if (!current || AppState.currentState !== 'active') return;
    const shown = await Notifications.getPresentedNotificationsAsync();
    if (activeSession.current?.token !== current.token || AppState.currentState !== 'active') return;
    await dismissReadPushes(current, shown.map(value => ({ identifier: value.request.identifier, data: value.request.content.data })), async id => {
      if (activeSession.current?.token === current.token && AppState.currentState === 'active') await Notifications.dismissNotificationAsync(id);
    });
  }
  const enable = async () => { const current = activeSession.current; let enabled = false; await run(async () => {
    if (!current || !activeSession.current || accountOwner(activeSession.current) !== accountOwner(current)) throw new Error('Sign in to enable notifications.');
    await consentToPush(current, await state(), save); await channel();
    let status = await Notifications.getPermissionsAsync();
    if (pushPermission(status) === 'ask') status = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } });
    if (activeSession.current?.token !== current.token || accountOwner(activeSession.current) !== accountOwner(current)) return;
    if (pushPermission(status) !== 'granted') { setPermission(pushPermission(status)); await unregisterPushDevice(current, await state(), save); return; }
    await refreshNow(); enabled = true;
  }); return enabled; };
  const disable = () => { const current = activeSession.current; return run(async () => {
    if (current) await unregisterPushDevice(current, await state(), save);
    if (mounted.current) setVerified(false);
  }); };
  const clear = () => run(async () => {
    const value = await state(); await save(emptyPushPreferences(value.installation_id));
    seen.current.clear(); Notifications.clearLastNotificationResponse(); await Notifications.dismissAllNotificationsAsync();
    if (mounted.current) setVerified(false);
  });
  async function open(response: Notifications.NotificationResponse | null) {
    if (!response) return;
    const current = activeSession.current; if (!current) return;
    const data = response.notification.request.content.data;
    if (!notificationForAccount(current, data)) { Notifications.clearLastNotificationResponse(); return; }
    const event = typeof data.event_id === 'string' ? data.event_id : response.notification.request.identifier;
    if (seen.current.has(event)) return;
    seen.current.add(event); if (seen.current.size > 20) seen.current.delete(seen.current.values().next().value!);
    Notifications.clearLastNotificationResponse();
    const target = await notificationTarget(current, data);
    if (activeSession.current?.token === current.token && accountOwner(activeSession.current) === accountOwner(current)) await handlers.current.onOpen(target);
  }
  useEffect(() => {
    const changed = previousOwner.current !== null && previousOwner.current !== owner; previousOwner.current = owner;
    if (changed) { seen.current.clear(); Notifications.clearLastNotificationResponse(); void Notifications.dismissAllNotificationsAsync().catch(() => {}); }
    void refresh().catch(() => {});
    void clearReadPrompts().catch(() => {});
    if (session) void open(Notifications.getLastNotificationResponse()).catch(() => {});
  }, [owner, session?.token, currency]);
  useEffect(() => {
    const foreground = AppState.addEventListener('change', value => { if (value === 'active') { if (!running.current) void refresh().catch(() => {}); void clearReadPrompts().catch(() => {}); } });
    const rotated = Notifications.addPushTokenListener(token => { if (!running.current) void run(() => refreshNow(token)).catch(() => {}); });
    const received = Notifications.addNotificationReceivedListener(notification => { if (notificationForAccount(activeSession.current, notification.request.content.data)) void handlers.current.onForeground().catch(() => {}); });
    const tapped = Notifications.addNotificationResponseReceivedListener(response => { void open(response).catch(() => {}); });
    return () => { foreground.remove(); rotated.remove(); received.remove(); tapped.remove(); };
  }, []);
  const enabled = !!session && preferences?.owner === owner && preferences.opted_in && !!preferences.binding && permission === 'granted' && verified;
  return { state: { ready: !!preferences, enabled, optedIn: !!preferences?.opted_in && preferences.owner === owner, pendingOff: !!preferences?.owner && preferences.owner === owner && !!preferences.pending_off, installationId: preferences?.installation_id, permission, working, error }, enable, disable, refresh, clear, clearReadPrompts };
}
export type PushControls = ReturnType<typeof usePushNotifications>;
export default function PushSettings({ push, busy, onBusyChange, onChanged }: { push: PushControls; busy: boolean; onBusyChange: (busy: boolean) => void; onChanged?: (enabled: boolean) => Promise<void> }) {
  const { ui } = useUI(), { state } = push;
  const disabled = busy || state.working || !state.ready || state.permission === 'denied';
  async function act(action: () => Promise<void>) { if (busy || state.working) return; onBusyChange(true); try { await action(); } catch { /* The hook keeps the actionable error visible. */ } finally { onBusyChange(false); } }
  return <View style={{ gap: 8 }}>
    <NotificationSwitch icon="phone" label="Push notifications" checked={state.enabled} disabled={disabled} onChange={value => void act(async () => { if (value) { if (await push.enable()) await onChanged?.(true); } else { await push.disable(); await onChanged?.(false); } })} />
    {(state.working || state.permission === 'denied' || state.pendingOff) && <Text style={ui.caption}>{state.working ? 'Updating…' : state.permission === 'denied' ? 'Blocked in phone settings.' : 'Waiting to turn off. Retry when connected.'}</Text>}
    {state.permission === 'denied' && <Button title="Open phone settings" kind="text" disabled={busy || state.working} onPress={() => void Linking.openSettings().catch(() => {})} />}
    {!!state.error && <ErrorState error={state.error} retryLabel="Retry notifications" disabled={busy || state.working} onRetry={() => void act(push.refresh)} />}
  </View>;
}
