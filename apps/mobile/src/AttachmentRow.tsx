import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import ListRow from './ListRow';
import { Icon, useUI } from './ui';

export default function AttachmentRow({ title, subtitle, label, thumbnail, disabled, onOpen, options }: {
  title: string; subtitle: string; label: string; thumbnail: React.ReactNode; disabled: boolean; onOpen: () => void; options?: React.ReactNode;
}) {
  const { ui } = useUI();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
    <ListRow accessibilityLabel={label} disabled={disabled} onPress={onOpen} leading={thumbnail} trailing={<Icon name="next" size={18} />} style={{ flex: 1, minHeight: 56, gap: 12 }}>
      <Text numberOfLines={1} ellipsizeMode="tail" style={ui.body}>{title}</Text><Text style={ui.caption}>{subtitle}</Text>
    </ListRow>{options}
  </View>;
}
