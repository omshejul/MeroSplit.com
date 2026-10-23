import { accountOwner, ApiError, request } from './api.ts';
import type { Expense, Group, Session } from './types.ts';

export type PushPermission = 'ask' | 'granted' | 'denied';
export type PushDevice = { provider: 'expo'; token: string; platform: 'ios' | 'android' };
export type PushPreferences = { installation_id: string; owner: string | null; opted_in: boolean; binding: PushDevice | null };
export type PushTarget = { group: Group; expenseId: string | null };
export type PushSave = (state: PushPreferences) => Promise<void>;
export const emptyPushPreferences = (installation_id: string): PushPreferences => ({ installation_id, owner: null, opted_in: false, binding: null });

export function pushPermission(value: { status: string; canAskAgain?: boolean; ios?: { status: number } }): PushPermission {
  if (value.ios) return [2, 3, 4].includes(value.ios.status) ? 'granted' : value.ios.status === 0 ? 'ask' : 'denied';
  return value.status === 'granted' ? 'granted' : value.status === 'denied' && value.canAskAgain !== true ? 'denied' : 'ask';
}

export async function consentToPush(session: Session, state: PushPreferences, save: PushSave): Promise<PushPreferences> {
  const next = { ...state, owner: accountOwner(session), opted_in: true, binding: state.owner === accountOwner(session) ? state.binding : null };
  await save(next); return next;
}

export async function unregisterPushDevice(session: Session, state: PushPreferences, save: PushSave, send: typeof request = request): Promise<PushPreferences> {
  if (state.owner !== accountOwner(session)) { const next = emptyPushPreferences(state.installation_id); await save(next); return next; }
  const disabled = { ...state, opted_in: false };
  await save(disabled);
  try { await send(session, `/me/push-devices/${state.installation_id}`, 'DELETE'); }
  catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
  const next = emptyPushPreferences(state.installation_id);
  await save(next); return next;
}

export async function refreshPushDevice(session: Session, state: PushPreferences, permission: PushPermission, getDevice: () => Promise<PushDevice>, save: PushSave, send: typeof request = request): Promise<PushPreferences> {
  if (state.owner !== accountOwner(session)) { const next = emptyPushPreferences(state.installation_id); await save(next); return next; }
  if (!state.opted_in || permission !== 'granted') return unregisterPushDevice(session, state, save, send);
  const device = await getDevice();
  if (!/^(?:Expo|Exponent)PushToken\[[^\]]+\]$/.test(device.token) || device.provider !== 'expo' || !['ios', 'android'].includes(device.platform)) throw new Error('Notifications are unavailable on this device.');
  const result = await send<{ id: string; enabled: boolean }>(session, `/me/push-devices/${state.installation_id}`, 'PUT', device);
  if (result.id !== state.installation_id || result.enabled !== true) throw new Error('Could not enable notifications. Try again when connected.');
  const next = { ...state, binding: device }; await save(next); return next;
}

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function notificationForAccount(session: Session | null, data: unknown): data is Record<string, string> {
  return !!session && !!data && typeof data === 'object' && !Array.isArray(data)
    && (data as Record<string, unknown>).type === 'new_bill' && (data as Record<string, unknown>).recipient_user_id === session.userId;
}

export async function notificationTarget(session: Session, data: unknown, send: typeof request = request): Promise<PushTarget | null> {
  if (!notificationForAccount(session, data) || !uuid.test(data.group_id ?? '') || !uuid.test(data.expense_id ?? '')) return null;
  try {
    let group = await send<Group>(session, `/groups/${data.group_id}/summary`);
    if (group.id !== data.group_id) return null;
    if (group.read_mode === 'summary' && !group.expenses.some(expense => expense.id === data.expense_id)) {
      try {
        const detail = await send<Expense & { group_id: string; group_version: number }>(session, `/groups/${group.id}/expenses/${data.expense_id}?version=${group.version}`);
        if (detail.group_id !== group.id || detail.group_version !== group.version) return null;
        group = { ...group, focused_expense: detail };
      } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    }
    return { group, expenseId: (group.expenses.some(expense => expense.id === data.expense_id && !expense.deleted) || group.focused_expense?.id === data.expense_id && !group.focused_expense.deleted) ? data.expense_id : null };
  } catch { return null; }
}
