import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { accountOwner, request } from './api';
import { getDatabase } from './native';
import { subscribeConnection } from './connectivity';
import { channelPreferences, type ChannelPatch, type ChannelState, type Channels } from './channelPreferences';
import type { Session } from './types';

const empty: ChannelState = { value: null, pending: false, saving: false, error: '' };
export function useNotificationChannels(session: Session | null) {
  const owner = session ? accountOwner(session) : '';
  const activeSession = useRef(session); activeSession.current = session;
  const [view, setView] = useState({ owner: '', state: empty }), [reload, setReload] = useState(0);
  const current = useRef<{ owner: string; controller: ReturnType<typeof channelPreferences> } | null>(null);
  useEffect(() => {
    let closed = false, controller: ReturnType<typeof channelPreferences> | null = null, failures = 0, next = 0;
    current.current = null;
    const foreground = () => Platform.OS === 'web' ? document.visibilityState === 'visible' : AppState.currentState === 'active';
    async function reconcile(force = false) {
      if (!controller || closed || !foreground() || !force && Date.now() < next) return;
      await controller.sync();
      const failed = !!controller.state.error;
      failures = failed ? failures + 1 : 0;
      next = Date.now() + (failed ? Math.min(60_000, 7500 * 2 ** Math.min(failures, 3)) : 60_000);
    }
    if (session) void (async () => {
      try {
        const db = await getDatabase(); if (closed) return;
        controller = channelPreferences(db, owner, Crypto.randomUUID,
          patch => { const active = activeSession.current; if (!active || accountOwner(active) !== owner) throw new Error('The signed-in account changed.'); return request<Channels>(active, patch ? '/me/notifications/channels' : `/me/notifications/channels?refresh=${Crypto.randomUUID()}`, patch ? 'PUT' : 'GET', patch); },
          state => { if (!closed) setView({ owner, state }); });
        current.current = { owner, controller };
        await controller.load();
      } catch { if (!closed) setView({ owner, state: { ...empty, error: 'Could not open notification settings. Try again.' } }); }
    })();
    const foregroundListener = AppState.addEventListener('change', value => { if (value === 'active') void reconcile(true); });
    const unsubscribe = subscribeConnection(() => { void reconcile(true); });
    const online = () => { void reconcile(true); };
    if (Platform.OS === 'web') { window.addEventListener('online', online); document.addEventListener('visibilitychange', online); }
    const timer = setInterval(() => { void reconcile(); }, 15_000);
    return () => { closed = true; controller?.stop(); if (current.current?.controller === controller) current.current = null; clearInterval(timer); foregroundListener.remove(); unsubscribe(); if (Platform.OS === 'web') { window.removeEventListener('online', online); document.removeEventListener('visibilitychange', online); } };
  }, [owner, reload]);
  const controller = () => { const value = current.current; if (!value || value.owner !== owner) throw new Error('Notification settings are still loading.'); return value.controller; };
  const change = (patch: ChannelPatch) => { try { return controller().change(patch); } catch (cause) { return Promise.reject(cause); } };
  return { state: view.owner === owner ? view.state : empty, change,
    retry: async () => { const active = current.current; if (!active || active.owner !== owner) { setReload(value => value + 1); return false; } try { return await active.controller.retry(); } catch { return false; } },
    activatePush: async () => { await change({ activate_push: true }); const value = controller(); await value.retry(); if (value.state.pending || value.state.value?.legacy_muted) throw new Error('Saved on this device. Will sync when connected.'); },
  };
}
export type NotificationChannels = ReturnType<typeof useNotificationChannels>;
