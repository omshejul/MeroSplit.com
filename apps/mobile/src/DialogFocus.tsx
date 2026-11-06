import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

import { useDialogMotion } from './useDialogMotion';

// Paper portals can overlap. Only the latest dialog owns browser keyboard focus.
const dialogs: HTMLElement[] = [];
const visibleDialogs = new Set<object>();
const dialogListeners = new Set<() => void>();
export function hasOpenDialogs() { return visibleDialogs.size > 0; }
export function subscribeDialogs(listener: () => void) { dialogListeners.add(listener); return () => { dialogListeners.delete(listener); }; }
// Share restart safety with primitives that already own browser focus.
export function useDialogRegistration(active: boolean, modal = true) {
  useLayoutEffect(() => {
    if (!active || !modal) return;
    const dialog = {}; visibleDialogs.add(dialog); dialogListeners.forEach(listener => listener());
    return () => { visibleDialogs.delete(dialog); dialogListeners.forEach(listener => listener()); };
  }, [active, modal]);
}
export default function DialogFocus({ active = true, busy = false, onEscape, children, style, label, modal = true, animate = true, interactive = true }: {
  interactive?: boolean; animate?: boolean; modal?: boolean; label?: string; active?: boolean; busy?: boolean; onEscape?: () => void; children: React.ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const body = useRef<React.ComponentRef<typeof View>>(null), actions = useRef({ busy, onEscape, interactive });
  actions.current = { busy, onEscape, interactive };
  useDialogMotion(body, active && animate);
  useDialogRegistration(active, modal);
  useEffect(() => {
    if (Platform.OS !== 'web' || !active) return;
    let root: HTMLElement | null = null;
    const trigger = document.activeElement as HTMLElement | null;
    const targets = () => [...(root?.querySelectorAll<HTMLElement>('button, [role="button"], input, textarea, select, [tabindex="0"]') ?? [])]
      .filter(node => node.getAttribute('aria-disabled') !== 'true' && !node.hasAttribute('disabled') && node.getClientRects().length > 0);
    const focus = () => (targets()[0] ?? root)?.focus({ preventScroll: true });
    const ownsFocus = () => !!root && dialogs.at(-1) === root;
    const focusin = (event: FocusEvent) => { if (ownsFocus() && !root!.contains(event.target as Node)) focus(); };
    const click = (event: MouseEvent) => { if (ownsFocus() && !actions.current.interactive) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const keydown = (event: KeyboardEvent) => {
      if (!ownsFocus()) return;
      if (!actions.current.interactive) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!actions.current.busy) actions.current.onEscape?.();
        return;
      }
      const outside = !root!.contains(document.activeElement);
      if (outside) { event.preventDefault(); event.stopImmediatePropagation(); focus(); return; }
      if (event.key !== 'Tab') return;
      const items = targets(), first = items[0], last = items.at(-1);
      if (!first || event.shiftKey && document.activeElement === first || !event.shiftKey && (document.activeElement === last || document.activeElement === root)) {
        event.preventDefault(); (event.shiftKey ? last ?? root : first ?? root)?.focus();
      }
    };
    // A removed focused input does not emit focusin. Keep dynamic dialog steps contained.
    const observer = new MutationObserver(() => { if (ownsFocus() && !root!.contains(document.activeElement)) focus(); });
    const frame = requestAnimationFrame(() => {
      root = body.current as unknown as HTMLElement | null;
      if (!root) return;
      dialogs.push(root); focus(); observer.observe(root, { childList: true, subtree: true });
      document.addEventListener('focusin', focusin, true); document.addEventListener('keydown', keydown, true); document.addEventListener('click', click, true);
    });
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('focusin', focusin, true); document.removeEventListener('keydown', keydown, true); document.removeEventListener('click', click, true);
      const index = root ? dialogs.indexOf(root) : -1; if (index >= 0) dialogs.splice(index, 1);
      if (trigger?.isConnected && (!dialogs.length || dialogs.at(-1)!.contains(trigger))) trigger.focus({ preventScroll: true });
    };
  }, [active]);
  return <View ref={body} pointerEvents={interactive ? 'auto' : 'none'} accessibilityElementsHidden={Platform.OS === 'web' ? undefined : !interactive} importantForAccessibility={Platform.OS === 'web' ? undefined : interactive ? 'auto' : 'no-hide-descendants'} role={label ? 'dialog' : undefined} aria-modal={label ? true : undefined} accessibilityLabel={label} tabIndex={-1} style={[{ flexShrink: 1 }, style]}>{children}</View>;
}
