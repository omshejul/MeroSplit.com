import type { AppUpdateState } from './useAppUpdates';

// Browser updates are handled by the app shell, with no native update controls.
export default function AppUpdates(_props: { update: AppUpdateState }) { return null; }
export function AppUpdatePrompt(_props: { update: AppUpdateState }) { return null; }
