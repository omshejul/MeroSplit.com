import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { animate } from 'framer-motion';
export { observeMotionPreference, motionDuration, type MotionPreference } from './motionShared';

// Preserve React Native styles and semantics; Framer drives web transitions.
export function useMotionValue(target: number, enabled: boolean) {
  const [value] = useState(() => new Animated.Value(target));
  const current = useRef(target), previous = useRef(target);
  useEffect(() => {
    if (!enabled || previous.current === target) {
      current.current = target;
      value.setValue(target);
      previous.current = target;
      return;
    }
    previous.current = target;
    const animation = animate(current.current, target, {
      duration: 0.18, ease: 'easeOut',
      onUpdate: next => { current.current = next; value.setValue(next); },
    });
    return () => animation.stop();
  }, [target, enabled, value]);
  return value;
}
