import type { AppearancePreference } from './native';
import { defaultColorFamily, isColorFamily, type ColorFamily } from './theme';

function preference(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
export function initialBrowserAppearance(): AppearancePreference {
  const value = preference('merosplit.web.appearance');
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function initialBrowserColorFamily(): ColorFamily {
  const value = preference('merosplit.web.colorFamily');
  return isColorFamily(value) ? value : defaultColorFamily;
}
export function syncBrowserTheme(background: string, dark: boolean): void {
  document.documentElement.style.backgroundColor = background;
  document.body.style.backgroundColor = background;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
  document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', dark ? 'black-translucent' : 'default');
}
