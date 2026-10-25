import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

type ScrollRef = { current: any };
type Options = { scope: string; cursor: string | number | null | undefined; enabled: boolean; scrollRef: ScrollRef; load: (signal: AbortSignal) => Promise<boolean | null> };
const initial = (scope: string) => ({ scope, pending: false, failed: false, completed: null as string | null, credits: 0, armed: false, lastGesture: 0, layoutChanged: false, offset: 0, height: 0, content: 0, empty: false, controller: null as AbortController | null });

// A few pages per actual scroll gesture, never an on-mount/eager cursor drain.
export function useScrollPagination(options: Options) {
  const latest = useRef(options); latest.current = options;
  const state = useRef(initial(options.scope)), [, render] = useState(0);
  if (state.current.scope !== options.scope) state.current = initial(options.scope);
  const current = state.current;
  function check(retry = false) {
    const value = latest.current, key = String(value.cursor);
    if (state.current !== current || !value.enabled || value.scope !== current.scope || !value.cursor || current.pending
      || !retry && (current.failed || current.completed === key || !current.armed || current.credits < 1
        || current.height < 1 || !current.empty && Date.now() - current.lastGesture > 2500
        || current.content - current.height - current.offset > 180)) return;
    const controller = new AbortController(); current.controller = controller;
    current.pending = true; current.failed = false; current.credits--; current.completed = key; render(n => n + 1);
    void value.load(controller.signal).then(added => {
      if (controller.signal.aborted || state.current !== current || current.controller !== controller) return;
      if (added === null) { current.completed = null; current.armed = false; current.empty = false; return; }
      current.empty = !added;
      if (added) current.armed = false;
    }).catch(() => {
      if (!controller.signal.aborted && state.current === current && current.controller === controller) { current.failed = true; current.completed = null; }
    }).finally(() => {
      if (state.current === current && current.controller === controller) { current.pending = false; render(n => n + 1); }
    });
  }
  function gesture(newGesture = false) {
    const now = Date.now();
    if (newGesture || now - current.lastGesture > 400) current.credits = 3;
    current.lastGesture = now; current.armed = true; check();
  }
  useEffect(() => {
    const cancel = () => { current.controller?.abort(); current.controller = null; current.pending = false; current.completed = null; current.armed = false; current.empty = false; current.credits = 0; };
    if (!options.enabled) cancel();
    return cancel;
  }, [options.scope, options.enabled]);
  // A wheel gesture also works on short or empty web content with another page.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = options.scrollRef.current?.getScrollableNode?.();
    if (!node?.addEventListener) return;
    const wheel = () => gesture();
    node.addEventListener('wheel', wheel, { passive: true });
    return () => node.removeEventListener('wheel', wheel);
  }, [options.scope, options.enabled]);
  useEffect(() => { if (current.empty) check(); }, [options.cursor, current.pending]);
  return {
    loading: current.pending && options.enabled, failed: current.failed,
    retry: () => { current.credits = 1; current.armed = true; check(true); },
    events: { onScrollBeginDrag: () => { if (Platform.OS !== 'web') gesture(true); },
    onTouchMove: () => gesture(), onEndReached: () => check(),
    onLayout: (event: LayoutChangeEvent) => { current.height = event.nativeEvent.layout.height; },
    onContentSizeChange: (_width: number, height: number) => { current.layoutChanged = current.content !== height; current.content = height; },
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const moved = Math.abs(current.offset - contentOffset.y) > 0.5;
      current.offset = contentOffset.y; current.content = contentSize.height; current.height = layoutMeasurement.height;
      if (current.layoutChanged) { current.layoutChanged = false; return; }
      if (moved && current.armed && Date.now() - current.lastGesture < 2500) check();
    } },
  };
}
