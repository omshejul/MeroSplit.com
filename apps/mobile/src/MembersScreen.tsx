import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { Dialog, Portal, SegmentedButtons, Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { Alert } from './alerts';
import { formatMoney, integer } from './accounting';
import type { Group, Participant } from './types';
import { addPerson, currentEmailInvite, emailInvitationRequest, personRequest, sendInvitation } from './members';
import type { AddPersonRequest, EmailInviteRequest } from './members';
import { Avatar, Button, DateField, Disclosure, IconAction, useUI } from './ui';
import type { Palette } from './ui';

type Props = {
  group: Group;
  selfId: string;
  busy: boolean;
  addPersonRequest?: number;
  onAction: (suffix: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onExport: (format: 'json' | 'csv') => Promise<void>;
};

function Field({ label, value, onChange, disabled, maxLength = 120, keyboardType = 'default', placeholder, autoFocus = false, autoCapitalize = 'none' }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean; maxLength?: number; keyboardType?: TextInputProps['keyboardType']; placeholder?: string; autoFocus?: boolean; autoCapitalize?: TextInputProps['autoCapitalize'];
}) {
  const { palette: colors, ui, inputColors } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return <View style={s.field}><Text style={ui.label}>{label}</Text><TextInput {...inputColors} accessibilityLabel={label} value={value} onChangeText={onChange}
    autoFocus={autoFocus} editable={!disabled} accessibilityState={{ disabled }} keyboardType={keyboardType} autoCapitalize={autoCapitalize} autoCorrect={false} maxLength={maxLength} placeholder={placeholder} placeholderTextColor={colors.muted} style={ui.input} /></View>;
}

function balanceDescription(amount: string) {
  const value = BigInt(amount);
  return value === 0n ? 'Settled' : `${value < 0n ? 'Owes' : 'Is owed'} ${formatMoney((value < 0n ? -value : value).toString())}`;
}

const emailStatus = (state: string | undefined, email: string) => state === 'sent' ? `Sent to ${email}`
  : state === 'failed' ? 'Invitation failed. Try again.'
    : state === 'sending' ? 'Sending status pending' : 'Invitation not sent';

function signedPaise(input: string): string {
  const text = input.trim();
  if (text.length > 40 || !/^-?(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(text)) {
    throw new Error('Enter an amount with up to two decimal places, such as 120.50. Choose Owes or Is owed for its direction.');
  }
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const absolute = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const amount = (text.startsWith('-') ? -absolute : absolute).toString();
  integer(amount, true);
  return amount;
}

export default function MembersScreen(props: Props) {
  return <MemberSettings key={`${props.group.id}|${props.selfId}`} {...props} />;
}

function MemberSettings({ group, selfId, busy, addPersonRequest = 0, onAction, onExport }: Props) {
  const { palette: colors, ui } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [newName, setNewName] = useState(''), [newEmail, setNewEmail] = useState(''), [addingPerson, setAddingPerson] = useState(false);
  const pendingPerson = useRef<AddPersonRequest | null>(null), lastAddRequest = useRef(addPersonRequest);
  const addTrigger = useRef<HTMLElement | null>(null);
  function closeAddPerson() { Keyboard.dismiss(); setAddingPerson(false); requestAnimationFrame(() => addTrigger.current?.focus()); }
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
  const [contactEmail, setContactEmail] = useState<string | null>(null);
  const [emailRequests, setEmailRequests] = useState<Record<string, EmailInviteRequest>>({});
  const [inviteCooldowns, setInviteCooldowns] = useState<Record<string, number>>({});
  const inFlight = useRef(false);
  const self = group.participants.find(person => person.id === selfId);
  const organizer = !self?.removed && self?.user_id != null && self.user_id === group.owner_id;
  const directPerson = organizer && group.is_direct && group.participants.length === 2
    ? group.participants.find(person => person.id !== selfId && !person.removed && person.user_id == null) : undefined;
  const savedEmail = directPerson?.email ?? '', email = contactEmail ?? savedEmail;
  const emailChanged = email.trim().toLowerCase() !== savedEmail.trim().toLowerCase();
  const disabled = busy || working;
  useEffect(() => {
    if (lastAddRequest.current === addPersonRequest) return;
    lastAddRequest.current = addPersonRequest;
    if (organizer && !group.is_direct && !group.archived && !disabled) {
      if (Platform.OS === 'web') addTrigger.current = document.querySelector<HTMLElement>('[aria-label="Add person"]') ?? document.activeElement as HTMLElement | null;
      setAddingPerson(true); setFeedback(null);
    }
  }, [addPersonRequest, organizer, group.is_direct, group.archived, disabled]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !addingPerson) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !disabled && !inFlight.current) { event.preventDefault(); closeAddPerson(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [addingPerson, disabled]);
  useEffect(() => {
    if (!Object.values(inviteCooldowns).some(value => value > 0)) return;
    const timer = setTimeout(() => setInviteCooldowns(current => Object.fromEntries(Object.entries(current).map(([id, value]) => [id, Math.max(0, value - 1)]))), 1000);
    return () => clearTimeout(timer);
  }, [inviteCooldowns]);
  const opening = group.opening_balance;
  const needsOpeningAgreement = !!opening && !opening.accepted && self?.user_id != null
    && (opening.balances[selfId] ?? '0') !== '0' && !Object.hasOwn(opening.acknowledgments, selfId);
  const name = (id: string) => group.participants.find(person => person.id === id)?.name ?? 'Former member';
  const hasInvites = !!inviteLink || group.participants.some(person => !person.removed && person.user_id == null && !person.email)
    || (group.invites ?? []).some(invite => !invite.revoked);
  const note = (section: string) => feedback?.section === section
    ? <Text style={feedback.error ? ui.error : ui.caption} accessibilityLiveRegion="polite" accessibilityRole={feedback.error ? 'alert' : undefined}>{feedback.text}</Text>
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

  function sendEmailInvite(person: Participant) {
    const saved = person.email ?? '';
    if (!organizer || person.removed || person.user_id != null || !saved || inviteCooldowns[person.id] || group.archived
      || (person.id === directPerson?.id && emailChanged)) return;
    const section = `email-invite:${person.id}`;
    void perform(section, async () => {
      const request = emailInvitationRequest(person.id, saved, emailRequests[person.id], currentEmailInvite(group, person.id, saved), Crypto.randomUUID);
      setEmailRequests(current => ({ ...current, [person.id]: request }));
      setInviteCooldowns(current => ({ ...current, [person.id]: 60 }));
      setFeedback({ section, text: 'Sending invitation…', error: false });
      const status = await sendInvitation(group.id, request, onAction);
      setInviteCooldowns(current => ({ ...current, [person.id]: status.retryAfter }));
      if (status.state === 'sent') setEmailRequests(current => { const next = { ...current }; delete next[person.id]; return next; });
      setFeedback({ section, text: status.state === 'sent' ? `Invitation sent to ${saved}.` : status.state === 'failed' ? 'The invitation email could not be sent. You can retry.' : 'The invitation is still being sent. Check its status before retrying.', error: status.state === 'failed' });
    });
  }

  function savePerson() {
    if (!organizer || group.is_direct || group.archived) return;
    void perform('add-person', async () => {
      const request = personRequest(newName, newEmail, pendingPerson.current, Crypto.randomUUID);
      pendingPerson.current = request;
      await addPerson(group.id, request, onAction);
      pendingPerson.current = null;
      setNewName(''); setNewEmail(''); closeAddPerson();
      setFeedback({ section: 'members', text: 'Person added. No invitation was sent.', error: false });
    });
  }

  function proposeOpening() {
    try {
      const balances = Object.fromEntries(group.participants.map(person => {
        const value = previous[person.id] ?? '';
        return [person.id, signedPaise(value === '' || value === '-' ? '0' : value)];
      }));
      const total = Object.values(balances).reduce((sum, amount) => sum + BigInt(amount), 0n);
      if (total !== 0n) throw new Error(`Previous balances must add up to zero. The difference is ${formatMoney(total.toString())}.`);
      if (Object.values(balances).every(amount => amount === '0')) throw new Error('Enter at least one previous balance.');
      if (!source.trim()) throw new Error('Describe where these previous balances came from.');
      const date = new Date(`${cutoff}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || cutoff.startsWith('0000') || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== cutoff) {
        throw new Error('Enter a valid date as YYYY-MM-DD.');
      }
      const summary = group.participants.map(person => `${person.name}: ${balanceDescription(balances[person.id])}`).join('\n');
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
    <View>
      {group.participants.map(person => {
        const removable = organizer && !person.removed && person.id !== selfId && person.user_id !== group.owner_id;
        const balance = BigInt(group.balances[person.id] ?? '0');
        const blocked = removable && balance !== 0n;
        const invitation = currentEmailInvite(group, person.id, person.email ?? '');
        const pendingEmail = emailRequests[person.id], cooldown = inviteCooldowns[person.id] ?? 0;
        const inviteSection = `email-invite:${person.id}`;
        const canInvite = organizer && !person.removed && person.user_id == null && !!person.email;
        const status = person.removed ? 'Removed' : person.user_id != null ? person.user_id === group.owner_id ? 'Organizer' : 'Joined' : invitation?.send_state === 'sent' ? 'Invited' : '';
        const reason = blocked ? `Settle ${formatMoney((balance < 0n ? -balance : balance).toString())} first` : '';
        const displayName = `${person.name}${person.id === selfId && person.name.toLowerCase() !== 'you' ? ' (you)' : ''}`;
        return <View key={person.id} style={ui.row}>
          <Avatar name={person.name} />
          <View style={[ui.rowBody, s.memberBody]}>
            <Text numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={displayName} style={ui.rowTitle}>{displayName}</Text>
            {!!(reason || status) && <Text style={ui.rowSub} accessibilityLabel={[status, reason].filter(Boolean).join('. ')}>{[status, reason].filter(Boolean).join(' · ')}</Text>}
            {canInvite && <>
              <Text numberOfLines={1} accessibilityLabel={person.email} style={ui.rowSub}>{person.email}</Text>
              <Button title={working && feedback?.section === inviteSection ? 'Sending…' : cooldown > 0 ? `Retry in ${cooldown}s` : pendingEmail || ['failed', 'sending'].includes(invitation?.send_state ?? '') ? 'Retry invitation' : invitation?.send_state === 'sent' ? 'Resend invitation' : 'Send invitation'} accessibilityLabel={`Send invitation to ${person.name} at ${person.email}`} kind="text"
                disabled={disabled || !!group.archived || cooldown > 0 || (person.id === directPerson?.id && emailChanged)} onPress={() => sendEmailInvite(person)} />
              {invitation && ['failed', 'sending'].includes(invitation.send_state ?? '') && feedback?.section !== inviteSection && <Text style={invitation.send_state === 'failed' ? ui.error : ui.caption}>{emailStatus(invitation.send_state, person.email!)}</Text>}
              {note(inviteSection)}
            </>}
          </View>
          {removable && <IconAction name="remove" label={`Remove ${person.name}`} hint={reason || undefined} disabled={disabled || blocked || !!group.archived} onPress={() => confirm(
            `Remove ${person.name}?`, `${person.user_id != null ? 'They will lose access to this group. ' : ''}Existing bills and payment history remain.`,
            () => void perform('members', async () => { await onAction(`/participants/${person.id}/remove`, {}); }, 'Person removed.'), 'Remove')} />}
        </View>;
      })}
    </View>
    {directPerson && <Disclosure title="Contact email">
      <Field label="Email (optional)" value={email} onChange={value => { setContactEmail(value); setFeedback(null); }} disabled={disabled || !!group.archived} keyboardType="email-address" maxLength={254} />
      {emailChanged && <Button title="Save contact" disabled={disabled || !!group.archived} onPress={() => void perform('contact', async () => {
        await onAction(`/participants/${directPerson.id}/contact`, { email: email.trim() });
        setContactEmail(null);
        setEmailRequests(current => { const next = { ...current }; delete next[directPerson.id]; return next; });
        setInviteCooldowns(current => ({ ...current, [directPerson.id]: 0 }));
      }, 'Contact saved. No invitation was sent.')} />}
      {note('contact')}
      <Text style={ui.caption}>{emailChanged ? 'Save before sending an invitation.' : savedEmail ? 'Only this email can accept the invitation.' : 'Add an email to invite them later.'}</Text>
      {!!group.archived && <Text style={ui.caption}>Reopen this group to change the email or send an invitation.</Text>}
    </Disclosure>}
    <Portal>{addingPerson && <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined} style={StyleSheet.absoluteFill} pointerEvents="box-none"><Dialog visible onDismiss={() => { if (!disabled) closeAddPerson(); }}>
      <Dialog.Title>Add person</Dialog.Title>
      <Dialog.ScrollArea style={{ maxHeight: 280 }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[s.field, { paddingVertical: 12 }]}>
        <Field label="Name" value={newName} onChange={setNewName} disabled={disabled} autoFocus autoCapitalize="words" />
        <Field label="Email (optional)" value={newEmail} onChange={setNewEmail} disabled={disabled} keyboardType="email-address" maxLength={254} />
        {note('add-person')}
      </ScrollView></Dialog.ScrollArea>
      <Dialog.Actions><Button title="Cancel" kind="text" disabled={disabled} onPress={closeAddPerson} />
        <Button title={working ? 'Adding…' : 'Add person'} kind="primary" disabled={disabled || !newName.trim() || !!group.archived} onPress={savePerson} /></Dialog.Actions>
    </Dialog></KeyboardAvoidingView>}</Portal>
    {note('members')}

    {organizer && hasInvites && <Disclosure title="Invites">
      {group.participants.filter(person => !person.removed && person.user_id == null && !person.email).map(person => <View key={person.id} style={s.section}>
        <Text style={ui.rowTitle}>{person.name}</Text>
        <Button title="Invite" accessibilityLabel={`Invite ${person.name}`} disabled={disabled || !!group.archived} onPress={() => void perform('invites', async () => {
          const result = await onAction('/invites', { participant_id: person.id });
          if (typeof result.url !== 'string' || !/^https?:\/\//.test(result.url)) throw new Error('The link is not available yet. Sync and try again.');
          const link = { participantId: person.id, name: person.name, url: result.url };
          setInviteLink(link);
          const shared = await Share.share({ message: `Join ${group.name} as ${link.name}: ${link.url}` });
          if (shared.action === Share.sharedAction) setInviteLink(null);
        })} />
      </View>)}
      {inviteLink && <View style={s.field}>
        <Text style={ui.label}>Invite for {inviteLink.name}</Text>
        <Button title="Share invite" accessibilityLabel={`Share invite for ${inviteLink.name}`} disabled={disabled || !!group.archived} onPress={() => void perform('invites', async () => {
          const shared = await Share.share({ message: `Join ${group.name} as ${inviteLink.name}: ${inviteLink.url}` });
          if (shared.action === Share.sharedAction) setInviteLink(null);
        })} />
      </View>}
      {(group.invites ?? []).filter(invite => !invite.revoked).map(invite => <View key={invite.id} style={s.row}>
        <Text style={ui.rowTitle}>{name(invite.participant_id)}</Text>
        <Text style={ui.caption}>{invite.approved ? 'Account approved' : invite.intended_email ? emailStatus(invite.send_state, invite.intended_email) : invite.claimant_email ? `Requested by ${invite.claimant_email}` : 'Waiting for someone to request to join.'}</Text>
        {!invite.intended_email && !invite.approved && invite.claimant_id != null && invite.claimant_email && <Button title="Approve request" accessibilityLabel={`Approve ${invite.claimant_email} for ${name(invite.participant_id)}`} kind="primary" disabled={disabled || !!group.archived} onPress={() => confirm(
          `Approve this account for ${name(invite.participant_id)}?`, `${invite.claimant_email}\nConfirm that this is the person you invited. They will be able to see and change this group's records.`,
          () => void perform('invites', async () => { await onAction(`/invites/${invite.id}/approve`, {}); }, 'Account approved.'), 'Approve')} />}
        <Button title="Revoke invite" accessibilityLabel={`Revoke invite for ${name(invite.participant_id)}`} kind="text" disabled={disabled || !!group.archived} onPress={() => confirm(
          'Revoke this invitation?', `This link will stop opening ${group.name}. An already approved account will keep its group membership.`,
          () => void perform('invites', async () => {
            await onAction(`/invites/${invite.id}/revoke`, {});
            if (inviteLink?.participantId === invite.participant_id) setInviteLink(null);
          }, 'Invitation revoked.'), 'Revoke')} />
      </View>)}
      {note('invites')}
    </Disclosure>}

    {(opening || organizer) && <Disclosure title="Previous balances" initialOpen={needsOpeningAgreement}>
      {opening ? <>
        <Text style={[ui.notice, opening.accepted ? ui.success : ui.warning]}>{opening.accepted ? 'Agreed and included in balances.' : 'Waiting for agreement. Not included in balances yet.'}</Text>
        <Text style={ui.body}>From {opening.source}</Text><Text style={ui.caption}>As of {opening.cutoff}</Text>
        {group.participants.map(person => <View key={person.id} style={ui.row}>
          <View style={ui.rowBody}><Text style={ui.rowTitle}>{person.name}{person.id === selfId && person.name.toLowerCase() !== 'you' ? ' (you)' : ''}</Text>
            {Object.hasOwn(opening.acknowledgments, person.id) && <Text style={ui.rowSub}>Agreed</Text>}</View>
          <Text style={s.amount}>{balanceDescription(opening.balances[person.id] ?? '0')}</Text>
        </View>)}
        {needsOpeningAgreement && <>
          <Button title="I agree to my previous balance" kind="primary" disabled={disabled || !!group.archived} onPress={() => confirm(
            'Agree to your previous balance?', `${balanceDescription(opening.balances[selfId])}. From ${opening.source}, as of ${opening.cutoff}. It affects balances once all required members agree.`,
            () => void perform('opening', async () => { await onAction(`/opening-balances/${opening.id}/acknowledge`, {}); }, 'Your agreement was saved.'), 'Agree')} />
          {group.archived && <Text style={ui.caption}>Reopen the group before agreeing to previous balances.</Text>}
        </>}
      </> : <>
        <Text style={ui.caption}>No previous balances added.</Text>
        {organizer && !group.archived && <Button title={showOpening ? 'Cancel previous balances' : 'Add previous balances'} disabled={disabled} onPress={() => { setShowOpening(value => !value); setFeedback(null); }} />}
        {organizer && showOpening && !group.archived && <View style={s.field}>
          <Text style={ui.body}>Total owed and owing must match.</Text>
          {group.participants.filter(person => !person.removed).map(person => {
            const balance = previous[person.id] ?? '', owes = balance.startsWith('-');
            return <View key={person.id} style={s.section}>
              <Field label={`${person.name} balance (₹)`} value={balance.replace(/^-/, '')} disabled={disabled} maxLength={39} keyboardType="decimal-pad" placeholder="0"
                onChange={value => setPrevious(current => ({ ...current, [person.id]: `${owes ? '-' : ''}${value.replace(/^-/, '')}` }))} />
              <SegmentedButtons value={owes ? 'owes' : 'owed'} onValueChange={value => setPrevious(current => ({ ...current, [person.id]: `${value === 'owes' ? '-' : ''}${(current[person.id] ?? '').replace(/^-/, '')}` }))}
                buttons={[{ value: 'owes', label: 'Owes', accessibilityLabel: `${person.name} owes money`, disabled }, { value: 'owed', label: 'Is owed', accessibilityLabel: `${person.name} is owed money`, disabled }]} />
            </View>;
          })}
          <Field label="Where are these balances from?" value={source} onChange={setSource} disabled={disabled} maxLength={300} />
          <DateField label="As of date" value={cutoff} onChange={setCutoff} disabled={disabled} />
          <Button title="Review previous balances" kind="primary" disabled={disabled} onPress={proposeOpening} />
        </View>}
      </>}
      {note('opening')}
    </Disclosure>}

    <Disclosure title={organizer ? 'Export and archive' : 'Export'}>
      <Button title="Export spreadsheet" disabled={disabled} onPress={() => void perform('export', () => onExport('csv'))} />
      <Button title="Export data file" disabled={disabled} onPress={() => void perform('export', () => onExport('json'))} />
      {note('export')}
      {organizer && <>
        <Button title={group.archived ? 'Reopen group' : 'Archive group'} kind="text" disabled={disabled} onPress={() => confirm(
          group.archived ? 'Reopen this group?' : 'Archive this group?', group.archived ? 'Members can add expenses again.' : 'Existing records stay available. Reopen the group to add expenses again.',
          () => void perform('archive', async () => { await onAction('/archive', { archived: !group.archived }); }, group.archived ? 'Group reopened.' : 'Group archived.'), group.archived ? 'Reopen' : 'Archive')} />
        {note('archive')}
      </>}
    </Disclosure>
  </View>;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  content: { gap: 10 },
  section: { gap: 8, paddingVertical: 4 },
  row: { gap: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  field: { gap: 8 },
  memberBody: { flex: 1, minWidth: 0 },
  amount: { color: colors.text, fontSize: 17, fontWeight: '600', flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
