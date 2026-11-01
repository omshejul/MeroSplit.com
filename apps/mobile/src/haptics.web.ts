import { WebHaptics } from 'web-haptics';

let haptics: WebHaptics | undefined;
export function tapHaptic(): void {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined' || document.visibilityState === 'hidden' || !window.matchMedia('(any-pointer: coarse)').matches) return;
    haptics ??= new WebHaptics({ debug: false, showSwitch: false });
    void haptics.trigger('selection').catch(() => {});
  } catch { /* Haptics must never prevent the action. */ }
}
