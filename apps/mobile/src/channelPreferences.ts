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

// One local snapshot owns pending choices. Receipts acknowledge revisions;
// only an idle, fresh read may adopt account changes from another device.
export function channelPreferences(db: Database, owner: string, uuid: () => string,
  send: (patch?: ChannelPatch & { client_id: string; revision: number }) => Promise<Channels & { revision?: number }>, publish: (state: ChannelState) => void) {
  let row: Row | null = null, stopped = false, active: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let state: ChannelState = { value: null, pending: false, saving: false, error: '' };
  const pending = () => !!row && Object.keys(row.pending).length > 0;
  const emit = (patch: Partial<ChannelState> = {}) => { state = { ...state, value: row?.value ?? null, pending: pending(), ...patch }; if (!stopped) publish(state); };
  function persist() {
    const snapshot = JSON.stringify(row);
    const work = writes.catch(() => {}).then(() => db.runAsync('INSERT OR REPLACE INTO notification_channels(owner,body) VALUES(?,?)', owner, snapshot)).catch(cause => { if (!stopped) emit({ saving: false, error: 'Could not save on this device. Try again.' }); throw cause; });
    writes = work;
    return work;
  }
  async function load() {
    await db.execAsync(table);
    if (stopped) return;
    const stored = await db.getFirstAsync<{ body: string }>('SELECT body FROM notification_channels WHERE owner=?', owner);
    if (stopped) return;
    row = stored ? JSON.parse(stored.body) as Row : null;
    if (row) { validChannels(row.value); emit(); }
    await sync();
  }
  function sync(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = flush().finally(() => { active = null; if (!stopped && pending() && !state.error && !state.saving) void sync(); });
    return active;
  }
  async function flush() {
    try {
      let wrote = false;
      await writes;
      if (!row) {
        const remote = validChannels(await send());
        if (stopped) return;
        row = { client_id: uuid(), revision: 0, value: remote, pending: {} };
        await persist(); if (!stopped) emit({ error: '' });
        return;
      }
      while (!stopped && row && pending()) {
        await writes;
        const sent = row; wrote = true;
        const receipt = await send({ ...sent.pending, client_id: sent.client_id, revision: sent.revision });
        const remote = validChannels(receipt);
        if (!Number.isSafeInteger(receipt.revision) || receipt.revision! < sent.revision) throw new Error('Could not confirm notification settings.');
        if (stopped) return;
        // A newer tap already owns both the UI and the next outgoing write.
        if (row.revision !== sent.revision) continue;
        if (receipt.revision! > sent.revision) {
          row = { ...row, revision: receipt.revision! + 1 };
        } else {
          row = { ...row, pending: {}, value: { ...row.value, email_available: remote.email_available, legacy_muted: remote.legacy_muted, muted_push_devices: remote.muted_push_devices } };
        }
        const stamp = row.revision;
        await persist();
        if (!stopped && row.revision === stamp) emit({ error: '' });
      }
      // Never follow an acknowledgement with another read that could replay
      // an earlier response. Foreground/idle refreshes can adopt account edits.
      if (!wrote && !stopped && row && !pending()) {
        const stamp = row.revision, remote = validChannels(await send());
        if (stopped || row.revision !== stamp || pending()) return;
        row = { ...row, value: remote };
        await persist();
        if (!stopped && row.revision === stamp) emit({ error: '' });
      }
    } catch (cause) {
      if (!stopped) emit({ error: state.error.startsWith('Could not save on this device') ? state.error : cause instanceof ApiError && cause.status === 401 ? 'Sign in again to sync your notification settings.' : cause instanceof ApiError && cause.status === 422 ? cause.message : row ? 'Saved on this device. Will sync when connected.' : 'Could not load notification settings. Try again.' });
    }
  }
  function change(patch: ChannelPatch) {
    if (stopped || !row) return Promise.reject(new Error('Notification settings are not ready.'));
    const { activate_push: _, ...editable } = patch;
    const value = { ...row.value, ...editable };
    if (patch.email_notifications !== undefined || patch.statement_frequency) value.statement_enabled = value.email_notifications;
    row = { ...row, revision: row.revision + 1, value, pending: { ...row.pending, ...patch } };
    const stamp = row.revision;
    emit({ saving: true, error: '' });
    const local = persist();
    void local.then(() => {
      if (stopped) return;
      if (row?.revision === stamp) emit({ saving: false });
      void sync();
    }, () => { if (!stopped && row?.revision === stamp) emit({ saving: false, error: 'Could not save on this device. Try again.' }); });
    return local;
  }
  async function retry() {
    if (!row) await load();
    if (state.error.startsWith('Could not save on this device')) { await persist(); emit({ saving: false, error: '' }); }
    await sync();
    if (pending() && !state.error) await sync();
    return !state.pending && !state.error;
  }
  async function stop() { stopped = true; const owned = controllers.get(owner); owned?.delete(stop); if (!owned?.size) controllers.delete(owner); await Promise.allSettled([writes, active]); }
  if (!controllers.has(owner)) controllers.set(owner, new Set());
  controllers.get(owner)!.add(stop);
  return { get state() { return state; }, load, sync, change, retry, stop };
}
