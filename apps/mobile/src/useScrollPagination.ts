import { useEffect, useRef, useState } from 'react';

type Options = { scope: string; cursor: string | number | null | undefined; enabled: boolean; load: (signal: AbortSignal) => Promise<boolean | null> };
const initial = (scope: string) => ({ scope, pending: false, failed: false, completed: null as string | null, controller: null as AbortController | null });

// Older records load only on an explicit tap. Scope/cursor guards prevent double
// taps, cancelled requests and a previous account's response from advancing it.
export function useScrollPagination(options: Options) {
  const latest = useRef(options); latest.current = options;
  const state = useRef(initial(options.scope)), [, render] = useState(0);
  if (state.current.scope !== options.scope) state.current = initial(options.scope);
  const current = state.current;
  function loadMore() {
    const value = latest.current, key = String(value.cursor);
    if (state.current !== current || !value.enabled || !value.cursor || current.pending || current.completed === key) return;
    const controller = new AbortController(); current.controller = controller;
    current.pending = true; current.failed = false; render(n => n + 1);
    void value.load(controller.signal).then(added => {
      if (!controller.signal.aborted && state.current === current && added !== null) current.completed = key;
    }).catch(() => {
      if (!controller.signal.aborted && state.current === current) current.failed = true;
    }).finally(() => {
      if (state.current === current && current.controller === controller) { current.pending = false; render(n => n + 1); }
    });
  }
  useEffect(() => {
    const cancel = () => { current.controller?.abort(); current.controller = null; current.pending = false; };
    if (!options.enabled) cancel();
    return cancel;
  }, [options.scope, options.enabled]);
  return { loading: current.pending && options.enabled, failed: current.failed,
    canLoadMore: options.enabled && !!options.cursor && current.completed !== String(options.cursor), loadMore, retry: loadMore };
}
