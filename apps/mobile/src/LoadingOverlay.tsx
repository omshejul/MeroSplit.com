import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { Portal, useTheme } from 'react-native-paper';

const Loading = createContext({ active: false, start: () => () => {} });

// Each operation releases only its own request, including on screen removal.
export function useLoading(active: boolean) {
  const { start } = useContext(Loading);
  useEffect(() => active ? start() : undefined, [active, start]);
}

export function LoadingProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);
  const start = useCallback(() => {
    setCount(value => value + 1);
    return () => setCount(value => value - 1);
  }, []);
  const active = count > 0, value = useMemo(() => ({ active, start }), [active, start]);
  return <Loading.Provider value={value}>{children}<LoadingOverlay /></Loading.Provider>;
}

// Native sheets have their own window, so they render the same overlay inline.
export default function LoadingOverlay({ inline = false }: { inline?: boolean }) {
  const { active } = useContext(Loading), { colors } = useTheme();
  useEffect(() => {
    if (!active || Platform.OS !== 'web') return;
    const block = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    document.addEventListener('keydown', block, true);
    return () => document.removeEventListener('keydown', block, true);
  }, [active]);
  if (!active) return null;
  const overlay = <View testID="loading-overlay" accessibilityViewIsModal aria-modal accessibilityRole="progressbar" accessibilityLabel="Loading" accessibilityState={{ busy: true }}
    onStartShouldSetResponder={() => true} style={styles.overlay}>
    <View style={[styles.spinner, { backgroundColor: colors.surface }]}><ActivityIndicator size="large" color={colors.primary} /></View>
  </View>;
  return inline ? overlay : <Portal>{overlay}</Portal>;
}
const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  spinner: { padding: 24, borderRadius: 16 },
});
