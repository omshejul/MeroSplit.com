import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Platform } from 'react-native';

export type MotionPreference = { enabled: boolean; active: boolean };
export const motionDuration = { navigation: 180, feedback: 180, paperScale: 0.75 } as const;

export type MotionRoute = { scope: string; screen: string; tab: string; group: string | null; record: string | null; allowed: boolean };
const tabOrder = ['Groups', 'Friends', 'Activity', 'Account'];
const forms = ['create', 'expense', 'settle', 'import'];
const depths: Record<string, number> = { home: 0, group: 1, expenseDetail: 2, paymentDetail: 2, members: 2, review: 2, billChat: 3 };
export function routeOffset(previous: MotionRoute, next: MotionRoute) {
  const still = { x: 0, y: 0 };
  if (!previous.allowed || !next.allowed || previous.scope !== next.scope || previous.group && !next.group) return still;
  if (previous.screen === next.screen && previous.group === next.group && previous.record === next.record) {
    if (next.screen !== 'home' || previous.tab === next.tab) return still;
    return { x: Math.sign(tabOrder.indexOf(next.tab) - tabOrder.indexOf(previous.tab)) * 16, y: 0 };
  }
  if (forms.includes(next.screen)) return { x: 0, y: 24 };
  if (forms.includes(previous.screen)) return { x: 0, y: -24 };
  return { x: (depths[next.screen] ?? 0) < (depths[previous.screen] ?? 0) ? -24 : 24, y: 0 };
}

// One current scene, never an outgoing snapshot. Children/state are not keyed by motion.
export function useRouteMotion(route: MotionRoute, enabled: boolean) {
  const [position] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const previous = useRef(route), running = useRef(false), revision = useRef(0);
  useLayoutEffect(() => {
    const offset = routeOffset(previous.current, route), generation = ++revision.current;
    previous.current = route;
    position.stopAnimation();
    if (enabled && (offset.x || offset.y)) {
      // Rapid navigation continues from the current position; no queued exits or resets.
      if (!running.current) position.setValue(offset);
      running.current = true;
      Animated.timing(position, { toValue: { x: 0, y: 0 }, duration: motionDuration.navigation, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web', isInteraction: false }).start(() => { if (revision.current === generation) running.current = false; });
    } else { position.setValue({ x: 0, y: 0 }); running.current = false; }
    return () => { ++revision.current; position.stopAnimation(); };
  }, [route.scope, route.screen, route.tab, route.group, route.record, route.allowed, enabled, position]);
  return position;
}

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
