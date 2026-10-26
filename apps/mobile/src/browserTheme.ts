import type { AppearancePreference } from './native';
import type { ColorFamily } from './theme';

export const initialBrowserAppearance = (): AppearancePreference => 'system';
export const initialBrowserColorFamily = (): ColorFamily => 'basic';
export function syncBrowserTheme(_background: string, _dark: boolean): void {}
