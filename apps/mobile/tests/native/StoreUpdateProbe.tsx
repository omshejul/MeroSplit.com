// Synthetic store boundary around the production update hook and dialog.
import React, { useEffect } from 'react';
import { Linking } from 'react-native';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text } from 'react-native-paper';
import { File, Paths } from 'expo-file-system';
import { UIProvider } from '../../src/ui';
import { AppFrame, ScreenHeader, pageContentStyle } from '../../src/AppNavigation';
import AppStack, { NavigationContainer, useAppNavigation } from '../../src/AppStack';
import ScrollView from '../../src/KeyboardScrollView';
import AppUpdates, { AppUpdatePrompt } from '../../src/AppUpdates';
import useAppUpdates from '../../src/useAppUpdates';

const originalFetch = globalThis.fetch, opened: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => String(input).startsWith('https://store-update.invalid/')
  ? new Response(JSON.stringify({ android: { version: '1.2.4', build: '35' } }), { status: 200 })
  : originalFetch(input, init)) as typeof fetch;
Linking.openURL = async (url: string) => { opened.push(url); };

function Content() {
  const update = useAppUpdates({ baseUrl: 'https://store-update.invalid', enabled: true, online: true, foreground: true, safe: true, busy: false, onRestart: async () => {} });
  useEffect(() => {
    void SplashScreen.hideAsync();
    new File(Paths.document, 'store-update-probe.json').write(JSON.stringify({ prompt: update.promptVisible, opened, error: update.error }));
  });
  return <><ScreenHeader title="Store update QA" busy={false} /><ScrollView contentContainerStyle={pageContentStyle}>
    <Text>{opened.length ? `Opened ${opened[opened.length - 1]}` : 'No store opened'}</Text>
    <AppUpdates update={update} />
  </ScrollView><AppUpdatePrompt update={update} /></>;
}
function Probe() {
  const navigation = useAppNavigation();
  return <NavigationContainer ref={navigation.ref}><AppFrame><AppStack initialScreen="home" scope="store-update-probe" blocked={false} render={() => <Content />} /></AppFrame></NavigationContainer>;
}
registerRootComponent(() => <SafeAreaProvider><UIProvider><Probe /></UIProvider></SafeAreaProvider>);
