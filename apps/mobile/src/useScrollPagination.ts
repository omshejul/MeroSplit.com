import { useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

type Options = { scope: string; cursor: string | number | null | undefined; enabled: boolean; automatic?: boolean; load: (signal: AbortSignal) => Promise<boolean | null> };
const initial = (scope: string) => ({ scope, pending: false, failed: false, completed: null as string | null, controller: null as AbortController | null });

// Scope and cursor guards keep overlapping scroll events and stale responses
// from advancing the same page twice.
export function useScrollPagination(options: Options) {
  const latest = useRef(options); latest.current = options;
  const state = useRef(initial(options.scope)), [, render] = useState(0);
  if (state.current.scope !== options.scope) state.current = initial(options.scope);
  const current = state.current;
  const viewport = useRef({ height: 0, content: 0, offset: 0 });
  function loadAhead() {
    if (!current.failed) loadMore();
  }
  function loadNearEnd() {
    const { height, content, offset } = viewport.current;
    if (latest.current.automatic && height > 0 && content > 0 && content - offset - height <= height) loadAhead();
  }
  const events = {
    onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      viewport.current = { height: layoutMeasurement.height, content: contentSize.height, offset: contentOffset.y };
      loadNearEnd();
    },
    onLayout(event: LayoutChangeEvent) {
      viewport.current.height = event.nativeEvent.layout.height;
      loadNearEnd();
    },
    onContentSizeChange(_width: number, height: number) {
      viewport.current.content = height;
      loadNearEnd();
    },
  };
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
  useEffect(loadNearEnd, [options.scope, options.cursor, options.enabled]);
  return { events, loadAhead, loading: current.pending && options.enabled, failed: current.failed,
    canLoadMore: options.enabled && !!options.cursor && current.completed !== String(options.cursor), loadMore, retry: loadMore };
}
