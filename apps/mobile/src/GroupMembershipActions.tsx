import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { Button, useUI } from './ui';

type Props = {
  hidden: boolean; busy: boolean; canLeave: boolean; blockedReason?: string;
  actionTitle: 'Leave group' | 'Remove from my list'; explanation?: string;
  onLeave: () => void; onRestore: () => void;
};

export function GroupMembershipActions({ hidden, busy, canLeave, blockedReason, actionTitle, explanation, onLeave, onRestore }: Props) {
  const { ui } = useUI();
  if (hidden) return <Button title="Restore to my list" onPress={onRestore} disabled={busy} />;
  return <View style={{ gap: 8 }}>
    <Button title={actionTitle} onPress={onLeave} disabled={busy || !canLeave} kind="secondary" />
    {(blockedReason || explanation) ? <Text style={ui.caption}>{blockedReason || explanation}</Text> : null}
  </View>;
}
