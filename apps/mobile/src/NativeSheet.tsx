import React, { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StackActions, useNavigation, useRoute, usePreventRemove, type NavigationAction } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { createNativeSheetStore } from './nativeSheetStore';
import type { Routes } from './routes';
import { Button } from './ui';

type Entry = { children: React.ReactNode; disabled: boolean; onDismiss: () => void };
const Sheets = createContext<ReturnType<typeof createNativeSheetStore<Entry>> | null>(null);

export function NativeSheetProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(() => createNativeSheetStore<Entry>());
  return <Sheets.Provider value={store}>{children}</Sheets.Provider>;
}

// Only the sheet screen subscribes. Publishing controlled fields must not rerender their owner.
export default function NativeSheet({ visible, disabled, onDismiss, children }: Entry & { visible: boolean }) {
  const store = useContext(Sheets), navigation = useNavigation<NativeStackNavigationProp<Routes>>(), route = useRoute();
  const id = useId(), latest = useRef({ children, disabled, onDismiss });
  latest.current = { children, disabled, onDismiss };
  useLayoutEffect(() => {
    if (!visible || !store) return;
    store.set(id, latest.current);
    navigation.dispatch(StackActions.push('sheet', { ...route.params, sheetId: id, ownerKey: route.key }));
    return () => {
      const registered = store.get(id);
      store.remove(id);
      if (!registered) return;
      const state = navigation.getState(), top = state.routes[state.index];
      if (top.name === 'sheet' && top.params?.sheetId === id) navigation.dispatch({ ...StackActions.pop(1), source: top.key, target: state.key });
    };
  }, [visible, store, id, navigation, route.key]);
  useLayoutEffect(() => { if (visible && store?.get(id)) store.set(id, latest.current); });
  return null;
}

export function NativeSheetScreen({ route, navigation, blocked }: NativeStackScreenProps<Routes, 'sheet'> & { blocked: boolean }) {
  const store = useContext(Sheets), id = route.params?.sheetId ?? '';
  const entry = useSyncExternalStore(store?.subscribe ?? (() => () => {}), () => store?.get(id), () => undefined);
  const disabled = blocked || !!entry?.disabled;
  const [deferred, setDeferred] = useState<NavigationAction | null>(null);
  usePreventRemove(disabled, ({ data }) => { if ((data.action as NavigationAction & { appNavigation?: boolean }).appNavigation) setDeferred(data.action); });
  useEffect(() => { if (!disabled && deferred && navigation.isFocused()) { setDeferred(null); navigation.dispatch(deferred); } }, [disabled, deferred, navigation]);
  useEffect(() => () => {
    const current = store?.get(id);
    store?.remove(id);
    current?.onDismiss();
  }, [store, id]);
  return entry?.children ?? <Button title="Close" onPress={() => navigation.goBack()} />;
}

