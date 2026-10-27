import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Platform } from 'react-native';

export type MotionPreference = { enabled: boolean; active: boolean };
export const motionDuration = { feedback: 180, paperScale: 0.75 } as const;

// RN Web maps these APIs to live matchMedia and document visibility events.
export function observeMotionPreference(onChange: (value: MotionPreference) => void) {
  let mounted = true, revision = 0, reduced = true, active = AppState.currentState === 'active';
  const publish = () => { if (mounted) onChange({ enabled: active && !reduced, active }); };
  function read() {
    const pending = ++revision;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (!mounted || pending !== revision) return;
      reduced = value; publish();
    }).catch(() => { /* Keep motion disabled when the preference is unavailable. */ });
  }
  const preference = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
    ++revision; reduced = value; publish();
  });
  const visibility = AppState.addEventListener('change', value => {
    active = value === 'active';
    if (active) { reduced = true; read(); }
    publish();
  });
  publish(); read();
  return () => { mounted = false; ++revision; preference?.remove(); visibility?.remove(); };
}

// Small feedback/disclosure transforms only. Never interpolate financial amounts.
export function useMotionValue(target: number, enabled: boolean) {
  const [value] = useState(() => new Animated.Value(target));
  const previous = useRef(target);
  useEffect(() => {
    value.stopAnimation();
    if (enabled && previous.current !== target) {
      Animated.timing(value, { toValue: target, duration: motionDuration.feedback, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web', isInteraction: false }).start();
    } else value.setValue(target);
    previous.current = target;
    return () => { value.stopAnimation(); };
  }, [target, enabled, value]);
  return value;
}
