import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import type { Session } from './types';
import { readLinkedProviders, type LinkedProviders } from './linkedProviders';

export type ProviderConnections = { status: 'unknown' | 'loading' | 'ready' | 'error'; connected: LinkedProviders | null; refresh: () => void };
export function useLinkedProviders(session: Session | null, enabled: boolean): ProviderConnections {
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<{ key: string; status: ProviderConnections['status']; connected: LinkedProviders | null }>({ key: '', status: 'unknown', connected: null });
  const key = session ? `${session.baseUrl}|${session.userId}|${session.token}|${revision}` : '';
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!session || !enabled) { setValue({ key, status: 'unknown', connected: null }); return; }
    let current = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    setValue({ key, status: 'loading', connected: null });
    void readLinkedProviders(session, Platform.OS === 'web' ? 'browser' : 'app', controller.signal)
      .then(connected => { if (current) setValue({ key, status: 'ready', connected }); })
      .catch(() => { if (current) setValue({ key, status: 'error', connected: null }); })
      .finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [key, enabled]);
  // Never render another account/request generation, even before effect cleanup.
  if (!session || !enabled) return { status: 'unknown', connected: null, refresh };
  const current = value.key === key ? value : { status: 'loading' as const, connected: null };
  return { status: current.status, connected: current.connected, refresh };
}
