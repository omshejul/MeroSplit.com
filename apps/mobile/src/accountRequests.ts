let paused = false;
const inFlight = new Set<Promise<Response>>();

export class AuthTransitionError extends Error {
  constructor() { super('Signing in. Please wait before continuing.'); }
}
export function accountRequestsPaused(): boolean { return paused; }
export async function pauseAccountRequests(): Promise<void> {
  paused = true;
  await Promise.allSettled([...inFlight]);
}
export function resumeAccountRequests(): void { paused = false; }

// Drain through response headers. Callers still guard later body/UI work by
// the session generation, without buffering account exports or media.
export function accountRequest(send: () => Promise<Response>): Promise<Response> {
  if (paused) return Promise.reject(new AuthTransitionError());
  const pending = send();
  inFlight.add(pending);
  void pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
  return pending;
}
