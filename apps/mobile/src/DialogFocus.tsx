import React, { useEffect, useRef } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

// Paper portals can overlap. Only the latest dialog owns browser keyboard focus.
const dialogs: HTMLElement[] = [];
export default function DialogFocus({ active = true, busy = false, onEscape, children, style }: {
  active?: boolean; busy?: boolean; onEscape?: () => void; children: React.ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const body = useRef<React.ComponentRef<typeof View>>(null), actions = useRef({ busy, onEscape });
  actions.current = { busy, onEscape };
  useEffect(() => {
    if (Platform.OS !== 'web' || !active) return;
    let root: HTMLElement | null = null;
    const trigger = document.activeElement as HTMLElement | null;
    const targets = () => [...(root?.querySelectorAll<HTMLElement>('button, [role="button"], input, textarea, select, [tabindex="0"]') ?? [])]
      .filter(node => node.getAttribute('aria-disabled') !== 'true' && !node.hasAttribute('disabled') && node.getClientRects().length > 0);
    const focus = () => (targets()[0] ?? root)?.focus({ preventScroll: true });
    const ownsFocus = () => !!root && dialogs.at(-1) === root;
    const focusin = (event: FocusEvent) => { if (ownsFocus() && !root!.contains(event.target as Node)) focus(); };
    const keydown = (event: KeyboardEvent) => {
      if (!ownsFocus()) return;
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
    const frame = requestAnimationFrame(() => {
      root = body.current as unknown as HTMLElement | null;
      if (!root) return;
      dialogs.push(root); focus();
      document.addEventListener('focusin', focusin, true); document.addEventListener('keydown', keydown, true);
    });
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener('focusin', focusin, true); document.removeEventListener('keydown', keydown, true);
      const index = root ? dialogs.indexOf(root) : -1; if (index >= 0) dialogs.splice(index, 1);
      if (trigger?.isConnected && (!dialogs.length || dialogs.at(-1)!.contains(trigger))) trigger.focus({ preventScroll: true });
    };
  }, [active]);
  return <View ref={body} tabIndex={-1} style={[{ flexShrink: 1 }, style]}>{children}</View>;
}
