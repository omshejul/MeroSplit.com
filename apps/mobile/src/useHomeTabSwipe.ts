import { useLayoutEffect, useMemo, useRef } from 'react';
import { Animated, I18nManager, PanResponder, Platform, TextInput, useWindowDimensions } from 'react-native';

import { useUI } from './ui';

const tabs = ['Groups', 'Friends', 'Activity', 'Account'];

// Only HomeTabs installs these handlers. Detail screens keep native back gestures.
export function useHomeTabSwipe(selected: string, busy: boolean, onSelect: (tab: string) => void) {
  const { width } = useWindowDimensions();
  const { motion } = useUI();
  const translateX = useRef(new Animated.Value(0)).current;
  const entryTab = useRef<string | null>(null);
  const latest = useRef({ selected, busy, onSelect, width, animate: motion.enabled });
  latest.current = { selected, busy, onSelect, width, animate: motion.enabled };
  const gesture = useRef({ vertical: false, selected, startX: 0 });
  useLayoutEffect(() => {
    if (busy) gesture.current.selected = '';
    translateX.stopAnimation();
    const slide = !busy && motion.enabled && entryTab.current === selected;
    entryTab.current = null;
    translateX.setValue(slide ? -64 : 0);
    if (slide) Animated.timing(translateX, { toValue: 0, duration: 160, useNativeDriver: Platform.OS !== 'web', isInteraction: false }).start();
    return () => translateX.stopAnimation();
  }, [selected, busy, motion.enabled, translateX]);
  const responder = useMemo(() => {
    const reset = () => {
      translateX.stopAnimation();
      translateX.setValue(0);
    };
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: event => {
        // PanResponder leaves x0 at zero until grant, after this capture check.
        gesture.current.startX = event.nativeEvent.touches[0]?.pageX ?? event.nativeEvent.pageX;
        gesture.current.vertical = false;
        gesture.current.selected = latest.current.selected;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_event, state) => {
        const current = latest.current;
        if (Math.abs(state.dy) > 12 && Math.abs(state.dy) >= Math.abs(state.dx)) gesture.current.vertical = true;
        const delta = state.dx * (I18nManager.isRTL ? -1 : 1), index = tabs.indexOf(current.selected);
        const editing = Platform.OS === 'web' ? TextInput.State.currentlyFocusedField() : TextInput.State.currentlyFocusedInput();
        return !current.busy && !gesture.current.vertical && !editing
          && state.numberActiveTouches === 1 && gesture.current.startX > 24 && gesture.current.startX < current.width - 24
          && Math.abs(state.dx) > 16 && Math.abs(state.dx) > Math.abs(state.dy) * 1.8
          && index >= 0 && (delta < 0 ? index < tabs.length - 1 : index > 0);
      },
      onPanResponderGrant: reset,
      onPanResponderMove: (_event, state) => {
        if (state.numberActiveTouches > 1) gesture.current.vertical = true;
        const current = latest.current;
        if (current.animate && !current.busy && !gesture.current.vertical && current.selected === gesture.current.selected) {
          translateX.setValue(Math.max(0, Math.min(80, state.dx * 0.35)));
        } else reset();
      },
      onPanResponderRelease: (_event, state) => {
        const current = latest.current, direction = state.dx < 0 ? 1 : -1;
        const target = tabs[tabs.indexOf(current.selected) + direction * (I18nManager.isRTL ? -1 : 1)];
        if (!current.busy && !gesture.current.vertical && current.selected === gesture.current.selected && target && Math.abs(state.dx) > Math.abs(state.dy) * 1.8
          && (Math.abs(state.dx) >= Math.min(90, current.width * 0.22) || Math.abs(state.dx) > 30 && state.vx * state.dx > 0 && Math.abs(state.vx) > 0.5)) {
          if (state.dx > 0 && current.animate) entryTab.current = target;
          current.onSelect(target);
        } else reset();
      },
      onPanResponderTerminate: reset,
      onPanResponderTerminationRequest: () => true,
    });
  }, [translateX]);
  return {
    content: { ...responder.panHandlers, style: { flex: 1, transform: [{ translateX }] } },
    selectTab: (tab: string) => {
      entryTab.current = null;
      onSelect(tab);
    },
  };
}
