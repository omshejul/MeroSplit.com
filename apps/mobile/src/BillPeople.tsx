import RowGroup from './RowGroup';
import React, { useRef, useState } from 'react';
import { Keyboard, useWindowDimensions, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PeopleSheet from './PeopleSheet';
import { SectionHeading, Button, Icon, useUI, type IconName } from './ui';

export default function BillPeople({ title, icon, summary, inline, disabled, total, count, children }: {
  title: string; icon: IconName; summary: string; inline: boolean; disabled: boolean; total?: string; count?: number; children: React.ReactNode;
}) {
  const { ui } = useUI(), [open, setOpen] = useState(false);
  const { height } = useWindowDimensions(), { top, bottom } = useSafeAreaInsets();
  const trigger = useRef<React.ComponentRef<typeof View>>(null);
  const close = () => { Keyboard.dismiss(); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  if (inline) return <View style={{ gap: 10 }}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Icon name={icon} /><SectionHeading>{title}</SectionHeading></View><RowGroup style={{ gap: 10 }}>{children}</RowGroup></View>;
  return <>
    <Button kind="plain" ref={trigger} accessibilityRole="button" accessibilityLabel={`${title}. ${summary}`} disabled={disabled} accessibilityState={{ disabled }} onPress={() => { if (!disabled) setOpen(true); }} style={ui.row}>
      <Icon name={icon} /><View style={ui.rowBody}><Text style={ui.label}>{title}</Text><Text style={ui.body}>{summary}</Text></View><Icon name="next" size={18} />
    </Button>
    <PeopleSheet visible={open} onDismiss={close} title={icon === 'people' ? 'Split expense' : title} icon={icon} total={total} count={count} disabled={disabled} maxHeight={Math.max(0, height - top - bottom)}>{children}</PeopleSheet>
  </>;
}
