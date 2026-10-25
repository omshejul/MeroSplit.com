import { confirmedGroupInvite, publicAppUrl } from './appLinks';
import { DialogScrollBody, CancelDialogActions } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import SendInviteDialog from './SendInviteDialog';
import LoadingSpinner from './LoadingSpinner';
import { GroupMembershipActions } from './GroupMembershipActions';
import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, Share, StyleSheet, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { Alert } from './alerts';
import { formatMoney } from './accounting';
import type { Group, Participant } from './types';
import { addPerson, currentEmailInvite, emailInvitationRequest, personRequest, saveContact, sendInvitation } from './members';
import type { AddPersonRequest, EmailInviteRequest } from './members';
import { EmailField, TextField } from './FormFields';
import { Avatar, Button, Disclosure, IconAction, useUI } from './ui';

type Props = {
  group: Group;
  selfId: string;
  busy: boolean;
  addPersonRequest?: number;
  onMembership: (action: 'leave' | 'restore') => void;
  onAction: (suffix: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
type Feedback = { section: string; text: string; error: boolean } | null;
type Invite = NonNullable<Group['invites']>[number];
type InviteLink = { participantId: string; name: string; url: string };

function Field({ label, value, onChange, disabled, maxLength = 120, keyboardType = 'default', placeholder, autoFocus = false, autoCapitalize = 'none' }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean; maxLength?: number; keyboardType?: TextInputProps['keyboardType']; placeholder?: string; autoFocus?: boolean; autoCapitalize?: TextInputProps['autoCapitalize'];
}) {
  return <TextField label={label} value={value} onChangeText={onChange} containerStyle={s.field}
    autoFocus={autoFocus} editable={!disabled} accessibilityState={{ disabled }} keyboardType={keyboardType} autoCapitalize={autoCapitalize} autoCorrect={false} maxLength={maxLength} placeholder={placeholder} />;
}

function balanceDescription(amount: string) {
  const value = BigInt(amount);
  return value === 0n ? 'Settled' : `${value < 0n ? 'Owes' : 'Is owed'} ${formatMoney((value < 0n ? -value : value).toString())}`;
}

function FeedbackNote({ section, feedback }: { section: string; feedback: Feedback }) {
  const { ui } = useUI();
  return feedback?.section === section && !!feedback.text
    ? <Text style={feedback.error ? ui.error : ui.caption} accessibilityLiveRegion="polite" accessibilityRole={feedback.error ? 'alert' : undefined}>{feedback.text}</Text>
    : null;
}

function MemberRow({ group, person, selfId, organizer, disabled, working, feedback, cooldown, contactChanged, onAddEmail, onRename, onSend, onRemove }: {
  group: Group; person: Participant; selfId: string; organizer: boolean; disabled: boolean; working: boolean; feedback: Feedback;
  cooldown: number; contactChanged: boolean; onAddEmail: () => void; onRename: () => void; onSend: () => void; onRemove: () => void;
}) {
  const { ui } = useUI();
  const removable = organizer && !person.removed && person.id !== selfId && person.user_id !== group.owner_id;
  const balance = BigInt(group.balances[person.id] ?? '0'), blocked = removable && balance !== 0n;
  const inviteSection = `email-invite:${person.id}`;
  const canRename = organizer && !group.archived && !person.removed && person.id !== selfId && person.user_id == null;
  const canAddEmail = organizer && !group.is_direct && !group.archived && !person.removed && person.id !== selfId && person.user_id == null && !person.email;
  const canInvite = organizer && !person.removed && person.user_id == null && !!person.email;
  const status = person.removed ? 'Removed' : person.user_id != null ? person.user_id === group.owner_id ? 'Organizer' : 'Joined' : '';
  const reason = blocked ? `Settle ${formatMoney((balance < 0n ? -balance : balance).toString())} first` : '';
  const displayName = `${person.name}${person.id === selfId && person.name.toLowerCase() !== 'you' ? ' (you)' : ''}`;
  return <View style={ui.row}>
    <Avatar name={person.name} />
    <View style={ui.rowBody}>
      <Pressable accessibilityRole={canRename ? 'button' : undefined} accessibilityLabel={canRename ? `Edit ${person.name}'s name` : undefined} disabled={disabled || !canRename} onPress={onRename} style={{ minHeight: canRename ? 44 : undefined, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={ui.rowBody}><Text numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={displayName} style={ui.rowTitle}>{displayName}</Text>
          {!!(reason || status) && <Text style={ui.rowSub} accessibilityLabel={[status, reason].filter(Boolean).join('. ')}>{[status, reason].filter(Boolean).join(' · ')}</Text>}
        </View>
      </Pressable>
      {canInvite && <>
        <Text numberOfLines={1} accessibilityLabel={person.email} style={ui.rowSub}>{person.email}</Text>
        <Button title={working && feedback?.section === inviteSection ? 'Sending' : 'Send'} accessibilityLabel={`Send invite to ${person.name} at ${person.email}`} kind="text"
          disabled={disabled || !!group.archived || cooldown > 0 || contactChanged} onPress={onSend} />
        <FeedbackNote section={inviteSection} feedback={feedback} />
      </>}
    </View>
    {canAddEmail && <IconAction name="mail" label={`Add email and invite ${person.name}`} disabled={disabled} onPress={onAddEmail} />}
    {removable && <IconAction name="remove" label={`Remove ${person.name}`} hint={reason || undefined} disabled={disabled || blocked || !!group.archived} onPress={onRemove} />}
  </View>;
}

function AddPersonDialog({ visible, disabled, working, archived, name, email, onName, onEmail, onClose, onSave, onLink, feedback }: {
  visible: boolean; disabled: boolean; working: boolean; archived: boolean; name: string; email: string;
  onName: (value: string) => void; onEmail: (value: string) => void; onClose: () => void; onSave: () => void; onLink: () => void; feedback: Feedback;
}) {
  return <KeyboardDialog visible={visible} onDismiss={() => { if (!disabled) onClose(); }}>
    <Dialog.Title aria-level={2}>Add person</Dialog.Title>
    <DialogScrollBody maxHeight={280} gap={8}>
      <Field label="Name" value={name} onChange={onName} disabled={disabled} autoFocus autoCapitalize="words" />
      <Field label="Email (optional)" value={email} onChange={onEmail} disabled={disabled} keyboardType="email-address" maxLength={254} />
      <Button title="Invite with a link" kind="text" disabled={disabled || archived} onPress={onLink} />
      <FeedbackNote section="add-person" feedback={feedback} />
    </DialogScrollBody>
    <CancelDialogActions disabled={disabled} onCancel={onClose}>
      <Button title={working ? 'Adding…' : 'Add person'} kind="primary" disabled={disabled || !name.trim() || archived} onPress={onSave} /></CancelDialogActions>
  </KeyboardDialog>;
}

function EditNameDialog({ person, name, disabled, working, unavailable, onName, onClose, onSave, feedback }: { person?: Participant; name: string; disabled: boolean; working: boolean; unavailable: boolean; onName: (value: string) => void; onClose: () => void; onSave: () => void; feedback: Feedback }) {
  return <KeyboardDialog visible={!!person} dismissable={!disabled} onDismiss={() => { if (!disabled) onClose(); }}>
    <Dialog.Title aria-level={2}>Edit name</Dialog.Title>
    <DialogScrollBody maxHeight={200} gap={8}>
      <Field label="Name" value={name} onChange={onName} disabled={disabled || unavailable} autoFocus autoCapitalize="words" />
      <FeedbackNote section="person-name" feedback={feedback} />
    </DialogScrollBody>
    <CancelDialogActions disabled={disabled} onCancel={onClose}><View style={{ width: 20, height: 20 }}><LoadingSpinner visible={working} /></View><Button title="Save" kind="primary" disabled={disabled || unavailable || !name.trim() || name.trim() === person?.name} onPress={onSave} /></CancelDialogActions>
  </KeyboardDialog>;
}

function PersonEmailDialog({ person, email, disabled, working, unavailable, onEmail, onClose, onSave, feedback }: { person?: Participant; email: string; disabled: boolean; working: boolean; unavailable: boolean; onEmail: (value: string) => void; onClose: () => void; onSave: () => void; feedback: Feedback }) {
  return <KeyboardDialog visible={!!person} dismissable={!disabled} onDismiss={() => { if (!disabled) onClose(); }}>
    <Dialog.Title aria-level={2}>Invite {person?.name}</Dialog.Title>
    <DialogScrollBody maxHeight={280} gap={8}>
      <EmailField label="Email" value={email} onChangeText={onEmail} editable={!disabled && !unavailable} maxLength={254} autoFocus />
      <FeedbackNote section={`email-invite:${person?.id}`} feedback={feedback} />
    </DialogScrollBody>
    <CancelDialogActions disabled={disabled} onCancel={onClose}><Button title={working ? 'Sending' : 'Send'} kind="primary" icon="mail" disabled={disabled || unavailable || !email.trim()} onPress={onSave} /></CancelDialogActions>
  </KeyboardDialog>;
}

function ManualInviteRow({ name, disabled, onInvite }: { name: string; disabled: boolean; onInvite: () => void }) {
  const { ui } = useUI();
  return <View style={s.section}>
    <Text style={ui.rowTitle}>{name}</Text>
    <Button title="Invite" accessibilityLabel={`Invite ${name}`} disabled={disabled} onPress={onInvite} />
  </View>;
}

function ShareInviteRow({ link, disabled, onShare }: { link: InviteLink; disabled: boolean; onShare: () => void }) {
  const { ui } = useUI();
  return <View style={s.field}>
    <Text style={ui.label}>Invite for {link.name}</Text>
    <Button title="Share invite" accessibilityLabel={`Share invite for ${link.name}`} disabled={disabled} onPress={onShare} />
  </View>;
}

function InviteRow({ invite, name, disabled, onApprove, onRevoke }: { invite: Invite; name: string; disabled: boolean; onApprove: () => void; onRevoke: () => void }) {
  const { palette: colors, ui } = useUI();
  return <View style={[s.row, { borderBottomColor: colors.line }]}>
    <Text style={ui.rowTitle}>{name}</Text>
    <Text style={ui.caption}>{invite.approved ? 'Account approved' : invite.intended_email || (invite.claimant_email ? `Requested by ${invite.claimant_email}` : 'Waiting for someone to request to join.')}</Text>
    {!invite.intended_email && !invite.approved && invite.claimant_id != null && invite.claimant_email && <Button title="Approve request" accessibilityLabel={`Approve ${invite.claimant_email} for ${name}`} kind="primary" disabled={disabled} onPress={onApprove} />}
    <Button title="Revoke invite" accessibilityLabel={`Revoke invite for ${name}`} kind="text" disabled={disabled} onPress={onRevoke} />
  </View>;
}

function PreviousBalanceRow({ person, selfId, balance, agreed }: { person: Participant; selfId: string; balance: string; agreed: boolean }) {
  const { palette: colors, ui } = useUI();
  return <View style={ui.row}>
    <View style={ui.rowBody}><Text style={ui.rowTitle}>{person.name}{person.id === selfId && person.name.toLowerCase() !== 'you' ? ' (you)' : ''}</Text>
      {agreed && <Text style={ui.rowSub}>Agreed</Text>}</View>
    <Text style={[s.amount, { color: colors.text }]}>{balanceDescription(balance)}</Text>
  </View>;
}

export default function MembersScreen(props: Props) {
  return <MemberSettings key={`${props.group.id}|${props.selfId}`} {...props} />;
}

function MemberSettings({ group, selfId, busy, addPersonRequest = 0, onAction, onMembership }: Props) {
  const { ui } = useUI();
  const [newName, setNewName] = useState(''), [newEmail, setNewEmail] = useState(''), [addingPerson, setAddingPerson] = useState(false);
  const pendingPerson = useRef<AddPersonRequest | null>(null), lastAddRequest = useRef(addPersonRequest);
  const addTrigger = useRef<HTMLElement | null>(null);
  function closeAddPerson() { Keyboard.dismiss(); setAddingPerson(false); requestAnimationFrame(() => addTrigger.current?.focus()); }
  const [namePersonId, setNamePersonId] = useState<string | null>(null), [personName, setPersonName] = useState('');
  const nameTrigger = useRef<HTMLElement | null>(null), pendingName = useRef<{ personId: string; name: string; id: string } | null>(null);
  const namePerson = group.participants.find(person => person.id === namePersonId);
  function closeName() { Keyboard.dismiss(); setNamePersonId(null); requestAnimationFrame(() => nameTrigger.current?.focus()); }
  const [emailPersonId, setEmailPersonId] = useState<string | null>(null), [personEmail, setPersonEmail] = useState('');
  const pendingContact = useRef<{ personId: string; email: string; id: string } | null>(null), emailTrigger = useRef<HTMLElement | null>(null), latestGroup = useRef(group), latestAction = useRef(onAction), mounted = useRef(true);
  latestGroup.current = group; latestAction.current = onAction;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const emailPerson = group.participants.find(person => person.id === emailPersonId);
  function closePersonEmail() { Keyboard.dismiss(); setEmailPersonId(null); requestAnimationFrame(() => emailTrigger.current?.focus()); }
  const [groupLink, setGroupLink] = useState(''), groupLinkCommand = useRef<string | null>(null);
  const [inviteLink, setInviteLink] = useState<InviteLink | null>(null);
  const [invitePerson, setInvitePerson] = useState<Participant | null>(null);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
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
  useEffect(() => { if (!organizer || group.archived || group.is_direct) setGroupLink(''); }, [organizer, group.archived, group.is_direct]);
  useEffect(() => {
    if (lastAddRequest.current === addPersonRequest) return;
    lastAddRequest.current = addPersonRequest;
    if (organizer && !group.is_direct && !group.archived && !disabled) {
      if (Platform.OS === 'web') addTrigger.current = document.querySelector<HTMLElement>('[aria-label="Add person"]') ?? document.activeElement as HTMLElement | null;
      setAddingPerson(true); setFeedback(null);
    }
  }, [addPersonRequest, organizer, group.is_direct, group.archived, disabled]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !addingPerson && !emailPersonId && !namePersonId) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !disabled && !inFlight.current) { event.preventDefault(); if (namePersonId) closeName(); else if (emailPersonId) closePersonEmail(); else closeAddPerson(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [addingPerson, emailPersonId, namePersonId, disabled]);
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

  async function deliverEmailInvite(person: Participant) {
    if (!mounted.current) return;
    const current = latestGroup.current, live = current.participants.find(value => value.id === person.id), actor = current.participants.find(value => value.id === selfId);
    if (current.id !== group.id || current.archived || actor?.removed || actor?.user_id == null || actor.user_id !== current.owner_id || !live || live.removed || live.user_id != null
      || live.email && live.email.trim().toLowerCase() !== person.email?.trim().toLowerCase()) throw new Error('The group or contact changed. Check it before sending.');
    const saved = person.email!;
    const request = emailInvitationRequest(person.id, saved, emailRequests[person.id], currentEmailInvite(latestGroup.current, person.id, saved), Crypto.randomUUID);
    setEmailRequests(current => ({ ...current, [person.id]: request }));
    setInviteCooldowns(current => ({ ...current, [person.id]: 60 }));
    const status = await sendInvitation(group.id, request, latestAction.current);
    setInviteCooldowns(current => ({ ...current, [person.id]: status.retryAfter }));
    if (status.state === 'sent' || status.state === 'linked') {
      setEmailRequests(current => { const next = { ...current }; delete next[person.id]; return next; });
      setInvitePerson(null);
    } else if (status.state === 'failed') throw new Error('Could not send the invite. Wait a minute, then press Send.');
    else throw new Error('Could not confirm the invite. Wait a minute, then press Send to check.');
  }

  function sendEmailInvite(person: Participant) {
    const saved = person.email ?? '';
    if (disabled || inviteCooldowns[person.id]) return;
    if (!organizer || person.removed || person.user_id != null || !saved || group.archived || (person.id === directPerson?.id && emailChanged)) {
      setFeedback({ section: `email-invite:${person.id}`, text: 'The group or contact changed. Close and check it before sending.', error: true });
      return;
    }
    void perform(`email-invite:${person.id}`, async () => {
      setFeedback({ section: `email-invite:${person.id}`, text: '', error: false });
      await deliverEmailInvite(person);
    });
  }

  function sendConfirmedInvite() {
    if (!invitePerson) return;
    if (inviteCooldowns[invitePerson.id]) {
      setFeedback({ section: `email-invite:${invitePerson.id}`, text: 'Wait a minute, then press Send to try again.', error: true });
      return;
    }
    sendEmailInvite(invitePerson);
  }

  function editPersonEmail(person: Participant) {
    if (disabled || !organizer || group.is_direct || group.archived || person.removed || person.user_id != null || person.id === selfId || person.email) return;
    if (Platform.OS === 'web') emailTrigger.current = document.activeElement as HTMLElement | null;
    setEmailPersonId(person.id); setPersonEmail(''); setFeedback(null);
  }

  function editName(person: Participant) {
    if (disabled || !organizer || group.archived || person.removed || person.user_id != null || person.id === selfId) return;
    if (Platform.OS === 'web') nameTrigger.current = document.activeElement as HTMLElement | null;
    setNamePersonId(person.id); setPersonName(person.name); setFeedback(null);
  }

  function saveName() {
    const current = latestGroup.current, person = current.participants.find(value => value.id === namePersonId), actor = current.participants.find(value => value.id === selfId);
    if (current.id !== group.id || actor?.removed || actor?.user_id == null || actor.user_id !== current.owner_id || current.archived || !person || person.removed || person.user_id != null || person.id === selfId) return;
    void perform('person-name', async () => {
      const name = personName.trim();
      if (!name || name.length > 120) throw new Error('Enter a name up to 120 characters.');
      const request = pendingName.current?.personId === person.id && pendingName.current.name === name ? pendingName.current : { personId: person.id, name, id: Crypto.randomUUID() };
      pendingName.current = request;
      const result = await latestAction.current(`/participants/${person.id}/name`, { command_id: request.id, name });
      if (result.id !== current.id || !Number.isSafeInteger(result.version) || Number(result.version) < 1) throw new Error('Could not confirm the name. Try again.');
      pendingName.current = null;
      if (mounted.current && latestGroup.current.id === current.id) closeName();
    });
  }

  function savePersonEmail() {
    const current = latestGroup.current, person = current.participants.find(value => value.id === emailPersonId);
    if (!organizer || current.is_direct || current.archived || !person || person.removed || person.user_id != null || person.id === selfId) return;
    void perform(`email-invite:${person.id}`, async () => {
      const email = personEmail.trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email.');
      if (person.email && person.email.trim().toLowerCase() !== email) throw new Error('This contact changed. Close and check it before sending.');
      const request = pendingContact.current?.personId === person.id && pendingContact.current.email === email
        ? pendingContact.current : { personId: person.id, email, id: Crypto.randomUUID() };
      pendingContact.current = request;
      await saveContact(current.id, person.id, { command_id: request.id, email }, latestAction.current);
      pendingContact.current = null; closePersonEmail();
      try { await deliverEmailInvite({ ...person, email }); }
      catch (error) { throw new Error(`Contact saved. ${error instanceof Error ? error.message : 'Check the invitation before retrying.'}`); }
    });
  }

  function savePerson() {
    if (!organizer || group.is_direct || group.archived) return;
    void perform('add-person', async () => {
      const request = personRequest(newName, newEmail, pendingPerson.current, Crypto.randomUUID);
      pendingPerson.current = request;
      const result = await addPerson(group.id, request, onAction);
      pendingPerson.current = null;
      setNewName(''); setNewEmail(''); closeAddPerson();
      if (request.email && !result.linked) setInvitePerson({ id: request.id, name: request.name, email: request.email });
    });
  }

  async function createGroupLink() {
    if (!organizer || group.is_direct || group.archived) return;
    closeAddPerson();
    await perform('group-link', async () => {
      groupLinkCommand.current ??= Crypto.randomUUID();
      const result = await onAction('/invite-link', { command_id: groupLinkCommand.current });
      const url = confirmedGroupInvite(group.id, result);
      if (mounted.current && latestGroup.current.id === group.id && latestGroup.current.owner_id === self?.user_id && !latestGroup.current.archived) setGroupLink(url);
    });
  }

  return <View style={s.content}>
    {organizer && !group.is_direct && <View style={s.section}>
      <Button title="Invite with a link" disabled={disabled || !!group.archived} onPress={() => void createGroupLink()} />
      {!!groupLink && !group.archived && <>
        <Text style={ui.caption}>Anyone with this link can join. It is reusable and does not expire.</Text>
        <Text selectable style={ui.body}>{groupLink}</Text>
        {Platform.OS === 'web' ? <Button title="Copy link" disabled={disabled} onPress={() => void perform('group-link', async () => { await navigator.clipboard.writeText(groupLink); }, 'Link copied.')} />
          : <Button title="Share link" disabled={disabled} onPress={() => void perform('group-link', async () => { await Share.share({ message: `Join ${group.name}: ${groupLink}` }); })} />}
      </>}
      <FeedbackNote section="group-link" feedback={feedback} />
    </View>}
    <View>
      {group.participants.map(person => <MemberRow key={person.id} group={group} person={person} selfId={selfId} organizer={organizer} disabled={disabled} working={working} feedback={feedback}
        cooldown={inviteCooldowns[person.id] ?? 0} contactChanged={person.id === directPerson?.id && emailChanged}
        onRename={() => editName(person)} onAddEmail={() => editPersonEmail(person)} onSend={() => sendEmailInvite(person)} onRemove={() => confirm(
            `Remove ${person.name}?`, `${person.user_id != null ? 'They will lose access to this group. ' : ''}Existing bills and payment history remain.`,
            () => void perform('members', async () => { await onAction(`/participants/${person.id}/remove`, {}); }, 'Person removed.'), 'Remove')} />)}
    </View>
    {directPerson && <Disclosure title="Contact email">
      <Field label="Email (optional)" value={email} onChange={value => { setContactEmail(value); setFeedback(null); }} disabled={disabled || !!group.archived} keyboardType="email-address" maxLength={254} />
      {emailChanged && <Button title="Save contact" disabled={disabled || !!group.archived} onPress={() => void perform('contact', async () => {
        await onAction(`/participants/${directPerson.id}/contact`, { email: email.trim() });
        setContactEmail(null);
        setEmailRequests(current => { const next = { ...current }; delete next[directPerson.id]; return next; });
        setInviteCooldowns(current => ({ ...current, [directPerson.id]: 0 }));
      }, 'Contact saved. No invitation was sent.')} />}
      <FeedbackNote section="contact" feedback={feedback} />
      <Text style={ui.caption}>{emailChanged ? 'Save before sending an invitation.' : savedEmail ? 'Only this email can accept the invitation.' : 'Add an email to invite them later.'}</Text>
      {!!group.archived && <Text style={ui.caption}>Reopen this group to change the email or send an invitation.</Text>}
    </Disclosure>}
    <EditNameDialog person={namePerson} name={personName} disabled={disabled} working={working} unavailable={!organizer || !!group.archived || !!namePerson?.removed || namePerson?.user_id != null} onName={setPersonName} onClose={closeName} onSave={saveName} feedback={feedback} />
    <PersonEmailDialog person={emailPerson} email={personEmail} disabled={disabled} working={working} unavailable={!organizer || !!group.archived || !!emailPerson?.removed || emailPerson?.user_id != null} onEmail={setPersonEmail} onClose={closePersonEmail} onSave={savePersonEmail} feedback={feedback} />
    <AddPersonDialog visible={addingPerson} disabled={disabled} working={working} archived={!!group.archived} name={newName} email={newEmail}
      onName={setNewName} onEmail={setNewEmail} onClose={closeAddPerson} onSave={savePerson} onLink={() => void createGroupLink()} feedback={feedback} />
    <SendInviteDialog visible={!!invitePerson} email={invitePerson?.email ?? ''} busy={disabled}
      error={feedback?.error && feedback.section === `email-invite:${invitePerson?.id}` ? feedback.text : ''}
      onSend={sendConfirmedInvite} onCancel={() => { if (!disabled) { setInvitePerson(null); setFeedback(null); } }} />
    <FeedbackNote section="members" feedback={feedback} />

    {organizer && hasInvites && <Disclosure title="Invite people">
      {group.participants.filter(person => !person.removed && person.user_id == null && !person.email).map(person => <ManualInviteRow key={person.id} name={person.name} disabled={disabled || !!group.archived} onInvite={() => void perform('invites', async () => {
          const result = await onAction('/invites', { participant_id: person.id });
          if (typeof result.url !== 'string' || !/^https?:\/\//.test(result.url)) throw new Error('The link is not available yet. Sync and try again.');
          const link = { participantId: person.id, name: person.name, url: result.url };
          setInviteLink(link);
          const shared = await Share.share({ message: `Join ${group.name} as ${link.name}: ${publicAppUrl(link.url)}` });
          if (shared.action === Share.sharedAction) setInviteLink(null);
        })} />)}
      {inviteLink && <ShareInviteRow link={inviteLink} disabled={disabled || !!group.archived} onShare={() => void perform('invites', async () => {
          const shared = await Share.share({ message: `Join ${group.name} as ${inviteLink.name}: ${publicAppUrl(inviteLink.url)}` });
          if (shared.action === Share.sharedAction) setInviteLink(null);
        })} />}
      {(group.invites ?? []).filter(invite => !invite.revoked).map(invite => <InviteRow key={invite.id} invite={invite} name={name(invite.participant_id)} disabled={disabled || !!group.archived}
        onApprove={() => confirm(
          `Approve this account for ${name(invite.participant_id)}?`, `${invite.claimant_email}\nConfirm that this is the person you invited. They will be able to see and change this group's records.`,
          () => void perform('invites', async () => { await onAction(`/invites/${invite.id}/approve`, {}); }, 'Account approved.'), 'Approve')}
        onRevoke={() => confirm(
          'Revoke this invitation?', `This link will stop opening ${group.name}. An already approved account will keep its group membership.`,
          () => void perform('invites', async () => {
            await onAction(`/invites/${invite.id}/revoke`, {});
            if (inviteLink?.participantId === invite.participant_id) setInviteLink(null);
          }, 'Invitation revoked.'), 'Revoke')} />)}
      <FeedbackNote section="invites" feedback={feedback} />
    </Disclosure>}

    {opening && <Disclosure title="Previous balances" initialOpen={needsOpeningAgreement}>
        <Text style={[ui.notice, opening.accepted ? ui.success : ui.warning]}>{opening.accepted ? 'Agreed and included in balances.' : 'Waiting for agreement. Not included in balances yet.'}</Text>
        <Text style={ui.body}>From {opening.source}</Text><Text style={ui.caption}>As of {opening.cutoff}</Text>
        {group.participants.map(person => <PreviousBalanceRow key={person.id} person={person} selfId={selfId} balance={opening.balances[person.id] ?? '0'} agreed={Object.hasOwn(opening.acknowledgments, person.id)} />)}
        {needsOpeningAgreement && <>
          <Button title="I agree to my previous balance" kind="primary" disabled={disabled || !!group.archived} onPress={() => confirm(
            'Agree to your previous balance?', `${balanceDescription(opening.balances[selfId])}. From ${opening.source}, as of ${opening.cutoff}. It affects balances once all required members agree.`,
            () => void perform('opening', async () => { await onAction(`/opening-balances/${opening.id}/acknowledge`, {}); }, 'Your agreement was saved.'), 'Agree')} />
          {group.archived && <Text style={ui.caption}>Reopen the group before agreeing to previous balances.</Text>}
        </>}

      <FeedbackNote section="opening" feedback={feedback} />
    </Disclosure>}

      {organizer && <>
        <Button icon="archive" title={group.archived ? 'Reopen group' : 'Archive group'} kind="text" disabled={disabled} onPress={() => confirm(
          group.archived ? 'Reopen this group?' : 'Archive this group?', group.archived ? 'Members can add expenses again.' : 'Existing records stay available. Reopen the group to add expenses again.',
          () => void perform('archive', async () => { await onAction('/archive', { archived: !group.archived }); }, group.archived ? 'Group reopened.' : 'Group archived.'), group.archived ? 'Reopen' : 'Archive')} />
        <FeedbackNote section="archive" feedback={feedback} />
      </>}
    <GroupMembershipActions hidden={!!group.hidden} busy={disabled} canLeave={BigInt(group.balances[selfId] ?? '0') === 0n}
      blockedReason={BigInt(group.balances[selfId] ?? '0') !== 0n ? 'Settle your balance before deleting this group.' : undefined}
      onLeave={() => onMembership('leave')} onRestore={() => onMembership('restore')} />
  </View>;
}

const s = StyleSheet.create({
  content: { gap: 10 },
  section: { gap: 8, paddingVertical: 4 },
  row: { gap: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  field: { gap: 8 },
  amount: { fontSize: 17, fontWeight: '600', flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
