// Isolated native keyboard regression entry. Never imported by production index.ts.
import React, { useEffect, useRef, useState } from 'react';
import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import * as SplashScreen from 'expo-splash-screen';
import { Dimensions, FlatList, Keyboard, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { Text } from 'react-native-paper';
import { SafeAreaProvider, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppFrame } from '../../src/AppNavigation';
import AppStack, { NavigationContainer } from '../../src/AppStack';
import KeyboardScrollView from '../../src/KeyboardScrollView';
import { TextField } from '../../src/FormFields';
import { UIProvider } from '../../src/ui';
import { LoadingProvider } from '../../src/LoadingOverlay';
import FieldDialog from '../../src/FieldDialog';
import PeopleSheet from '../../src/PeopleSheet';
import SignInLayout from '../../src/SignInLayout';
import { ChatComposer } from '../../src/BillChatScreen';

type Input = React.ComponentRef<typeof TextInput>;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report = new File(Paths.document, 'keyboard-probe.json');
const resume = new File(Paths.document, 'keyboard-continue');
const rows: unknown[] = [];
const measure = (input: Input) => new Promise<{ y: number; height: number }>(resolve => input.measureInWindow((_x, y, _w, height) => resolve({ y, height })));
const modes = ['screen', 'dialog', 'sheet', 'list', 'signin', 'chat'] as const;

function Probe() {
  const [phase, setPhase] = useState(0), [notes, setNotes] = useState('Notes'), refs = useRef<(Input | null)[]>([]);
  const insets = useSafeAreaInsets(), mode = modes[phase];
  useEffect(() => {
    let live = true;
    async function check(name: string, node: Input | null) {
      if (!node) throw Error('Missing native input: ' + name);
      node.focus();
      await wait(700);
      if (!Keyboard.isVisible()) { const point = await measure(node); report.write(JSON.stringify({ platform: Platform.OS, rows, tapPoint: { x: 120, y: Math.min(point.y + point.height / 2, Dimensions.get('window').height - insets.bottom - 8) } })); }
      for (let i = 0; i < 60 && !Keyboard.isVisible(); i++) await wait(100);
      await wait(900);
      const frame = await measure(node), keyboard = Keyboard.metrics();
      const passed = node.isFocused() && !!keyboard && frame.height >= 20 && frame.y >= 0 && frame.y + frame.height <= keyboard.screenY + 1;
      rows.push({ name, ...frame, keyboard, focused: node.isFocused(), passed });
      if (resume.exists) resume.delete();
      report.write(JSON.stringify({ platform: Platform.OS, rows, capture: name }));
      for (let i = 0; i < 60 && live && !resume.exists; i++) await wait(100);
      if (!live) return;
      if (!passed) throw Error('Focused input is covered: ' + name);
    }
    async function run() {
      await SplashScreen.hideAsync(); await wait(900);
      if (mode === 'chat') {
        // Open the actual composer using native UI automation, then inspect its native ref.
        report.write(JSON.stringify({ platform: Platform.OS, rows, tap: 'Message' }));
        for (let i = 0; i < 100 && !Keyboard.isVisible(); i++) await wait(100);
        await check('chat-composer', TextInput.State.currentlyFocusedInput() as Input | undefined ?? null);
      } else {
        await check(mode + '-last', refs.current[7]);
        await check(mode + '-switch-with-keyboard-open', refs.current[3]);
        if (mode === 'screen') {
          setNotes(Array.from({ length: 35 }, (_, i) => `Line ${i + 1} of long notes`).join('\n'));
          await wait(200); await check('multiline-long-notes', refs.current[8]);
        }
      }
      Keyboard.dismiss(); await wait(500);
      if (!live) return;
      if (phase === modes.length - 1) report.write(JSON.stringify({ platform: Platform.OS, rows, passed: rows.every((r: any) => r.passed) }));
      else setPhase(phase + 1);
    }
    void run().catch(error => report.write(JSON.stringify({ platform: Platform.OS, rows, error: String(error), passed: false })));
    return () => { live = false; };
  }, [phase]);
  const fields = Array.from({ length: 8 }, (_, i) => <TextField key={i} ref={node => { refs.current[i] = node; }} label={`Field ${i + 1}`} value={`Synthetic ${i + 1}`} onChangeText={() => {}} />);
  const longField = <TextField ref={node => { refs.current[8] = node; }} label="Long notes" multiline value={notes} onChangeText={setNotes} style={{ minHeight: 80 }} />;
  const content = <View style={{ gap: 20 }}>{fields}{mode === 'screen' && longField}</View>;
  if (mode === 'dialog') return <FieldDialog title="Keyboard form" visible disabled={false} canSave onClose={() => {}} onSave={() => {}}>{content}</FieldDialog>;
  if (mode === 'sheet') return <PeopleSheet title="Keyboard sheet" icon="people" visible disabled={false} maxHeight={900} onDismiss={() => {}}>{content}</PeopleSheet>;
  if (mode === 'signin') return <SignInLayout busy={false}>{content}</SignInLayout>;
  if (mode === 'list') return <FlatList renderScrollComponent={props => <KeyboardScrollView {...props} />} data={[1, 2, 3]} renderItem={({ item }) => <Text>Row {item}</Text>} ListHeaderComponent={content} />;
  if (mode === 'chat') return <KeyboardAvoidingView behavior={Platform.OS === 'android' ? 'height' : undefined} keyboardVerticalOffset={insets.top} style={{ flex: 1 }}><View style={{ flex: 1 }} /><ChatComposer text="Synthetic message" disabled={false} onChange={() => {}} onSend={() => {}} /></KeyboardAvoidingView>;
  return <KeyboardScrollView contentContainerStyle={{ padding: 20 }}>{content}</KeyboardScrollView>;
}
function App() {
  return <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><NavigationContainer><AppFrame><AppStack initialScreen="home" scope="keyboard-probe" blocked={false} render={() => <Probe />} /></AppFrame></NavigationContainer></LoadingProvider></UIProvider></SafeAreaProvider>;
}
const errors = (globalThis as any).ErrorUtils;
errors?.setGlobalHandler((error: Error) => report.write(JSON.stringify({ error: String(error), stack: error.stack, passed: false })));
registerRootComponent(App);
