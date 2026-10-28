let scheduled = 0;
const running = new Map<HTMLElement, Animation>();
let preference: MediaQueryList | undefined;
function stop() {
  if (scheduled) cancelAnimationFrame(scheduled);
  scheduled = 0;
  for (const animation of running.values()) animation.cancel();
  running.clear();
}

// Capture visual bounds before React commits, then measure without our previous
// effects. WAAPI leaves the component's inline transform and opacity untouched.
export function animateLayout(enabled: boolean) {
  if (typeof document === 'undefined') return;
  if (!preference && typeof window.matchMedia === 'function') {
    preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    preference.addEventListener('change', event => { if (event.matches) stop(); });
  }
  if (!enabled || preference?.matches) { stop(); return; }
  if (scheduled) return;
  const scope = [...document.querySelectorAll('[role="dialog"]')].at(-1) ?? document.querySelector('form') ?? document.querySelector('[role="main"]');
  const selector = 'button, [role="button"], [role="checkbox"], [role="radio"], input, textarea';
  const controls = () => scope ? [...scope.querySelectorAll<HTMLElement>(selector)].filter(node => !node.parentElement?.closest(selector)) : [];
  const before = new Map(controls().map(node => [node, { rect: node.getBoundingClientRect(), opacity: getComputedStyle(node).opacity }]));
  stop();
  scheduled = requestAnimationFrame(() => {
    scheduled = 0;
    if (preference?.matches) return;
    for (const node of controls()) {
      if (!node.isConnected || typeof node.animate !== 'function') continue;
      const previous = before.get(node), next = node.getBoundingClientRect(), style = getComputedStyle(node);
      const x = previous ? previous.rect.left - next.left : 0, y = previous ? previous.rect.top - next.top : 0;
      const from: Keyframe = {}, to: Keyframe = {};
      if (Math.abs(x) + Math.abs(y) > 0.5) {
        const base = style.transform === 'none' ? '' : style.transform;
        from.transform = `translate(${x}px, ${y}px) ${base}`.trim();
        to.transform = style.transform;
      }
      if (!previous || Math.abs(Number(previous.opacity) - Number(style.opacity)) > 0.01) {
        from.opacity = previous?.opacity ?? 0; to.opacity = style.opacity;
      }
      if (!Object.keys(from).length) continue;
      const animation = node.animate([from, to], { duration: 180, easing: 'ease-out' });
      running.set(node, animation);
      animation.onfinish = () => {
        if (running.get(node) === animation) running.delete(node);
        animation.cancel();
      };
    }
  });
}
