import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { appIconFromNative, appIcons, nativeIconName, resolveAppIcon, type AppIconChoice, type AppIconId } from './appIcons';
import { savedAppIcon } from './native';
import type { ColorFamily } from './theme';

type AppIconModule = { getAvailableIcons(): Promise<string[]>; getIconName(): Promise<string | null>; setIconName(name: string | null): Promise<void> };
// Missing on Android, on the web, and in builds made before app icons shipped.
const native = Platform.OS === 'ios' ? requireOptionalNativeModule<AppIconModule>('MeroSplitAppIcon') : null;

/** Icons this build can show, primary first. Empty when the icon cannot change. */
export async function availableAppIcons(): Promise<AppIconId[]> {
  if (!native) return [];
  const names = new Set(await native.getAvailableIcons());
  if (!names.size) return [];
  return appIcons.map(icon => icon.id).filter(id => { const name = nativeIconName(id); return name === null || names.has(name); });
}

export async function shownAppIcon(): Promise<AppIconId | null> {
  return native ? appIconFromNative(await native.getIconName()) : null;
}

let queue: Promise<void> = Promise.resolve();
/** Shows the icon for this choice and color. iOS alerts after every change,
 *  so call this once a choice is final, never on each tap. */
export function applyAppIcon(choice: AppIconChoice, family: ColorFamily): Promise<void> {
  const run = queue.catch(() => {}).then(async () => {
    if (!native) return;
    const name = nativeIconName(resolveAppIcon(choice, family));
    if (await native.getIconName() !== name) await native.setIconName(name);
  });
  queue = run;
  return run;
}

/** After Appearance closes, a Match color icon follows the new color. */
export async function syncAppIcon(family: ColorFamily): Promise<void> {
  if (!native || !(await native.getAvailableIcons()).length) return;
  const choice = await savedAppIcon();
  if (choice === 'match') await applyAppIcon(choice, family);
}
