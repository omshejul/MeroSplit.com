import { ApiError } from './api.ts';
import type { Database } from './storage.ts';

export type Channels = { muted_push_devices?: { id: string; revision: number }[]; email_notifications: boolean; email_available: boolean; legacy_muted: boolean; statement_enabled: boolean; statement_frequency: 'weekly' | 'monthly' };
export type ChannelPatch = Partial<Pick<Channels, 'email_notifications' | 'statement_frequency'>> & { activate_push?: true };
type Row = { client_id: string; revision: number; value: Channels; pending: ChannelPatch };
export type ChannelState = { value: Channels | null; pending: boolean; saving: boolean; error: string };
const controllers = new Map<string, Set<() => Promise<void>>>();
const table = 'CREATE TABLE IF NOT EXISTS notification_channels (owner TEXT PRIMARY KEY, body TEXT NOT NULL)';
export async function clearNotificationChannels(db: Database, owner: string) { await Promise.allSettled([...(controllers.get(owner) ?? [])].map(stop => stop())); await db.execAsync(table); await db.runAsync('DELETE FROM notification_channels WHERE owner=?', owner); }
export function channelSummary(push: boolean, email: boolean) { return push && email ? 'Push and email' : push ? 'Push' : email ? 'Email' : 'Off'; }
export function validChannels(value: Channels): Channels {
  if (!value || ['email_notifications', 'email_available', 'legacy_muted', 'statement_enabled'].some(key => typeof value[key as keyof Channels] !== 'boolean') || !['weekly', 'monthly'].includes(value.statement_frequency)) throw new Error('Could not read notification settings.');
  return value;
}

