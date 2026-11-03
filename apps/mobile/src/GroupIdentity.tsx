import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import PhotoEditor from './PhotoEditor';
import EditableName from './EditableName';
import { useUI } from './ui';
import type { Group, Session } from './types';

export default function GroupIdentity({ group, session, busy, editable, onAction, onPhotoChanged }: {
  group: Group; session: Session | null; busy: boolean; editable: boolean;
  onAction: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onPhotoChanged?: () => void | Promise<void>;
}) {
  const { ui } = useUI(), count = group.participants.filter(person => !person.removed).length;
  return <PhotoEditor session={session} busy={busy} onBusyChange={() => {}} compact group={group} editable={editable} onChanged={onPhotoChanged}>
    <View style={{ flex: 1, minWidth: 0 }}>
      <EditableName name={group.name} title="Group name" label={`Edit group name, ${group.name}`} path="/name" version={group.version} busy={busy} editable={editable} onAction={onAction} textStyle={ui.section} />
      <Text style={ui.caption}>{count} {count === 1 ? 'member' : 'members'}</Text>
    </View>
  </PhotoEditor>;
}
