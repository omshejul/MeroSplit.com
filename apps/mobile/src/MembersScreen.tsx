import React, { useRef, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { formatMoney, integer } from './accounting';
import type { Group } from './types';

type Props = {
  group: Group;
  selfId: string;
  local: boolean;
  busy: boolean;
  onAction: (suffix: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onLocalAdd: (name: string) => Promise<void>;
  onExport: (format: 'json' | 'csv') => Promise<void>;
  onPublish?: () => Promise<void>;
};

function Action({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={[s.control, disabled && { opacity: 0.5 }]}>
    <Text>{title}</Text>
  </Pressable>;
}

function Field({ label, value, onChange, disabled, maxLength = 120 }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean; maxLength?: number;
}) {
  return <View style={s.field}><Text>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange}
    editable={!disabled} autoCapitalize="none" autoCorrect={false} maxLength={maxLength} style={s.control} /></View>;
}

function signedPaise(input: string): string {
  const text = input.trim();
  if (text.length > 40 || !/^-?(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(text)) {
    throw new Error('Use rupee amounts with up to two decimal places, such as 120.50 or -120.50.');
  }
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const absolute = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const amount = (text.startsWith('-') ? -absolute : absolute).toString();
  integer(amount, true);
  return amount;
}

export default function MembersScreen(props: Props) {
  return <MemberSettings key={`${props.group.id}|${props.selfId}|${props.local}`} {...props} />;
}

function MemberSettings({ group, selfId, local, busy, onAction, onLocalAdd, onExport, onPublish }: Props) {
  const [newName, setNewName] = useState('');
  const [inviteLink, setInviteLink] = useState<{ participantId: string; name: string; url: string } | null>(null);
  const [showOpening, setShowOpening] = useState(false);
  const [previous, setPrevious] = useState<Record<string, string>>({});
  const [source, setSource] = useState('');
  const [cutoff, setCutoff] = useState(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ section: string; text: string; error: boolean } | null>(null);
  const inFlight = useRef(false);
  const self = group.participants.find(person => person.id === selfId);
  const organizer = !local && self?.user_id != null && self.user_id === group.owner_id;
  const disabled = busy || working;
  const opening = group.opening_balance;
  const name = (id: string) => group.participants.find(person => person.id === id)?.name ?? 'Former member';
  const note = (section: string) => feedback?.section === section
    ? <Text accessibilityLiveRegion="polite" accessibilityRole={feedback.error ? 'alert' : undefined}>{feedback.text}</Text>
    : null;

  async function perform(section: string, work: () => Promise<void>, success?: string) {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setFeedback(null);
    try {
      await work();
      if (success) setFeedback({ section, text: success, error: false });
    } catch (error) {
      setFeedback({ section, text: error instanceof Error ? error.message : 'Please try again.', error: true });
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }

  function confirm(title: string, detail: string, action: () => void, label = 'Confirm') {
    Alert.alert(title, detail, [{ text: 'Cancel', style: 'cancel' }, { text: label, onPress: action }]);
  }

  function proposeOpening() {
    try {
      const balances = Object.fromEntries(group.participants.map(person => [person.id, signedPaise(previous[person.id] ?? '0')]));
      const total = Object.values(balances).reduce((sum, amount) => sum + BigInt(amount), 0n);
      if (total !== 0n) throw new Error(`Previous balances must add up to zero. The difference is ${formatMoney(total.toString())}.`);
      if (Object.values(balances).every(amount => amount === '0')) throw new Error('Enter at least one previous balance.');
      if (!source.trim()) throw new Error('Describe where these previous balances came from.');
      const date = new Date(`${cutoff}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || cutoff.startsWith('0000') || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== cutoff) {
        throw new Error('Enter a valid date as YYYY-MM-DD.');
      }
      const summary = group.participants.map(person => `${person.name}: ${formatMoney(balances[person.id])}`).join('\n');
      confirm('Add these previous balances?', `${summary}\n\nFrom: ${source.trim()}\nAs of: ${cutoff}\nEveryone with a nonzero balance must agree before these amounts affect the group.`,
        () => void perform('opening', async () => {
          await onAction('/opening-balances', { id: Crypto.randomUUID(), balances, source: source.trim(), cutoff });
          setShowOpening(false);
        }, 'Previous balances proposed. Waiting for the required members to agree.'), 'Propose');
    } catch (error) {
      setFeedback({ section: 'opening', text: error instanceof Error ? error.message : 'Check the previous balances.', error: true });
    }
  }

  return <View style={s.content}>
    <Text style={s.heading}>Members</Text>
    {group.participants.map(person => <View key={person.id} style={s.row}>
      <Text>{person.name}{person.id === selfId ? ' (you)' : ''}</Text>
      {!local && <Text>{person.user_id == null ? 'Not joined yet' : person.user_id === group.owner_id ? 'Organizer' : 'Joined'}</Text>}
      {organizer && person.user_id == null && <Action title={`Create invite link for ${person.name}`} disabled={disabled} onPress={() => void perform('invites', async () => {
        const result = await onAction('/invites', { participant_id: person.id });
        if (typeof result.url !== 'string' || !/^https?:\/\//.test(result.url)) throw new Error('The link is not available yet. Sync and try again.');
        setInviteLink({ participantId: person.id, name: person.name, url: result.url });
      }, 'Invite link ready.')} />}
    </View>)}
    {!group.is_direct && (local || organizer) && <View style={s.section}>
      <Field label="New member name" value={newName} onChange={setNewName} disabled={disabled || !!group.archived} />
      <Action title="Add member" disabled={disabled || !!group.archived} onPress={() => void perform('members', async () => {
        if (!newName.trim()) throw new Error('Enter a member name.');
        if (local) await onLocalAdd(newName.trim());
        else await onAction('/participants', { id: Crypto.randomUUID(), name: newName.trim() });
        setNewName('');
      }, 'Member added.')} />
      {note('members')}
    </View>}

    {!local && organizer && <View style={s.section}>
      <Text style={s.heading}>Invitations</Text>
      {inviteLink && <View style={s.field}>
        <Text>Invite for {inviteLink.name}</Text><Text selectable>{inviteLink.url}</Text>
        <Action title={`Share invite for ${inviteLink.name}`} disabled={disabled} onPress={() => void perform('invites', async () => {
          await Share.share({ message: `Join ${group.name} as ${inviteLink.name}: ${inviteLink.url}` });
        })} />
      </View>}
      {(group.invites ?? []).filter(invite => !invite.revoked).map(invite => <View key={invite.id} style={s.row}>
        <Text>{name(invite.participant_id)}</Text>
        <Text>{invite.approved ? 'Account approved' : invite.claimant_email ? `Requested by ${invite.claimant_email}` : 'No account has requested this invitation yet.'}</Text>
        {!invite.approved && invite.claimant_id != null && invite.claimant_email && <Action title={`Approve ${invite.claimant_email} for ${name(invite.participant_id)}`} disabled={disabled} onPress={() => confirm(
          `Approve this account for ${name(invite.participant_id)}?`, `${invite.claimant_email}\nConfirm that this is the person you invited. Email addresses are not verified. They will be able to see and change this group's records.`,
          () => void perform('invites', async () => { await onAction(`/invites/${invite.id}/approve`, {}); }, 'Account approved.'), 'Approve')} />}
        <Action title={`Revoke invite for ${name(invite.participant_id)}`} disabled={disabled} onPress={() => confirm(
          'Revoke this invitation?', `This link will stop opening ${group.name}. An already approved account will keep its group membership.`,
          () => void perform('invites', async () => {
            await onAction(`/invites/${invite.id}/revoke`, {});
            if (inviteLink?.participantId === invite.participant_id) setInviteLink(null);
          }, 'Invitation revoked.'), 'Revoke')} />
      </View>)}
      {!group.invites?.some(invite => !invite.revoked) && !inviteLink && <Text>Create an invite link beside a member who has not joined yet.</Text>}
      {note('invites')}
    </View>}

    {!local && <View style={s.section}>
      <Text style={s.heading}>Previous balances</Text>
      {opening ? <>
        <Text>{opening.accepted ? 'Agreed and included in balances' : 'Proposed. Not yet included in balances.'}</Text>
        <Text>From: {opening.source}</Text><Text>As of: {opening.cutoff}</Text>
        <Text>Positive means owed to that person. Negative means they owe.</Text>
        {group.participants.map(person => <Text key={person.id}>{person.name}{person.id === selfId ? ' (you)' : ''}: {formatMoney(opening.balances[person.id] ?? '0')}{Object.hasOwn(opening.acknowledgments, person.id) ? ' · Agreed' : ''}</Text>)}
        {!opening.accepted && self?.user_id != null && (opening.balances[selfId] ?? '0') !== '0' && !Object.hasOwn(opening.acknowledgments, selfId) && <>
          <Action title="I agree to my previous balance" disabled={disabled || !!group.archived} onPress={() => confirm(
            'Agree to your previous balance?', `${formatMoney(opening.balances[selfId])} from ${opening.source}, as of ${opening.cutoff}. It affects balances once all required members agree.`,
            () => void perform('opening', async () => { await onAction(`/opening-balances/${opening.id}/acknowledge`, {}); }, 'Your agreement was saved.'), 'Agree')} />
          {group.archived && <Text>Reopen the group before agreeing to previous balances.</Text>}
        </>}
      </> : <>
        <Text>No previous balances have been added.</Text>
        {organizer && !group.archived && <Action title={showOpening ? 'Cancel previous balances' : 'Add previous balances'} disabled={disabled} onPress={() => { setShowOpening(value => !value); setFeedback(null); }} />}
        {organizer && showOpening && !group.archived && <View style={s.field}>
          <Text>Use a minus sign for an amount owed. Current expenses stay as they are.</Text>
          {group.participants.map(person => <Field key={person.id} label={`${person.name} balance (₹)`} value={previous[person.id] ?? '0'} disabled={disabled} maxLength={40} onChange={value => setPrevious(current => ({ ...current, [person.id]: value }))} />)}
          <Field label="Where are these balances from?" value={source} onChange={setSource} disabled={disabled} maxLength={300} />
          <Field label="As of date (YYYY-MM-DD)" value={cutoff} onChange={setCutoff} disabled={disabled} maxLength={10} />
          <Action title="Review previous balances" disabled={disabled} onPress={proposeOpening} />
        </View>}
      </>}
      {note('opening')}
    </View>}

    {local && <View style={s.section}>
      <Text>These records are saved on this device.</Text>
      {onPublish ? <Action title="Share a copy with my account" disabled={disabled} onPress={() => confirm(
        'Create a shared copy?', 'Your original stays on this device. The copy will be saved in your account and visible to members you invite.',
        () => void perform('publish', onPublish, 'Shared copy created.'), 'Create copy')} /> : <Text>Sign in from Account to create a shared copy.</Text>}
      {note('publish')}
    </View>}

    <View style={s.section}>
      <Text style={s.heading}>Export</Text>
      {!local && <Action title="Export spreadsheet" disabled={disabled} onPress={() => void perform('export', () => onExport('csv'))} />}
      <Action title="Export data file" disabled={disabled} onPress={() => void perform('export', () => onExport('json'))} />
      {note('export')}
    </View>
    {organizer && <View style={s.section}>
      <Action title={group.archived ? 'Reopen group' : 'Archive group'} disabled={disabled} onPress={() => confirm(
        group.archived ? 'Reopen this group?' : 'Archive this group?', group.archived ? 'Members can add expenses again.' : 'Existing records stay available. Reopen the group to add expenses again.',
        () => void perform('archive', async () => { await onAction('/archive', { archived: !group.archived }); }, group.archived ? 'Group reopened.' : 'Group archived.'), group.archived ? 'Reopen' : 'Archive')} />
      {note('archive')}
    </View>}
  </View>;
}

const s = StyleSheet.create({
  content: { gap: 12 },
  heading: { fontSize: 18, fontWeight: '600' },
  section: { gap: 10, paddingVertical: 12 },
  row: { gap: 6, paddingVertical: 8 },
  field: { gap: 6 },
  control: { minHeight: 44, padding: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: '#777', justifyContent: 'center' },
});
