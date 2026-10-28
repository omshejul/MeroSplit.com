import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { Session } from './types';
import { cachedLinkedProviders, invalidateLinkedProviders, readLinkedProviders, updateLinkedProviders, type LinkedProviders } from './linkedProviders';

type Status = 'unknown' | 'loading' | 'ready' | 'error';
type State = { key: string; status: Status; connected: LinkedProviders | null; working: boolean; error: string };
export type ProviderConnections = Omit<State, 'key'> & { refresh: () => void; setAutoLink: (value: boolean) => Promise<void>; disconnect: (id: string) => Promise<void> };
export function useLinkedProviders(session: Session | null, enabled: boolean): ProviderConnections {
  const key = session ? JSON.stringify([session.baseUrl, session.userId, session.token]) : '';
  const [revision, setRevision] = useState(0), [value, setValue] = useState<State>({ key: '', status: 'unknown', connected: null, working: false, error: '' });
  const active = useRef(key), generation = useRef(0), flight = useRef(''); active.current = key;
  const refresh = useCallback(() => { if (session) invalidateLinkedProviders(session); ++generation.current; setValue(previous => previous.key === key ? { ...previous, status: 'loading', error: '' } : previous); setRevision(value => value + 1); }, [key]);
  useEffect(() => {
    if (!session) { setValue({ key, status: 'unknown', connected: null, working: false, error: '' }); return; }
    const connected = cachedLinkedProviders(session);
    if (!enabled) { setValue(previous => ({ key, status: 'unknown', connected: previous.key === key ? previous.connected ?? connected : connected, working: false, error: '' })); return; }
    let current = true; const version = ++generation.current;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    setValue(previous => ({ key, status: 'loading', connected: previous.key === key ? previous.connected ?? connected : connected, working: false, error: '' }));
    void readLinkedProviders(session, Platform.OS === 'web' ? 'browser' : 'app', controller.signal)
      .then(connected => { if (current && version === generation.current) setValue({ key, status: 'ready', connected, working: false, error: '' }); })
      .catch(() => { if (current && version === generation.current) setValue(previous => ({ ...previous, status: 'error', working: false, error: 'Could not check sign-in methods. Try again when you’re online.' })); })
      .finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [key, revision, enabled]);
  async function update(action: { autoLink: boolean } | { disconnect: string }) {
    if (!session || !enabled || value.key !== key || value.status !== 'ready' || flight.current === key) return;
    flight.current = key; ++generation.current; const previous = value.connected;
    setValue({ ...value, working: true, error: '', connected: previous && 'autoLink' in action ? { ...previous, autoLink: action.autoLink } : previous });
    try {
      const connected = await updateLinkedProviders(session, action);
      if (active.current === key) setValue({ key, status: 'ready', connected, working: false,
        error: connected.appleRevocation === 'manual_required' ? 'Apple is disconnected here. Remove MeroSplit in your Apple ID settings to finish revoking Apple access.' : '' });
    } catch (cause) {
      if (active.current === key) setValue({ key, status: 'ready', connected: previous, working: false, error: cause instanceof Error ? cause.message : 'Could not update sign-in methods. Try again.' });
    } finally { if (flight.current === key) flight.current = ''; }
  }
  const current = value.key === key ? value : { status: session ? 'loading' as const : 'unknown' as const, connected: null, working: false, error: '' };
  return { ...current, status: !enabled ? 'unknown' : current.status, refresh, setAutoLink: autoLink => update({ autoLink }), disconnect: disconnect => update({ disconnect }) };
}
