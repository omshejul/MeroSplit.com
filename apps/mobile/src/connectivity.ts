// Reachability is a hint for queuing, never proof that a write was accepted.
let reachable = true;
const listeners = new Set<() => void>();
export function serverReachable(): boolean { return reachable; }
export function recordConnection(value: boolean): void {
  if (reachable === value) return;
  reachable = value; for (const listener of listeners) listener();
}
export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
