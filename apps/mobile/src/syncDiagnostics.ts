// This seam keeps synchronization independent of the native diagnostics SDK.
export type SyncDiagnostic = { phase: 'started' | 'accepted' | 'failed'; userId: string; pending_count: number; status?: number };
let observer: (event: SyncDiagnostic, error?: unknown) => void = () => {};
export function configureSyncDiagnostics(next: typeof observer) { observer = next; }
export function reportSyncDiagnostic(event: SyncDiagnostic, error?: unknown) {
  try { observer(event, error); } catch { /* Diagnostics must never interrupt a save or retry. */ }
}

export type RequestDiagnostic = { userId: string; method: string; route: string };
type TraceRequest = <T>(details: RequestDiagnostic, task: () => Promise<T>) => Promise<T> | undefined;
let trace: TraceRequest = (_details, task) => task();
export function configureRequestTracing(next: TraceRequest) { trace = next; }
export async function traceDiagnosticRequest<T>(details: RequestDiagnostic, task: () => Promise<T>): Promise<T> {
  let started: Promise<T> | undefined;
  const once = () => {
    if (!started) { try { started = task(); } catch (error) { started = Promise.reject(error); } }
    return started;
  };
  try { return await (trace(details, once) ?? once()); }
  catch { return started ?? once(); } // Instrumentation failure never retries a request already started.
}
