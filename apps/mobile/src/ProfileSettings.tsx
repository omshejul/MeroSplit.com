import { CancelDialogActions, DialogScrollBody } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, TextInput, useWindowDimensions, View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import { RadioChoice } from './FormFields';
import { colorFamilies, isDarkOnly } from './theme';
import { Button, ErrorText, SettingsRow, useUI, type AppearancePreference, type ColorFamily } from './ui';

const modes = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] as const;
function ChoiceGroup<T extends string>({ label, group, options, selected, disabled, note, onChoose }: { label: string; group: string; options: readonly { value: T; label: string }[]; selected: T; disabled: boolean; note?: string; onChoose: (value: T) => void }) {
  const { ui } = useUI();
  return <View role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
    <Text style={[ui.label, { paddingHorizontal: 16, paddingTop: 8 }]}>{label}</Text>
    {!!note && <Text style={[ui.caption, { paddingHorizontal: 16 }]}>{note}</Text>}
    {options.map(option => <RadioChoice key={option.value} group={group} value={option.value} label={option.label} selected={selected === option.value} disabled={disabled} onPress={() => onChoose(option.value)} />)}
  </View>;
}
export default function ProfileSettings({ name, vpa, busy, onSaveName, onSaveUPI, onAppearance, onColorFamily }: {
  name: string; vpa: string; busy: boolean; onSaveName: (name: string) => Promise<void>; onSaveUPI: (vpa: string) => Promise<void>; onAppearance: (value: AppearancePreference) => Promise<void>; onColorFamily: (value: ColorFamily) => Promise<void>;
}) {
  const { ui, inputColors, appearance, colorFamily } = useUI();
  const mode = modes.find(value => value.value === appearance)!.label, family = colorFamilies.find(value => value.value === colorFamily)!.label, darkOnly = isDarkOnly(colorFamily);
  const [editing, setEditing] = useState<'name' | 'upi' | 'appearance' | null>(null), [draft, setDraft] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const nameRow = useRef<React.ComponentRef<typeof View>>(null), upiRow = useRef<React.ComponentRef<typeof View>>(null), appearanceRow = useRef<React.ComponentRef<typeof View>>(null), input = useRef<React.ComponentRef<typeof TextInput>>(null), inFlight = useRef(false);
  const initialChoiceFocused = useRef(false);
  const choices = useRef<React.ComponentRef<typeof View>>(null), doneArea = useRef<React.ComponentRef<typeof View>>(null), { height } = useWindowDimensions();
  const disabled = busy || saving, isName = editing === 'name', isAppearance = editing === 'appearance';
  const valid = isName ? !!draft.trim() : /^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$/.test(draft.trim()) && draft.trim().length <= 254;
  function open(field: NonNullable<typeof editing>) { initialChoiceFocused.current = false; setDraft(field === 'name' ? name : vpa); setError(''); setEditing(field); }
  function close() { const row = isName ? nameRow : isAppearance ? appearanceRow : upiRow; Keyboard.dismiss(); setEditing(null); setError(''); requestAnimationFrame(() => row.current?.focus()); }
  useEffect(() => {
    if (Platform.OS !== 'web' || !editing) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !disabled) { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [editing, disabled]);
  // Web: start on the selected color, keep Tab inside Color, Mode and Done, and
  // return to a group's selected radio after its save re-enables the choices.
  const webNode = (ref: React.RefObject<React.ComponentRef<typeof View> | null>) => ref.current as unknown as HTMLElement | null;
  function choiceStops() {
    const stops = [webNode(choices)?.querySelector<HTMLInputElement>('input[name="color"]:checked'), webNode(choices)?.querySelector<HTMLInputElement>('input[name="mode"]:checked'), webNode(doneArea)?.querySelector<HTMLElement>('button, [role="button"]')];
    return stops.filter((stop): stop is HTMLElement => !!stop && !(stop as HTMLInputElement).disabled && stop.getAttribute('aria-disabled') !== 'true');
  }
  function focusInitialChoice() {
    if (Platform.OS !== 'web' || initialChoiceFocused.current) return;
    const target = choiceStops()[0];
    if (target) { target.focus(); initialChoiceFocused.current = true; }
  }
  function focusChoice(group: 'color' | 'mode') { if (Platform.OS === 'web') requestAnimationFrame(() => webNode(choices)?.querySelector<HTMLInputElement>(`input[name="${group}"]:checked`)?.focus()); }
  useEffect(() => {
    if (Platform.OS !== 'web' || !isAppearance) return;
    const frame = requestAnimationFrame(focusInitialChoice);
    const tab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const stops = choiceStops(), active = document.activeElement;
      if (!stops.length) return;
      const at = stops.findIndex(stop => stop === active || !!active && !!stop.closest('[role="radiogroup"]')?.contains(active));
      stops[at < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (at + (event.shiftKey ? stops.length - 1 : 1)) % stops.length].focus();
    };
    document.addEventListener('keydown', tab, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', tab, true); };
  }, [isAppearance]);
  // Appearance choices apply at once and keep the dialog open for the other choice.
  async function save(choice?: () => Promise<void>) {
    if (disabled || inFlight.current) return;
    if (!isAppearance && !valid) { setError(isName ? 'Enter a name.' : 'Enter a valid UPI ID.'); return; }
    inFlight.current = true; setSaving(true); setError('');
    try { if (choice) await choice(); else { if (isName) await onSaveName(draft.trim()); else await onSaveUPI(draft.trim()); close(); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save. Try again.'); requestAnimationFrame(() => input.current?.focus()); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <>
    <SettingsRow rowRef={nameRow} icon="edit" label="Name" value={name} disabled={busy} onPress={() => open('name')} />
    <SettingsRow rowRef={upiRow} icon="pay" label="UPI ID" value={vpa || 'Not set'} disabled={busy} onPress={() => open('upi')} />
    <SettingsRow rowRef={appearanceRow} icon="appearance" label="Appearance" value={darkOnly ? family : colorFamily === 'basic' ? mode : `${family} · ${mode}`} disabled={busy} onPress={() => open('appearance')} />
    <KeyboardDialog visible={!!editing} onDismiss={() => { if (!disabled) close(); }} dismissable={!disabled} maxHeight={isAppearance ? height : undefined}>
      <Dialog.Title aria-level={2}>{isAppearance ? 'Appearance' : isName ? 'Name' : 'UPI ID'}</Dialog.Title>
      {isAppearance ? <>
        <DialogScrollBody maxHeight={Platform.OS === 'web' ? Math.min(560, Math.max(0, height - 224)) : 440} gap={0} paddingVertical={0}><View ref={choices} onLayout={focusInitialChoice}>
          <ChoiceGroup label="Color" group="color" options={colorFamilies} selected={colorFamily} disabled={disabled} onChoose={value => void save(() => onColorFamily(value)).then(() => focusChoice('color'))} />
          <ChoiceGroup label="Mode" group="mode" options={modes} selected={appearance} disabled={disabled || darkOnly} note={darkOnly ? 'Obsidian is always dark. Other colors use this mode.' : undefined} onChoose={value => void save(() => onAppearance(value)).then(() => focusChoice('mode'))} />
          {!!error && <ErrorText live>{error}</ErrorText>}
        </View></DialogScrollBody>
        <Dialog.Actions><View ref={doneArea}><Button title="Done" kind="text" disabled={disabled} onPress={close} /></View></Dialog.Actions>
      </> : <><Dialog.Content style={{ flexShrink: 1 }}><ScrollView keyboardShouldPersistTaps="handled">
          <View style={{ gap: 8 }}><TextInput ref={input} {...inputColors} autoFocus accessibilityLabel={isName ? 'Name' : 'UPI ID'} value={draft} maxLength={isName ? 120 : 254} autoCorrect={false} autoCapitalize={isName ? 'words' : 'none'} autoComplete={isName ? 'name' : 'off'} keyboardType={isName ? 'default' : 'email-address'} returnKeyType="done" editable={!disabled} style={ui.input}
            onChangeText={text => { setDraft(text); setError(''); }} onSubmitEditing={() => void save()} onKeyPress={event => { if (event.nativeEvent.key === 'Escape' && !disabled) close(); }} />
            {!isName && <Text style={ui.caption}>Check this address. It is not bank verified.</Text>}</View>
          {!!error && <ErrorText live>{error}</ErrorText>}
        </ScrollView></Dialog.Content>
        <CancelDialogActions disabled={disabled} onCancel={close}><Button title={saving ? 'Saving…' : 'Save'} disabled={disabled || !valid || draft.trim() === (isName ? name : vpa)} onPress={() => void save()} /></CancelDialogActions></>}
    </KeyboardDialog>
  </>;
}
