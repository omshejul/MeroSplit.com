import RowGroup from './RowGroup';
import { useRowDivider } from './rowDividers';
import { PersonSelectionList } from './PersonChoice';
import DetailDialog from './DetailDialog';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import type { CachedGroup, Command, Group } from './types';
import { Button, useUI } from './ui';

export type SavedChangesProps = {
  commands: Command[]; groups: CachedGroup[]; busy: boolean; expired: boolean; expanded?: boolean;
  onOpen: (group: CachedGroup) => void; onReview: (command: Command) => void; onDiscard: (command: Command) => void; onRetry: () => void;
};

export function SavedCommandRow({ command, group, busy, onOpen, onReview, onDiscard }: {
  command: Command; group?: CachedGroup; busy: boolean;
  onOpen: (group: CachedGroup) => void; onReview: (command: Command) => void; onDiscard: (command: Command) => void;
}) {
  const { ui, palette } = useUI();
  const divider = useRowDivider();
  return <View style={[styles.row, { borderBottomColor: palette.line, borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0 }]}>
    <Text style={ui.rowTitle}>{String(command.body.description ?? group?.group.name ?? 'Saved change')}</Text>
    <Text style={ui.caption}>{command.error ?? (command.state === 'pending' ? 'Pending sync' : 'Needs review')}</Text>
    {group ? command.state !== 'pending' ? <Button title="Review" kind="text" disabled={busy} onPress={() => onReview(command)} />
      : <Button title="Open" kind="text" disabled={busy} onPress={() => onOpen(group)} />
      : <Button title="Discard saved change" kind="text" disabled={busy} onPress={() => onDiscard(command)} />}
  </View>;
}

export function SavedChanges({ commands, groups, busy, expired, expanded = false, onOpen, onReview, onDiscard, onRetry }: SavedChangesProps) {
  const needsReview = commands.some(command => command.state !== 'pending');
  if (!commands.length) return null;
  return <DetailDialog busy={busy} title={needsReview ? 'Needs review' : 'Pending sync'} initialOpen={expanded || needsReview}>
    <RowGroup>{commands.map(command => <SavedCommandRow key={command.command_id} command={command}
      group={groups.find(group => group.group.id === command.group_id)} busy={busy} onOpen={onOpen} onReview={onReview} onDiscard={onDiscard} />)}</RowGroup>
    {!expired && <Button title="Retry" disabled={busy} onPress={onRetry} />}
  </DetailDialog>;
}

export type LegacyRecoveryProps = {
  groups: Group[]; email: string; selected: Record<string, string>; busy: boolean;
  onSelect: (groupId: string, personId: string) => void; onRecover: (group: Group) => void;
};

export function LegacyGroupRecovery({ group, selected, busy, onSelect, onRecover }: {
  group: Group; selected?: string; busy: boolean;
  onSelect: (personId: string) => void; onRecover: () => void;
}) {
  const { ui } = useUI();
  return <DetailDialog busy={busy} icon="groups" title={group.name}>
    <Text style={ui.caption}>{group.expenses.length} bills · Who are you?</Text>
    <PersonSelectionList people={group.participants} selected={selected} disabled={busy} onSelect={onSelect} />
    <Button title="Recover these records" disabled={busy || !selected} onPress={onRecover} />
  </DetailDialog>;
}

export function LegacyRecovery({ groups, email, selected, busy, onSelect, onRecover }: LegacyRecoveryProps) {
  const { ui } = useUI();
  if (!groups.length) return null;
  return <DetailDialog busy={busy} icon="phone" title="Earlier phone records">
    <Text style={ui.caption}>Choose only records that belong to you. Recovery links them to {email}. No invitations are sent.</Text>
    {groups.map(group => <LegacyGroupRecovery key={group.id} group={group} selected={selected[group.id]} busy={busy}
      onSelect={personId => onSelect(group.id, personId)} onRecover={() => onRecover(group)} />)}
  </DetailDialog>;
}

const styles = StyleSheet.create({
  row: { gap: 6, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
