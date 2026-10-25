import type { Command } from './types';
export type SyncState = 'Synced' | 'Saved on device' | 'Syncing' | 'Needs attention';
export function syncStatus({ commands, pendingFiles = 0, drafts = false, confirmedAt, durable, syncing, problem }: { commands: Command[]; pendingFiles?: number; drafts?: boolean; confirmedAt: string | null; durable: boolean; syncing: boolean; problem: boolean }): { label: SyncState; detail: string } {
  if (!durable) return { label: 'Needs attention', detail: 'Storage is temporary. Keep this tab open and export unsent changes.' };
  if (commands.some(value => value.state !== 'pending') || problem && pendingFiles > 0) return { label: 'Needs attention', detail: 'A saved change needs review. Later changes are kept on this device.' };
  if (syncing) return { label: 'Syncing', detail: 'Checking the server. Saved changes stay on this device until confirmed.' };
  if (commands.length || pendingFiles) return { label: 'Saved on device', detail: `${commands.length + pendingFiles} ${commands.length + pendingFiles === 1 ? 'change' : 'changes'} saved here. They will sync when a connection is available.` };
  if (drafts) return { label: 'Saved on device', detail: 'An unfinished draft is saved here. Finish and save it to sync.' };
  if (problem || !confirmedAt) return { label: 'Needs attention', detail: 'Reconnect to finish downloading and confirm your records. Only downloaded records are available offline.' };
  return { label: 'Synced', detail: `Changes and group records last confirmed ${new Date(confirmedAt).toLocaleString()}. External services and files not downloaded still need a connection.` };
}
