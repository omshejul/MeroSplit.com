import type { Session } from './types';
import { sessionRequest } from './transport.ts';

export type LinkedProviders = { google: boolean; apple: boolean };
export async function readLinkedProviders(session: Session, client: 'app' | 'browser', signal: AbortSignal): Promise<LinkedProviders> {
  const response = await sessionRequest(session, `/_allauth/${client}/v1/account/providers`, { signal, cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error('Could not check connected accounts.');
  const value = await response.json() as { data?: { provider?: { id?: string } }[] };
  if (!Array.isArray(value.data) || !value.data.every(item => item && typeof item.provider?.id === 'string')) throw new Error('Could not check connected accounts.');
  const providers = new Set(value.data.map(item => item.provider!.id));
  return { google: providers.has('google'), apple: providers.has('apple') };
}
