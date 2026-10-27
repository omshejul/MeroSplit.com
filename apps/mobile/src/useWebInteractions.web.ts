import { useEffect } from 'react';
import { animate } from 'framer-motion';

const controls = 'button, a[href], [role="button"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], summary';

// Delegation includes Paper controls, list rows, tabs and controls mounted in portals.
export function useWebInteractions(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    type Feedback = { animation: ReturnType<typeof animate>; transform: string; opacity: string };
    const running = new Map<HTMLElement, Feedback>();
    const restore = (element: HTMLElement, entry: Feedback) => {
      entry.animation.cancel();
      element.style.transform = entry.transform;
      element.style.opacity = entry.opacity;
    };
    let pressed: HTMLElement | null = null;
    const find = (event: Event) => event.target instanceof Element ? event.target.closest<HTMLElement>(controls) : null;
    const usable = (element: HTMLElement | null): element is HTMLElement => !!element && !element.matches(':disabled, [aria-disabled="true"]') && !element.closest('[inert], [aria-disabled="true"]');
    function feedback(element: HTMLElement, scale: number, opacity: number) {
      const previous = running.get(element);
      previous?.animation.stop();
      const original = previous ?? { transform: element.style.transform, opacity: element.style.opacity };
      const animation = animate(element, { scale, opacity }, { duration: 0.18, ease: 'easeOut' });
      running.set(element, { ...original, animation });
      void animation.then(() => {
        if (running.get(element)?.animation !== animation || scale !== 1 || opacity !== 1) return;
        restore(element, running.get(element)!);
        running.delete(element);
      });
    }
    function pulse(event: Event) {
      const element = event.type === 'change' && event.target instanceof HTMLElement && event.target.matches('input, textarea, select') ? event.target : find(event);
      if (!usable(element)) return;
      const previous = running.get(element);
      previous?.animation.stop();
      const original = previous ?? { transform: element.style.transform, opacity: element.style.opacity };
      const animation = animate(element, { scale: [1, 0.955, 1], opacity: [1, 0.78, 1] }, { duration: 0.2, ease: 'easeOut' });
      running.set(element, { ...original, animation });
      void animation.then(() => {
        if (running.get(element)?.animation !== animation) return;
        restore(element, running.get(element)!); running.delete(element);
      });
    }
    function down(event: Event) {
      if (event instanceof PointerEvent && (!event.isPrimary || event.button !== 0)) return;
      if (event instanceof KeyboardEvent && (event.repeat || !['Enter', ' '].includes(event.key))) return;
      const element = find(event);
      if (usable(element)) { pressed = element; feedback(element, 0.98, 0.8); }
    }
    function release() {
      if (pressed) { feedback(pressed, 1, 1); pressed = null; }
    }
    function hover(event: PointerEvent) {
      if (event.pointerType !== 'mouse' || pressed) return;
      const element = find(event);
      if (usable(element) && !(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) feedback(element, 1.015, 0.9);
    }
    function leave(event: PointerEvent) {
      const element = find(event);
      if (element && element !== pressed && !(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) feedback(element, 1, 1);
    }
    document.addEventListener('click', pulse, true);
    document.addEventListener('change', pulse, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    document.addEventListener('keydown', down, true);
    document.addEventListener('keyup', release, true);
    document.addEventListener('pointerover', hover, true);
    document.addEventListener('pointerout', leave, true);
    window.addEventListener('blur', release);
    return () => {
      document.removeEventListener('click', pulse, true);
      document.removeEventListener('change', pulse, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      document.removeEventListener('keydown', down, true);
      document.removeEventListener('keyup', release, true);
      document.removeEventListener('pointerover', hover, true);
      document.removeEventListener('pointerout', leave, true);
      window.removeEventListener('blur', release);
      running.forEach((entry, element) => restore(element, entry));
      running.clear();
    };
  }, [enabled]);
}
