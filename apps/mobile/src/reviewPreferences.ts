import * as SecureStore from 'expo-secure-store';
import { readReviewState, reviewEligible, reviewDay, type ReviewState } from './reviewPolicy';
// Device-wide limits survive navigation, restart and account switching. No bill contents are stored.
const key = 'merosplit.review.v1';
let writes = Promise.resolve();
export function updateReviewPreferences<T>(update: (state: ReviewState, now: number) => T): Promise<T> {
  const job = writes.catch(() => {}).then(async () => {
    const now = Date.now(), state = readReviewState(await SecureStore.getItemAsync(key), now), result = update(state, now);
    await SecureStore.setItemAsync(key, JSON.stringify(state));
    return result;
  });
  writes = job.then(() => {}, () => {});
  return job;
}
export function beginReviewSession() {
  return updateReviewPreferences((state, now) => {
    if (now - state.lastSession >= 30 * 60_000) { state.sessions = Math.min(3, state.sessions + 1); state.lastSession = now; }
  });
}
export function claimReviewRequest(manual = false) {
  return updateReviewPreferences((state, now) => {
    if (!manual && !reviewEligible(state, now)) return false;
    state.attempts = [...state.attempts.filter(at => now - at < 365 * reviewDay), now].slice(-2);
    return true;
  });
}
