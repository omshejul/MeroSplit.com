import { useEffect, useRef } from 'react';

// RN Web's RefreshControl is a no-op. Only claim a downward touch that starts
// at the top of every scroll ancestor, outside dialogs and editable controls.
export function usePullToRefresh(enabled: boolean, refresh: () => void): void {
  const latest = useRef(refresh); latest.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let origin: { x: number; y: number } | null = null, distance = 0;
    const reset = () => { origin = null; distance = 0; };
    const start = (event: TouchEvent) => {
      reset();
      if (event.touches.length !== 1 || !(event.target instanceof Element) || event.target.closest('input,textarea,button,[role="button"],[role="dialog"],[role="menu"],[contenteditable="true"]')) return;
      for (let node: Element | null = event.target; node; node = node.parentElement) if (node.scrollTop > 0) return;
      origin = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const move = (event: TouchEvent) => {
      if (!origin || event.touches.length !== 1) { reset(); return; }
      const touch = event.touches[0], dy = touch.clientY - origin.y;
      if (dy < 0 || Math.abs(touch.clientX - origin.x) > 30) { reset(); return; }
      distance = dy;
      if (dy > 10 && event.cancelable) event.preventDefault();
    };
    const end = () => { const trigger = !!origin && distance >= 72; reset(); if (trigger) latest.current(); };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end); document.addEventListener('touchcancel', reset);
    return () => {
      document.removeEventListener('touchstart', start); document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', reset);
    };
  }, [enabled]);
}
