import React from 'react';
import { Text, View } from 'react-native';
import type { Group, Participant } from './types';
import KeyboardDialog from './KeyboardDialog';
import { Dialog, DialogScrollBody } from './DialogParts';
import { Button, ErrorText, SettingsRow, useUI } from './ui';

type Invite = NonNullable<Group['invites']>[number];
export default function PersonInviteDialog({ person, invites, busy, canInvite, canEditContact, canRename, canRemove,
  removeReason, error, onClose, onEmail, onContact, onShare, onRename, onRemove, onApprove, onRevoke }: {
  person?: Participant; invites: Invite[]; busy: boolean; canInvite: boolean; canEditContact: boolean; canRename: boolean;
  canRemove: boolean; removeReason?: string; error?: string; onClose: () => void; onEmail: () => void;
  onContact: () => void; onShare: () => void; onRename: () => void; onRemove: () => void;
  onApprove: (invite: Invite) => void; onRevoke: (invite: Invite) => void;
}) {
  const { ui } = useUI();
  const requests = invites.filter(invite => !invite.approved && !invite.intended_email && invite.claimant_id != null);
  const joined = person?.user_id != null;
  return <KeyboardDialog visible={!!person} dismissable={!busy} onDismiss={() => { if (!busy) onClose(); }}>
    <Dialog.Title icon="personAdd">{person ? `${requests.length ? 'Review' : joined ? 'Manage' : 'Invite'} ${person.name}` : 'Invite person'}</Dialog.Title>
    <DialogScrollBody maxHeight={480} gap={12} paddingVertical={0}>
      {joined ? <Text style={ui.caption}>{person?.account_email ?? 'Joined this group'}</Text> : <>
        <SettingsRow icon="mail" label="Send email invite" description={person?.email || 'Add email'} disabled={busy || !canInvite} onPress={onEmail} />
        <SettingsRow icon="external" label="Share invite link" disabled={busy || !canInvite} onPress={onShare} />
        {person?.email && canEditContact && <SettingsRow icon="edit" label="Edit contact email" disabled={busy} onPress={onContact} />}
      </>}
      {canRename && <SettingsRow icon="edit" label="Edit name" disabled={busy} onPress={onRename} />}
      {requests.map(invite => <View key={invite.id} style={{ gap: 8 }}>
        <Text style={ui.label}>Request to join</Text><Text style={ui.body}>{invite.claimant_email}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button title="Approve request" icon="check" kind="primary" disabled={busy} onPress={() => onApprove(invite)} />
          <Button title="Revoke invite" icon="close" kind="text" disabled={busy} onPress={() => onRevoke(invite)} />
        </View>
      </View>)}
      {!requests.length && invites.filter(invite => !invite.approved).map(invite => <View key={invite.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text style={[ui.caption, { flex: 1 }]}>{invite.intended_email ? 'Email invite created' : 'Invite link active'}</Text>
        <Button title="Revoke" icon="close" kind="text" compact disabled={busy} onPress={() => onRevoke(invite)} />
      </View>)}
      {!joined && <Text style={ui.caption}>Email invites can only be accepted by the invited email. You review requests made with a shared link.</Text>}
      {canRemove && <SettingsRow icon="remove" label="Remove person" danger chevron={false} disabled={busy || !!removeReason} onPress={onRemove} />}
      {!!removeReason && <Text style={ui.caption}>{removeReason}</Text>}
      {!!error && <ErrorText live>{error}</ErrorText>}
    </DialogScrollBody>
    <Dialog.Actions><Button title="Done" icon="check" disabled={busy} onPress={onClose} /></Dialog.Actions>
  </KeyboardDialog>;
}
