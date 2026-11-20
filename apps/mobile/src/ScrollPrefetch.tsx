import React, { createContext, useContext, useEffect, useRef } from 'react';
import { View } from 'react-native';

type Viewport = { bottom: number; listeners: Set<() => void> };
export const ScrollPrefetch = createContext<Viewport | null>(null);

// Each section watches its own end, even when another section follows it.
export function PrefetchTrigger({ enabled, onApproach }: { enabled: boolean; onApproach: () => void }) {
  const viewport = useContext(ScrollPrefetch), marker = useRef<React.ComponentRef<typeof View>>(null);
  const requested = useRef(false), measuring = useRef(false);
  useEffect(() => {
    let live = true;
    function check() {
      if (!enabled || !viewport?.bottom || requested.current || measuring.current) return;
      measuring.current = true;
      marker.current?.measureInWindow((_x, y, _width, height) => {
        measuring.current = false;
        if (live && !requested.current && height > 0 && y <= viewport.bottom + 600) {
          requested.current = true;
          onApproach();
        }
      });
    }
    viewport?.listeners.add(check);
    check();
    return () => { live = false; measuring.current = false; viewport?.listeners.delete(check); };
  }, [viewport, enabled, onApproach]);
  return <View ref={marker} collapsable={false} onLayout={() => viewport?.listeners.forEach(check => check())} style={{ height: 1 }} accessible={false} />;
}
