import type { Command } from './types';
export type SyncState = 'Synced' | 'Saved on device' | 'Syncing' | 'Needs attention' | 'Offline';
export function syncStatus({ commands, pendingFiles = 0, drafts = false, confirmedAt, durable, syncing, problem, reviewRequired = false, online = true }: { commands: Command[]; pendingFiles?: number; drafts?: boolean; confirmedAt: string | null; durable: boolean; syncing: boolean; problem: boolean; reviewRequired?: boolean; online?: boolean }): { label: SyncState; detail: string } {
  if (!durable && (commands.length || pendingFiles || drafts)) return { label: 'Needs attention', detail: 'This tab has unsent changes or a draft in temporary storage. Save and sync, or export your work, before closing or reloading.' };
  if (reviewRequired) return { label: 'Needs attention', detail: 'Sign in again or review changed group access. Saved changes stay on this device.' };
  if (!online) return { label: 'Offline', detail: commands.length || pendingFiles ? `${commands.length + pendingFiles} unsent ${commands.length + pendingFiles === 1 ? 'change is' : 'changes are'} saved on this device. They will sync when you reconnect with the app open.` : 'No connection. Downloaded records are available here. Nothing is waiting to sync.' };
  if (commands.some(value => value.state !== 'pending')) return { label: 'Needs attention', detail: 'A saved change needs review. Later changes are kept on this device.' };
  if (problem && pendingFiles > 0) return { label: 'Needs attention', detail: 'Files are waiting to upload. Your saved files are kept on this device.' };
  if (syncing) return { label: 'Syncing', detail: commands.length || pendingFiles ? `Sending ${commands.length + pendingFiles} saved ${commands.length + pendingFiles === 1 ? 'change' : 'changes'}. You can keep using the app.` : 'Getting the latest bills and payments.' };
  if (commands.length || pendingFiles) return { label: 'Saved on device', detail: `${commands.length + pendingFiles} ${commands.length + pendingFiles === 1 ? 'change' : 'changes'} saved here. ${commands.length + pendingFiles === 1 ? 'It' : 'They'} will sync when a connection is available.` };
  if (drafts) return { label: 'Saved on device', detail: 'An unfinished draft is saved here. Finish and save it to sync.' };
  if (problem || !confirmedAt) return { label: 'Needs attention', detail: 'Reconnect to finish downloading and confirm your records. Only downloaded records are available offline.' };
  return { label: 'Synced', detail: `Bills and payments last synced ${new Date(confirmedAt).toLocaleString()}.` };
}
