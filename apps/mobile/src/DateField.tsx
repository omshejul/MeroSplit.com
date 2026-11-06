import React, { useState } from 'react';
import { Platform, Switch, View } from 'react-native';
import { Text } from 'react-native-paper';
import DateTimePicker from '@react-native-community/datetimepicker';
import KeyboardDialog from './KeyboardDialog';
import { Dialog, DialogScrollBody, CancelDialogActions } from './DialogParts';
import { Button, useUI } from './ui';

const dateText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const timeText = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
function selectedDate(value: string, time?: string | null) {
  const now = new Date(), parsed = new Date(`${value}T${time || timeText(now)}:00`);
  return !Number.isNaN(parsed.getTime()) && dateText(parsed) === value ? parsed : now;
}
const dateLabel = (date: Date) => date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const timeLabel = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
type Props = { label: string; value: string; time?: string | null; onChange: (date: string, time: string | null) => void; disabled?: boolean };

export function DateDialog({ label, value, time, onChange, onDismiss }: Props & { onDismiss: () => void }) {
  const { palette, dark, ui } = useUI();
  const [draft, setDraft] = useState(() => selectedDate(value, time));
  const [includeTime, setIncludeTime] = useState(!!time);
  const [mode, setMode] = useState<'date' | 'time' | null>(Platform.OS === 'ios' ? 'date' : null);
  const changeDate = (date: Date) => setDraft(previous => {
    const next = new Date(previous);
    if (mode === 'time') next.setHours(date.getHours(), date.getMinutes(), 0, 0);
    else next.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    return next;
  });
  const inputStyle = { minHeight: 44, padding: '0 12px', borderRadius: 8, border: `1px solid ${palette.outline}`, backgroundColor: palette.surface, color: palette.text, fontSize: 17, colorScheme: dark ? 'dark' : 'light' };
  return <KeyboardDialog visible onDismiss={onDismiss} label={includeTime ? 'Date and time' : label}>
    <Dialog.Title>{includeTime ? 'Date and time' : label}</Dialog.Title>
    <DialogScrollBody maxHeight={360}>
      {Platform.OS === 'web' ? React.createElement('input', { type: 'date', 'aria-label': label, value: dateText(draft), onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        const next = new Date(`${event.target.value}T${timeText(draft)}:00`);
        if (!Number.isNaN(next.getTime()) && dateText(next) === event.target.value) setDraft(next);
      }, style: inputStyle }) : <Button title={dateLabel(draft)} accessibilityLabel="Choose date" kind="outlined" onPress={() => setMode('date')} />}
      <View style={ui.row}><Text style={[ui.rowTitle, { flex: 1 }]}>Add time</Text><Switch accessibilityLabel="Add time" value={includeTime} onValueChange={enabled => { setIncludeTime(enabled); if (!enabled && mode === 'time') setMode(Platform.OS === 'ios' ? 'date' : null); }} /></View>
      {includeTime && (Platform.OS === 'web' ? React.createElement('input', { type: 'time', 'aria-label': 'Time', value: timeText(draft), step: 60, onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(event.target.value)) return;
        const [hours, minutes] = event.target.value.split(':').map(Number), next = new Date(draft);
        next.setHours(hours, minutes, 0, 0); setDraft(next);
      }, style: inputStyle }) : <Button title={timeLabel(draft)} accessibilityLabel="Choose time" kind="outlined" onPress={() => setMode('time')} />)}
      {Platform.OS !== 'web' && mode && <DateTimePicker value={draft} mode={mode} display={Platform.OS === 'ios' ? 'spinner' : 'default'} accentColor={palette.accent} textColor={palette.text} themeVariant={dark ? 'dark' : 'light'} onChange={(event, date) => {
        if (Platform.OS !== 'ios') setMode(null);
        if (event.type === 'set' && date) changeDate(date);
      }} />}
    </DialogScrollBody>
    <CancelDialogActions disabled={false} onCancel={onDismiss}><Button title="Save" kind="primary" onPress={() => { onChange(dateText(draft), includeTime ? timeText(draft) : null); onDismiss(); }} /></CancelDialogActions>
  </KeyboardDialog>;
}

export default function DateField({ label, value, time, onChange, disabled = false }: Props) {
  const { ui } = useUI(), [open, setOpen] = useState(false), date = selectedDate(value, time);
  const { minHeight, paddingHorizontal, paddingVertical, borderRadius, borderWidth, borderColor, backgroundColor } = ui.input;
  return <View style={{ gap: 8 }}><Text style={ui.label}>{label}</Text>
    <Button kind="outlined" accessibilityLabel={`${label}: ${value}${time ? ` ${time}` : ''}`} disabled={disabled} onPress={() => setOpen(true)} title={`${dateLabel(date)}${time ? `, ${timeLabel(date)}` : ''}`}
      style={{ minHeight, paddingHorizontal, paddingVertical, borderRadius, borderWidth, borderColor, backgroundColor, justifyContent: 'flex-start' }}
      labelStyle={{ fontFamily: ui.input.fontFamily, fontSize: ui.input.fontSize, color: ui.input.color, fontWeight: '400', textAlign: 'left' }} />
    {open && !disabled && <DateDialog label={label} value={value} time={time} onChange={onChange} onDismiss={() => setOpen(false)} />}
  </View>;
}
