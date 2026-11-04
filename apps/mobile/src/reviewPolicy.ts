import type { Command } from './types';
export const reviewDay = 86_400_000;
export type ReviewState = { version: 1; firstSeen: number; lastSession: number; sessions: number; expenses: string[]; settlement: boolean; attempts: number[] };
export const initialReviewState = (now: number): ReviewState => ({ version: 1, firstSeen: now, lastSession: now, sessions: 1, expenses: [], settlement: false, attempts: [] });
export function readReviewState(value: string | null, now: number): ReviewState {
  try {
    const state = JSON.parse(value ?? 'null');
    if (state?.version === 1 && [state.firstSeen, state.lastSession, state.sessions].every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
      && state.sessions >= 1 && state.sessions <= 3 && Array.isArray(state.expenses) && state.expenses.length <= 5 && state.expenses.every((id: unknown) => typeof id === 'string' && id.length <= 250)
      && typeof state.settlement === 'boolean' && Array.isArray(state.attempts) && state.attempts.length <= 2 && state.attempts.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return state;
  } catch { /* Damaged preferences start a new waiting period, never a review prompt. */ }
  return initialReviewState(now);
}
export function reviewEligible(state: ReviewState, now: number): boolean {
  return now - state.firstSeen >= 7 * reviewDay && state.sessions >= 3 && (state.expenses.length >= 5 || state.settlement)
    && state.attempts.filter(at => now - at < 365 * reviewDay).length < 2
    && state.attempts.every(at => now - at >= 90 * reviewDay);
}
export function successfulReviewAction(command: Command): 'expense' | 'settlement' | null {
  if (command.method !== 'POST' || command.body.deleted || typeof command.body.id !== 'string') return null;
  if (command.path === `/groups/${command.group_id}/expenses`) return 'expense';
  if (command.path === `/groups/${command.group_id}/settlements`) return 'settlement';
  return null;
}
const listeners = new Set<(owner: string, command: Command) => void>();
export function subscribeReviewActions(listener: (owner: string, command: Command) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function notifyReviewAction(owner: string, command: Command) {
  if (!successfulReviewAction(command)) return;
  for (const listener of listeners) { try { listener(owner, command); } catch { /* Reviews cannot affect a saved record. */ } }
}
