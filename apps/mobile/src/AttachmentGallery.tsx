import React, { useEffect, useRef } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { Text } from 'react-native-paper';
import PrivateMediaImage from './PrivateMediaImage';
import type { MediaMetadata } from './media';
import type { Session } from './types';
import { Button, Icon, useUI } from './ui';

export default function AttachmentGallery({ session, items, selectedId, disabled, options, onSelect, onOpen, onAdd }: {
  session: Session; items: MediaMetadata[]; selectedId: string | null; disabled: boolean; options?: React.ReactNode;
  onSelect: (id: string) => void; onOpen: (item: MediaMetadata) => void; onAdd?: () => void;
}) {
  const { palette, ui, motion } = useUI(), { width = 390, height = 844, fontScale = 1 } = useWindowDimensions();
  const strip = useRef<React.ComponentRef<typeof ScrollView>>(null), selected = items.find(item => item.id === selectedId) ?? items[0];
  const index = selected ? items.indexOf(selected) : 0;
  const size = Math.max(120, Math.min(260, width - 64, height * 0.26 / Math.max(1, fontScale)));
  const label = selected ? `${selected.content_type === 'application/pdf' ? 'PDF' : 'Photo'} ${index + 1} of ${items.length}` : '';
  const reveal = () => strip.current?.scrollTo({ x: Math.max(0, index * 80 - 8), animated: !!motion?.enabled });
  useEffect(reveal, [selected?.id]);
  return <View style={{ gap: 12 }}>
    {selected && <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 }}>
        <Text style={ui.caption}>{label}</Text>{options}
      </View>
      <Button kind="plain" accessibilityLabel={`Open ${label}`} disabled={disabled} onPress={() => onOpen(selected)}
        style={{ width: '100%', alignItems: 'center', justifyContent: 'center', padding: 10, borderRadius: 12, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.background }}>
        <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
          <PrivateMediaImage key={selected.id} session={session} media={selected} size={size} resizeMode="contain" label={label} interactive={false} />
        </View>
        <View pointerEvents="none" accessible={false} aria-hidden style={{ position: 'absolute', bottom: 10, right: 10, padding: 6, borderRadius: 6, backgroundColor: palette.surface }}><Icon name="external" size={18} color={palette.text} /></View>
      </Button>
    </>}
    <ScrollView ref={strip} horizontal onContentSizeChange={reveal} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
      {items.map((item, at) => {
        const title = `${item.content_type === 'application/pdf' ? 'PDF' : 'Photo'} ${at + 1} of ${items.length}`;
        return <Button key={item.id} kind="plain" accessibilityLabel={`Select ${title}`} accessibilityState={{ selected: item.id === selected?.id }} disabled={disabled} onPress={() => onSelect(item.id)}
          style={{ width: 72, height: 72, padding: 3, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 2, borderColor: item.id === selected?.id ? palette.accent : 'transparent', backgroundColor: palette.soft }}>
          <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden><PrivateMediaImage session={session} media={item} size={62} label={title} interactive={false} /></View>
        </Button>;
      })}
      {onAdd && <Button kind="plain" accessibilityLabel="Add attachment" disabled={disabled} onPress={onAdd}
        style={{ width: 72, minHeight: 72, gap: 4, padding: 5, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderStyle: 'dashed', borderColor: palette.outline, borderRadius: 10 }}>
        <Icon name="add" size={24} color={palette.accent} /><Text style={[ui.caption, { color: palette.accent }]}>Add</Text>
      </Button>}
    </ScrollView>
    {selected && <Text style={[ui.caption, { textAlign: 'center' }]}>Tap the preview to open full size</Text>}
  </View>;
}
