import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, StyleSheet, TextInput } from 'react-native';
import { keyboardScrollDelta } from './keyboardVisibility';

type Input = React.ComponentRef<typeof TextInput>;
type Visibility = { focus: (input: Input) => void; blur: (input: Input) => void; changed: () => void; inputHeight?: number };
export const KeyboardVisibility = createContext<Visibility | null>(null);

// Resize ancestors own keyboard avoidance. This scroller only reveals the focused
// descendant and adds the overlap that remains in edge-to-edge Android windows.
export default function KeyboardScrollView({ ref, children, contentContainerStyle, onLayout, onScroll, onScrollBeginDrag, onContentSizeChange, ...props }: React.ComponentPropsWithRef<typeof ScrollView>) {
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null), focused = useRef<Input | null>(null), offset = useRef(0);
  const frame = useRef<number | null>(null), alive = useRef(true), revision = useRef(0);
  const settled = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [overlap, setOverlap] = useState(0);
  const [inputHeight, setInputHeight] = useState<number>();
  const manuallyScrolled = useRef(false);
  React.useImperativeHandle(ref, () => scroll.current!, []);
  const reveal = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const version = ++revision.current;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const container = scroll.current, input = focused.current;
      if (!container || !input?.isFocused() || manuallyScrolled.current) return;
      container.measureInWindow((_x, top, _width, height) => {
        if (!alive.current || version !== revision.current || focused.current !== input) return;
        // iOS page sheets measure within their own window. Their KAV already
        // resizes it; screen-relative keyboard coordinates cannot be mixed in.
        const keyboardTop = Platform.OS === 'android' ? Keyboard.metrics()?.screenY ?? Infinity : Infinity;
        const bottom = Math.min(top + height, keyboardTop);
        const nextOverlap = Math.max(0, top + height - bottom);
        setOverlap(previous => Math.abs(previous - nextOverlap) < 1 ? previous : nextOverlap);
        setInputHeight(Math.max(44, bottom - top - 24));
        input.measureInWindow((_ix, y, _iw, inputHeight) => {
          if (!alive.current || version !== revision.current || focused.current !== input || !input.isFocused()) return;
          const delta = keyboardScrollDelta(top, bottom, y, inputHeight);
          if (delta) container.scrollTo({ y: Math.max(0, offset.current + delta), animated: false });
        });
      });
    });
  }, []);
  const revealAfterMotion = useCallback(() => {
    reveal();
    if (settled.current !== null) clearTimeout(settled.current);
    // Native sheets can move their window after focus/IME events without a
    // React layout event. Measure once more after that presentation finishes.
    settled.current = setTimeout(reveal, 350);
  }, [reveal]);
  const visibility = useMemo<Visibility>(() => ({
    focus(input) { manuallyScrolled.current = false; focused.current = input; revealAfterMotion(); },
    blur(input) { if (focused.current === input) { focused.current = null; revision.current++; if (settled.current !== null) clearTimeout(settled.current); } },
    changed() { manuallyScrolled.current = false; reveal(); },
  }), [reveal, revealAfterMotion]);
  useEffect(() => {
    alive.current = true;
    const shown = Keyboard.addListener('keyboardDidShow', revealAfterMotion);
    const changed = Keyboard.addListener('keyboardWillChangeFrame', revealAfterMotion);
    const hidden = Keyboard.addListener('keyboardDidHide', () => { setOverlap(0); setInputHeight(undefined); reveal(); });
    return () => {
      alive.current = false; revision.current++;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (settled.current !== null) clearTimeout(settled.current);
      shown.remove(); changed.remove(); hidden.remove();
    };
  }, [reveal, revealAfterMotion]);
  const style = StyleSheet.flatten(contentContainerStyle);
  const padding = style?.paddingBottom ?? style?.paddingVertical ?? style?.padding ?? 0;
  const value = useMemo(() => ({ ...visibility, inputHeight }), [visibility, inputHeight]);
  return <KeyboardVisibility.Provider value={value}><ScrollView {...props} ref={scroll}
    keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? 'handled'} scrollEventThrottle={props.scrollEventThrottle ?? 16}
    contentContainerStyle={[contentContainerStyle, overlap > 0 && { paddingBottom: (typeof padding === 'number' ? padding : 0) + overlap + 12 }]}
    onLayout={event => { onLayout?.(event); reveal(); }}
    onScroll={event => { offset.current = event.nativeEvent.contentOffset.y; onScroll?.(event); }}
    onScrollBeginDrag={event => { manuallyScrolled.current = true; revision.current++; onScrollBeginDrag?.(event); }}
    onContentSizeChange={(width, height) => { onContentSizeChange?.(width, height); reveal(); }}>
    {children}
  </ScrollView></KeyboardVisibility.Provider>;
}
