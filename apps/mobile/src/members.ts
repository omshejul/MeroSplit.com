import type { Group } from './types.ts';

type Action = (suffix: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type AddPersonRequest = { command_id: string; id: string; name: string; email: string };
export type EmailInviteRequest = { personId: string; email: string; id: string };
export type PersonLinkResult = { linked: boolean; linkedParticipantIds: string[]; pending?: boolean };

export function personRequest(name: string, email: string, previous: AddPersonRequest | null, newId: () => string): AddPersonRequest {
  name = name.trim(); email = email.trim().toLowerCase();
  if (!name) throw new Error('Enter a name.');
  if (name.length > 120) throw new Error('Use a name of up to 120 characters.');
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Enter a valid email, or leave it empty.');
  if (previous?.name === name && previous.email === email) return previous;
  return { command_id: newId(), id: newId(), name, email };
}

function acceptedGroup(result: Record<string, unknown>, groupId: string) {
  if (result.id !== groupId || !Number.isSafeInteger(result.version) || Number(result.version) < 1) {
    throw new Error('Sync and check this change before trying again.');
  }
}

function personLinkResult(result: Record<string, unknown>, personId: string): PersonLinkResult {
  const ids = result.linked_participant_ids;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || id !== personId) || new Set(ids).size !== ids.length) {
    throw new Error('Sync and check this person before trying again.');
  }
  return { linked: ids.includes(personId), linkedParticipantIds: [...ids] };
}

export async function addPerson(groupId: string, request: AddPersonRequest, onAction: Action): Promise<PersonLinkResult> {
  const result = await onAction('/participants', request);
  if (result.pending === true && result.id === groupId && result.participant_id === request.id) return { linked: false, linkedParticipantIds: [], pending: true };
  acceptedGroup(result, groupId);
  return personLinkResult(result, request.id);
}

export async function saveContact(groupId: string, personId: string, body: { command_id: string; email: string }, onAction: Action) {
  acceptedGroup(await onAction(`/participants/${personId}/contact`, body), groupId);
}

export function currentEmailInvite(group: Group, personId: string, email: string) {
  return group.invites?.filter(invite => invite.participant_id === personId && !invite.revoked && !invite.approved
    && invite.intended_email === email && (!invite.expires_at || Date.parse(invite.expires_at) > Date.now()))
    .sort((a, b) => (b.expires_at ?? '').localeCompare(a.expires_at ?? ''))[0];
}

export function emailInvitationRequest(personId: string, email: string, previous: EmailInviteRequest | undefined,
  invite: ReturnType<typeof currentEmailInvite>, newId: () => string): EmailInviteRequest {
  if (previous?.personId === personId && previous.email === email) return previous;
  return { personId, email, id: invite && ['failed', 'sending'].includes(invite.send_state ?? '') ? invite.id : newId() };
}

export async function sendInvitation(groupId: string, request: EmailInviteRequest, onAction: Action) {
  const result = await onAction(`/participants/${request.personId}/email-invite`, { command_id: request.id });
  acceptedGroup(result, groupId);
  const linked = personLinkResult(result, request.personId);
  if (linked.linked) {
    if (result.invite !== undefined) throw new Error('Sync and check this invitation before trying again.');
    return { ...linked, state: 'linked' as const, retryAfter: 0 };
  }
  const status = result.invite as { id?: string; state?: string; retry_after?: number } | undefined;
  if (!status || status.id !== request.id || !['sent', 'failed', 'sending'].includes(status.state ?? '')) {
    throw new Error('Sync and check this invitation before trying again.');
  }
  return { ...linked, state: status.state!, retryAfter: Number.isFinite(status.retry_after) ? Math.max(0, Math.min(60, Math.ceil(status.retry_after!))) : 60 };
}
