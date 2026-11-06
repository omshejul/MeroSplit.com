import type { AppearancePreference } from './native';
import { defaultColorFamily, type ColorFamily } from './theme';

export const initialBrowserAppearance = (): AppearancePreference => 'system';
export const initialBrowserColorFamily = (): ColorFamily => defaultColorFamily;
export function syncBrowserTheme(_background: string, _dark: boolean): void {}
