import React, { createContext, useCallback, useContext, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Portal, Snackbar } from 'react-native-paper';

const ToastContext = createContext<(message: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const { bottom } = useSafeAreaInsets();
  const notify = useCallback((message: string) => setToast(previous => ({ id: (previous?.id ?? 0) + 1, message })), []);
  return <ToastContext.Provider value={notify}>{children}<Portal>
    {toast && <Snackbar key={toast.id} visible duration={2800} onDismiss={() => setToast(null)}
      wrapperStyle={{ bottom: bottom + 12, left: 12, right: 12 }}
      style={{ borderRadius: 8, maxWidth: 520, alignSelf: 'center' }} accessibilityLiveRegion="polite">{toast.message}</Snackbar>}
  </Portal></ToastContext.Provider>;
}
