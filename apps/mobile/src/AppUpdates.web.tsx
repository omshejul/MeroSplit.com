// Browser updates are handled by the app shell, with no native update controls.
export default function AppUpdates(_props: { busy: boolean; online: boolean; onRestart: (reload: () => Promise<void>) => Promise<void> }) {
  return null;
}
