import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform } from 'react-native';

// Own only this dialog's paint and lifetime. Never animate a global layout transaction.
export function useDialogTransition(visible: boolean, enabled: boolean) {
  const [present, setPresent] = useState(visible);
  const progress = useRef(new Animated.Value(visible && !enabled ? 1 : 0)).current;
  const latest = useRef(visible); latest.current = visible;
  useEffect(() => {
    if (visible && !present) { progress.setValue(enabled ? 0 : 1); setPresent(true); return; }
    if (!present) return;
    progress.stopAnimation();
    if (!enabled) { progress.setValue(visible ? 1 : 0); if (!visible) setPresent(false); return; }
    const animation = Animated.timing(progress, { toValue: visible ? 1 : 0, duration: visible ? 180 : 140,
      easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web', isInteraction: false });
    animation.start(({ finished }) => { if (finished && !latest.current) setPresent(false); });
    return () => animation.stop();
  }, [visible, present, enabled, progress]);
  return { present, opacity: progress, translateY: enabled ? progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) : 0 };
}

// The scroller reports natural content size even while its viewport is resizing.
export function useDialogBodySize(limit: number, enabled: boolean) {
  const height = useRef(new Animated.Value(0)).current, natural = useRef(0), target = useRef(0);
  const animation = useRef<Animated.CompositeAnimation | null>(null), measured = useRef(false);
  const [ready, setReady] = useState(false);
  function resize(contentHeight: number) {
    if (!measured.current && contentHeight <= 0) return;
    natural.current = contentHeight;
    const next = Math.max(0, Math.min(limit, contentHeight));
    if (measured.current && Math.abs(target.current - next) < 1) return;
    animation.current?.stop(); target.current = next;
    if (!measured.current || !enabled) height.setValue(next);
    else {
      animation.current = Animated.timing(height, { toValue: next, duration: 180,
        easing: Easing.out(Easing.cubic), useNativeDriver: false, isInteraction: false });
      animation.current.start();
    }
    measured.current = true; setReady(true);
  }
  useEffect(() => { if (measured.current) { if (!enabled) { animation.current?.stop(); target.current = Math.max(0, Math.min(limit, natural.current)); height.setValue(target.current); } else resize(natural.current); } }, [limit, enabled]);
  useEffect(() => () => animation.current?.stop(), []);
  return { height: ready ? height : undefined, onContentSizeChange: (_width: number, value: number) => resize(value) };
}
