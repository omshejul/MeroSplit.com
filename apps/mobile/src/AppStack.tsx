import { Dialog } from './DialogParts';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { NavigationContainer, StackActions, getStateFromPath, useIsFocused, useNavigationContainerRef, usePreventRemove, type NavigationAction } from '@react-navigation/native';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import KeyboardDialog from './KeyboardDialog';

import { CancelDialogActions } from './DialogParts';
import { Button, useUI } from './ui';
import { ScreenDraftDiscard, ScreenRemovalLock } from './screenRemoval';
import { destination, routeParents, routePaths, sameRoute, screenNames, type AppRoute, type RouteParams, type Routes, type Screen } from './routes';

export { NavigationContainer };
const Stack = createNativeStackNavigator<Routes>();
const initial: AppRoute = { name: 'home', params: { tab: 'Groups' } };
type AppAction = NavigationAction & { appNavigation?: true };
type RenderScreen = (route: AppRoute, focused: boolean, onQueued: () => void) => React.ReactNode;
const SceneContext = createContext<{ render: RenderScreen; blocked: boolean }>({ render: () => null, blocked: false });

export const webLinking = {
  enabled: Platform.OS === 'web', prefixes: [], config: { screens: routePaths },
  getStateFromPath(path: string, options: Parameters<typeof getStateFromPath>[1]) {
    const parsed = getStateFromPath<Routes>(path, options);
    if (!parsed) return parsed;
    const route = parsed.routes[parsed.index ?? parsed.routes.length - 1] as AppRoute;
    return { ...parsed, routes: [...routeParents(route), route], index: routeParents(route).length };
  },
};

export function useAppNavigation() {
  const ref = useNavigationContainerRef<Routes>();
  const subscribe = useCallback((listener: () => void) => ref.addListener('state', listener), [ref]);
  const state = useSyncExternalStore(subscribe, () => ref.current?.getRootState(), () => undefined);
  const route: AppRoute = state?.routes[state.index] as AppRoute ?? initial;
  function go(name: Screen, params?: RouteParams) {
    if (!ref.isReady()) return;
    const current = ref.getRootState();
    if (!current) return;
    const target = destination(current.routes[current.index] as AppRoute, name, params);
    const index = current.routes.findLastIndex(value => sameRoute(value as AppRoute, target));
    if (index >= 0) {
      ref.dispatch({ ...StackActions.popTo(name, target.params), appNavigation: true } as AppAction);
    } else {
      const parents = routeParents(target), parent = parents.at(-1);
      if (!parent || sameRoute(current.routes[current.index] as AppRoute, parent)) {
        ref.dispatch({ ...StackActions.push(name, target.params), appNavigation: true } as AppAction);
      } else {
        // Link/notification entry has a real parent stack even when opened cold.
        const routes = parents.map(parent => current.routes.find(value => sameRoute(value as AppRoute, parent)) ?? parent);
        ref.dispatch({ type: 'RESET', payload: { index: routes.length, routes: [...routes, target] }, appNavigation: true } as AppAction);
      }
    }
  }
  function back(signedIn: boolean) {
    if (!ref.isReady()) return;
    if (ref.canGoBack()) ref.goBack();
    else {
      const current = ref.getCurrentRoute() as AppRoute;
      go(routeParents(current).at(-1)?.name ?? (signedIn ? 'home' : 'login'));
    }
  }
  function complete(name: Screen, params?: RouteParams) {
    if (ref.getCurrentRoute()?.key === route.key) go(name, params);
  }
  return { ref, route, go, back, complete };
}

function RouteScene({ route, navigation }: NativeStackScreenProps<Routes, Screen>) {
  const { render, blocked } = useContext(SceneContext), focused = useIsFocused();
  const [localBlocked, setLocalBlocked] = useState(false), [pending, setPending] = useState<NavigationAction | null>(null);
  const [discarding, setDiscarding] = useState(false), discardLock = useRef(false);
  const [deferred, setDeferred] = useState<NavigationAction | null>(null);
  const [queued, setQueued] = useState(false), committed = useRef(false), draftDiscard = useRef<(() => Promise<boolean>) | null>(null);
  const onQueued = useCallback(() => { committed.current = true; setQueued(true); }, []);
  const draft = route.name === 'expense' && !queued;
  useEffect(() => {
    if (!deferred) return;
    if (!focused || !navigation.isFocused()) { setDeferred(null); return; }
    if (blocked || localBlocked || discarding) return;
    setDeferred(null);
    if (draft && !committed.current) setPending(deferred);
    else navigation.dispatch(deferred);
  }, [deferred, blocked, localBlocked, discarding, draft, focused, navigation]);
  usePreventRemove(blocked || localBlocked || discarding || draft, ({ data }) => {
    if (blocked || localBlocked || discarding) {
      // Completion and link actions share the same locks. Replay only while
      // this scene is still current, after its form and app work have settled.
      if ((data.action as AppAction).appNavigation) setDeferred(data.action);
      return;
    }
    if (!draft || committed.current) { navigation.dispatch(data.action); return; }
    setPending(data.action);
  });
  return <ScreenRemovalLock.Provider value={setLocalBlocked}><ScreenDraftDiscard.Provider value={draftDiscard}>
    {render(route, focused, onQueued)}
    <KeyboardDialog label="Discard draft" visible={!!pending} dismissable={!discarding} onDismiss={() => { if (!discardLock.current) setPending(null); }}>

        <Dialog.Title>Do you want to discard the draft?</Dialog.Title>
        <CancelDialogActions disabled={blocked || localBlocked || discarding} onCancel={() => { if (!discardLock.current) setPending(null); }}>
          <Button title="Discard" kind="danger" icon="remove" disabled={blocked || localBlocked || discarding} onPress={() => {
            if (!pending || blocked || localBlocked || discardLock.current) return;
            discardLock.current = true; setDiscarding(true);
            void (async () => {
              try {
                if (await draftDiscard.current?.() !== false && navigation.isFocused()) navigation.dispatch(pending);
                setPending(null);
              } finally { discardLock.current = false; setDiscarding(false); }
            })();
          }} />
        </CancelDialogActions>

    </KeyboardDialog>
  </ScreenDraftDiscard.Provider></ScreenRemovalLock.Provider>;
}

export default function AppStack({ render, blocked, initialScreen, scope }: { render: RenderScreen; blocked: boolean; initialScreen: Screen; scope: string }) {
  const { palette, motion } = useUI();
  return <SceneContext.Provider value={{ render, blocked }}><Stack.Navigator screenOptions={{
    headerShown: false, contentStyle: { backgroundColor: palette.background }, animation: motion.enabled ? 'default' : 'none', gestureEnabled: !blocked,
  }}><Stack.Group navigationKey={scope}>{[initialScreen, ...screenNames.filter(name => name !== initialScreen)].map(name => <Stack.Screen key={name} name={name} initialParams={{ tab: initialScreen === 'signInMethods' ? 'Account' : 'Groups' }} component={RouteScene} />)}</Stack.Group></Stack.Navigator></SceneContext.Provider>;
}
