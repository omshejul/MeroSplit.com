import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { Button, useUI } from './ui';

type Props = {
  hidden: boolean; busy: boolean; canLeave: boolean; blockedReason?: string;
  explanation?: string;
  onLeave: () => void; onRestore: () => void;
};

export function GroupMembershipActions({ hidden, busy, canLeave, blockedReason, explanation, onLeave, onRestore }: Props) {
  const { ui } = useUI();
  if (hidden) return <Button title="Restore to my list" onPress={onRestore} disabled={busy} />;
  return <View style={{ gap: 8 }}>
    <Button title="Delete group" icon="remove" onPress={onLeave} disabled={busy || !canLeave} kind="secondary" />
    <Text style={ui.caption}>{blockedReason || explanation || 'Leave this group and remove it from your list. Shared balances and history stay.'}</Text>
  </View>;
}
