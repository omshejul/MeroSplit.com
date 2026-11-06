import type { Command, Group } from './types';
import { pendingCommands, discardCommand } from './storage.ts';
import type { Database } from './storage';

// Only settings with a server-side revision guard may be retried after a known rejection.
export function isGroupSetting(command: Command): boolean {
  const path = `/groups/${command.group_id}/`;
  return command.method === 'POST' && Number.isSafeInteger(command.body.version) && Number(command.body.version) > 0
    && (command.path === `${path}simplify` && typeof command.body.simplify_debts === 'boolean'
      || command.path === `${path}name` && typeof command.body.name === 'string'
      || command.path.startsWith(`${path}participants/`) && /^participants\/[^/]+\/nickname$/.test(command.path.slice(path.length)) && typeof command.body.name === 'string');
}

export function groupSettingReview(command: Command, group: Group) {
  if (!isGroupSetting(command) || command.group_id !== group.id) return null;
  let label: string, saved: string, current: string;
  let available = !group.archived && !group.is_direct;
  if (command.path.endsWith('/simplify')) {
    label = 'Simplify debts'; saved = command.body.simplify_debts ? 'On' : 'Off'; current = group.simplify_debts !== false ? 'On' : 'Off';
    available &&= group.can_change_simplify === true;
  } else if (command.path === `/groups/${group.id}/name`) {
    label = 'Group name'; saved = String(command.body.name).trim(); current = group.name;
    available &&= !!saved && saved.length <= 120;
  } else {
    const person = group.participants.find(person => person.id === command.path.split('/').at(-2));
    label = person ? `Nickname for ${person.name}` : 'Nickname';
    saved = String(command.body.name).trim(); current = person?.name ?? 'Person unavailable';
    available &&= !!person && !person.removed && saved.length <= 120;
    if (!saved) saved = person?.default_name ?? person?.recorded_name ?? person?.name ?? 'Original name';
  }
  return { label, saved, current, canApply: available && command.state === 'conflict' };
}

export async function resolveGroupSetting(db: Database, owner: string, original: Command, group: Group, newId: string | null): Promise<void> {
  const review = groupSettingReview(original, group);
  if (!review || newId && !review.canApply) throw new Error('Review the latest setting before continuing.');
  await db.withExclusiveTransactionAsync(async tx => {
    const stored = (await pendingCommands(tx, owner)).find(value => value.command_id === original.command_id);
    if (!stored || stored.state !== original.state || stored.state === 'pending' || stored.path !== original.path || stored.method !== original.method || stored.group_id !== group.id || JSON.stringify(stored.body) !== JSON.stringify(original.body)) {
      throw new Error('This saved change was already updated. Reopen Saved changes.');
    }
    if (!newId) { await discardCommand(tx, owner, original.command_id); return; }
    if (newId === original.command_id) throw new Error('Use a new ID for a reviewed change.');
    await tx.runAsync("UPDATE outbox SET command_id=?,body=?,state='pending',error=NULL,attempted=0,base_version=? WHERE owner=? AND command_id=?", newId, JSON.stringify({ ...stored.body, command_id: newId, version: group.version }), group.version, owner, original.command_id);
  });
}
