import React, { useEffect, useRef, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import Svg, { G, Path, Rect } from 'react-native-svg';
import { DialogScrollBody } from './DialogParts';
import { RadioChoice } from './FormFields';
import KeyboardDialog from './KeyboardDialog';
import { applyAppIcon, availableAppIcons } from './appIcon';
import { appIconLabel, appIcons, markPaths, markTransform, themeAppIcon, type AppIcon, type AppIconChoice, type AppIconId } from './appIcons';
import { savedAppIcon, saveAppIcon } from './native';
import { useSavedChoice } from './savedChoice';
import { colorFamilies } from './theme';
import { Button, ErrorText, SettingsRow, useUI } from './ui';

export function AppIconPreview({ icon, size }: { icon: AppIcon; size: number }) {
  return <Svg width={size} height={size} viewBox="0 0 100 100" accessible={false}>
    <Rect x={0.5} y={0.5} width={99} height={99} rx={22.5} fill={icon.ground} stroke="#D8D8D8" strokeWidth={icon.ground === '#FFFFFF' ? 1 : 0} />
    <G transform={markTransform}><Path d={markPaths.left} fill={icon.left} /><Path d={markPaths.right} fill={icon.right} /></G>
  </Svg>;
}

const failure = (cause: unknown) => {
  const code = (cause as { code?: string } | null)?.code;
  return (code === 'ERR_APP_ICON_UNSUPPORTED' || code === 'ERR_APP_ICON_MISSING') && cause instanceof Error ? cause.message : 'Could not change the app icon. Try again.';
};

// Choices save at once; the icon itself changes when the dialog closes,
// because iOS shows an alert after every change.
export default function AppIconSettings({ busy }: { busy: boolean }) {
  const { ui, palette, colorFamily } = useUI();
  const { height } = useWindowDimensions();
  const [available, setAvailable] = useState<AppIconId[]>([]);
  const [choice, changeChoice] = useSavedChoice<AppIconChoice>('match', savedAppIcon, saveAppIcon);
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const row = useRef<React.ComponentRef<typeof View>>(null);
  const pendingChoice = useRef<Promise<AppIconChoice> | null>(null);
  const closing = useRef(false);
  useEffect(() => {
    let live = true;
    void availableAppIcons().then(ids => { if (live) setAvailable(ids); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!available.length) return null;

  const family = colorFamilies.find(value => value.value === colorFamily)!.label, matched = appIconLabel(themeAppIcon[colorFamily]);
  async function pick(next: AppIconChoice) {
    if (closing.current) return;
    setError('');
    const write = changeChoice(next).then(() => next);
    pendingChoice.current = write;
    try { await write; }
    catch { if (pendingChoice.current === write) setError('Could not save. Try again.'); }
  }
  async function finish() {
    if (closing.current) return;
    closing.current = true;
    setSaving(true); setError('');
    try {
      const saved = await (pendingChoice.current ?? choice);
      await applyAppIcon(saved, colorFamily);
      pendingChoice.current = null;
      setOpen(false);
      requestAnimationFrame(() => row.current?.focus());
    } catch (cause) { setError(failure(cause)); }
    finally { closing.current = false; setSaving(false); }
  }
  return <>
    <SettingsRow divider rowRef={row} icon="appIcon" label="App icon" value={choice === 'match' ? 'Match color' : appIconLabel(choice)} disabled={busy} onPress={() => { setError(''); setOpen(true); }} />
    <KeyboardDialog visible={open} onDismiss={() => void finish()} dismissable={!saving} maxHeight={height}>
      <Dialog.Title aria-level={2}>App icon</Dialog.Title>
      <DialogScrollBody maxHeight={440} gap={0} paddingVertical={0}>
        <View role="radiogroup" aria-label="App icon" aria-disabled={saving || undefined}>
          <RadioChoice group="appIcon" value="match" label="Match color" selected={choice === 'match'} disabled={saving} onPress={() => void pick('match')} />
          <Text style={[ui.caption, { paddingHorizontal: 16 }]}>{`Follows your Appearance color. ${family} uses ${matched}.`}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingTop: 12, paddingBottom: 4 }}>
            {appIcons.filter(icon => available.includes(icon.id)).map(icon => {
              const selected = choice === icon.id;
              return <Pressable key={icon.id} role="radio" aria-checked={selected} accessibilityLabel={`${icon.label} icon`} disabled={saving} onPress={() => void pick(icon.id)}
                style={({ pressed }) => ({ width: '25%', alignItems: 'center', gap: 4, paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}>
                <View style={{ padding: 3, borderRadius: 17, borderWidth: 2, borderColor: selected ? palette.accent : 'transparent' }}><AppIconPreview icon={icon} size={52} /></View>
                <Text numberOfLines={1} style={[ui.caption, selected && { color: palette.text }]}>{icon.label}</Text>
              </Pressable>;
            })}
          </View>
          <Text style={[ui.caption, { paddingHorizontal: 16 }]}>Previews show the default style. iOS applies your Home Screen appearance.</Text>
        </View>
        {!!error && <ErrorText live>{error}</ErrorText>}
      </DialogScrollBody>
      <Dialog.Actions><Button title={saving ? 'Changing…' : 'Done'} kind="text" disabled={saving} onPress={() => void finish()} /></Dialog.Actions>
    </KeyboardDialog>
  </>;
}