// The persisted row contains both the local choice and the changes still owed to
// the server. Acknowledgements clear only their exact revision.
export function channelPreferences(db: Database, owner: string, uuid: () => string,
  send: (patch?: ChannelPatch & { client_id: string; revision: number }) => Promise<Channels & { revision?: number }>, publish: (state: ChannelState) => void) {
  let row: Row | null = null, stopped = false, active: Promise<void> | null = null, generation = 0, unsaved: ChannelPatch = {};
  let writes: Promise<unknown> = Promise.resolve();
  let state: ChannelState = { value: null, pending: false, saving: false, error: '' };
  const emit = (patch: Partial<ChannelState>) => { state = { ...state, ...patch }; if (!stopped) publish(state); };
  const save = (value: Row) => db.runAsync('INSERT OR REPLACE INTO notification_channels(owner,body) VALUES(?,?)', owner, JSON.stringify(value));
  const read = async () => { const stored = await db.getFirstAsync<{ body: string }>('SELECT body FROM notification_channels WHERE owner=?', owner); return stored ? JSON.parse(stored.body) as Row : null; };
  async function load() {
    await db.execAsync(table); row = await read();
    if (stopped) return;
    if (row) { validChannels(row.value); emit({ value: row.value, pending: !!Object.keys(row.pending).length }); }
    await sync();
  }
  function sync(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = flush().finally(() => { active = null; if (!stopped && state.pending && !state.error && !Object.keys(unsaved).length) void sync(); });
    return active;
  }
  async function flush() {
    try {
      await writes;
      for (;;) {
        if (stopped) return;
        const current = await read();
        if (!current) break;
        if (!Object.keys(current.pending).length) break;
        const stamp = generation;
        const receipt = await send({ ...current.pending, client_id: current.client_id, revision: current.revision });
        if (!Number.isSafeInteger(receipt.revision) || receipt.revision! < current.revision) throw new Error('Could not confirm notification settings.');
        const remote = validChannels(receipt);
        if (stopped) return;
        await db.withExclusiveTransactionAsync(async tx => {
          const latest = await tx.getFirstAsync<{ body: string }>('SELECT body FROM notification_channels WHERE owner=?', owner);
          const stored: Row | null = latest ? JSON.parse(latest.body) : null;
          if (!stored || stored.revision !== current.revision) return;
          // A restored database may have an older client revision than the server.
          if (receipt.revision! > current.revision) {
            await tx.runAsync('UPDATE notification_channels SET body=? WHERE owner=?', JSON.stringify({ ...stored, revision: receipt.revision! + 1 }), owner); return;
          }
          await tx.runAsync('UPDATE notification_channels SET body=? WHERE owner=?', JSON.stringify({ ...stored, value: remote, pending: {} }), owner);
        });
        if (generation === stamp) { row = await read(); if (row) emit({ value: row.value, pending: !!Object.keys(row.pending).length, error: '' }); }
        await writes;
      }
      const stamp = generation, remote = validChannels(await send());
      if (stopped || stamp !== generation) return;
      await writes;
      const current = await read();
      if (stopped || stamp !== generation || current && Object.keys(current.pending).length) return;
      row = { client_id: current?.client_id ?? uuid(), revision: current?.revision ?? 0, value: remote, pending: {} };
      await save(row);
      if (!stopped && stamp === generation) emit({ value: remote, pending: false, error: '' });
    } catch (cause) { if (!stopped) emit({ error: cause instanceof ApiError && cause.status === 401 ? 'Sign in again to sync your notification settings.' : cause instanceof ApiError && cause.status === 422 ? cause.message : state.value ? 'Saved on this device. Will sync when connected.' : 'Could not load notification settings. Try again.' }); }

  }
  function change(patch: ChannelPatch) {
    if (stopped || !state.value) return Promise.reject(new Error('Notification settings are not ready.'));
    const intent = ++generation;
    unsaved = { ...unsaved, ...patch };
    const persistedPatch = { ...unsaved };
    const { activate_push, ...editable } = patch;
    const value = { ...state.value, ...editable };
    if (patch.email_notifications !== undefined) value.statement_enabled = patch.email_notifications;
    if (patch.statement_frequency) value.statement_enabled = value.email_notifications;
    emit({ value, pending: true, saving: true, error: '' });
    const local = writes.catch(() => {}).then(async () => {
      await db.withExclusiveTransactionAsync(async tx => {
        const stored = await tx.getFirstAsync<{ body: string }>('SELECT body FROM notification_channels WHERE owner=?', owner);
        const previous: Row | null = stored ? JSON.parse(stored.body) : null;
        const { activate_push: activation, ...localPatch } = persistedPatch;
        const merged = { ...(previous?.value ?? value), ...localPatch };
        if (localPatch.email_notifications !== undefined) merged.statement_enabled = localPatch.email_notifications;
        if (localPatch.statement_frequency) merged.statement_enabled = merged.email_notifications;
        const next: Row = { client_id: previous?.client_id ?? uuid(), revision: (previous?.revision ?? 0) + 1, value: merged, pending: { ...previous?.pending, ...persistedPatch } };
        await tx.runAsync('INSERT OR REPLACE INTO notification_channels(owner,body) VALUES(?,?)', owner, JSON.stringify(next));
      });
      if (!stopped && generation === intent) { unsaved = {}; emit({ saving: false }); }
    });
    writes = local;
    void local.then(() => sync(), () => { if (!stopped && generation === intent) emit({ saving: false, error: 'Could not save on this device. Try again.' }); });
    return local;
  }
  async function stop() { stopped = true; ++generation; const owned = controllers.get(owner); owned?.delete(stop); if (!owned?.size) controllers.delete(owner); await Promise.allSettled([writes, active]); }
  if (!controllers.has(owner)) controllers.set(owner, new Set());
  controllers.get(owner)!.add(stop);
  return { get state() { return state; }, load, sync, change, retry: async () => { if (!state.value) await load(); if (Object.keys(unsaved).length) await change(unsaved); await sync(); if (state.pending && !state.error) await sync(); return !state.pending && !state.error; }, stop };
}
