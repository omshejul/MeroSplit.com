import { accountOwner, ApiError, request, syncOutbox } from './api.ts';
import { discardCommand, enqueue, pendingCommands, readDraft, saveDraft, saveGroup } from './storage.ts';
import type { Database } from './storage.ts';
import type { Command, Group, Session, Settlement } from './types.ts';
import { PaymentReturnReviewError } from './paymentReturn.ts';
import type { PaymentReturn } from './paymentReturn.ts';
import { MAX_AMOUNT } from './accounting.ts';

const key = (attemptId: string) => `payment-return:${attemptId}`;
function validReminder(value: PaymentReturn): boolean {
  return !!value && value.schemaVersion === 1 && Number.isSafeInteger(value.groupVersion) && value.groupVersion > 0
    && ['groupId', 'attemptId', 'sender', 'recipient', 'amount', 'payeeName', 'vpa', 'yesCommandId', 'noCommandId', 'settlementId', 'date'].every(name => typeof value[name as keyof PaymentReturn] === 'string' && String(value[name as keyof PaymentReturn]).length > 0)
    && /^[1-9]\d{0,9}$/.test(value.amount) && BigInt(value.amount) <= MAX_AMOUNT && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && ['prepared', 'opening', 'opened', 'failed'].includes(value.launch) && [null, 'paid', 'unpaid'].includes(value.decision)
    && ['handoffConfirmed', 'leftApp', 'returned', 'reviewRequested'].every(name => typeof value[name as keyof PaymentReturn] === 'boolean');
}
export async function savePaymentReturn(db: Database, owner: string, record: PaymentReturn): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    const previous = await readDraft<PaymentReturn>(tx, owner, key(record.attemptId));
    if (previous) {
      const mutable = ['launch', 'handoffConfirmed', 'leftApp', 'returned', 'reviewRequested', 'decision'];
      if (Object.keys(previous).some(name => !mutable.includes(name) && previous[name as keyof PaymentReturn] !== record[name as keyof PaymentReturn]) || previous.decision !== null && previous.decision !== record.decision) throw new Error('This saved payment cannot be changed. Review it first.');
    }
    await saveDraft(tx, owner, key(record.attemptId), record);
  });
}
export async function listPaymentReturns(db: Database, owner: string): Promise<PaymentReturn[]> {
  const rows = await db.getAllAsync<{ body: string }>("SELECT body FROM drafts WHERE owner=? AND group_id LIKE 'payment-return:%' AND body<>'null' ORDER BY group_id LIMIT 50", owner);
  return rows.flatMap(row => {
    try { const value = JSON.parse(row.body) as PaymentReturn; return validReminder(value) ? [value] : []; }
    catch { return []; } // Keep unreadable local records available in the existing recovery export.
  });
}
export async function clearPaymentReturn(db: Database, owner: string, attemptId: string): Promise<void> { await saveDraft(db, owner, key(attemptId), null); }

type ExactAttempt = { id: string; sender: string; recipient: string; amount: string; state: string; current_group_version: number; settlement: Settlement | null };
export function paymentReturnCommand(record: PaymentReturn): Command {
  const paid = record.decision === 'paid', command_id = paid ? record.yesCommandId : record.noCommandId;
  if (record.decision === null) throw new Error('Choose whether you paid before recording.');
  return { command_id, group_id: record.groupId, base_version: record.groupVersion, method: 'POST', state: 'pending', error: null,
    path: `/groups/${record.groupId}/${paid ? 'settlements' : `payment-attempts/${record.attemptId}/cancel`}`,
    body: paid ? { command_id, id: record.settlementId, sender: record.sender, recipient: record.recipient, amount: record.amount, attempt_id: record.attemptId, date: record.date, expected_group_version: record.groupVersion } : { command_id } };
}

/** Uses one persisted command, then requires exact canonical evidence before clearing the reminder. */
export async function resolvePaymentReturn(db: Database, session: Session, record: PaymentReturn, send: typeof request = request, sync: typeof syncOutbox = syncOutbox): Promise<Group> {
  const owner = accountOwner(session), command = paymentReturnCommand(record);
  const saved = await readDraft<PaymentReturn>(db, owner, key(record.attemptId));
  if (!saved || JSON.stringify(paymentReturnCommand(saved)) !== JSON.stringify(command)) throw new PaymentReturnReviewError('Open the saved payment again before continuing.');
  const exact = async (group: Group) => {
    const attempt = await send<ExactAttempt>(session, `/groups/${record.groupId}/payment-attempts/${record.attemptId}?version=${group.version}`);
    if (attempt.id !== record.attemptId || attempt.sender !== record.sender || attempt.recipient !== record.recipient || attempt.amount !== record.amount || attempt.current_group_version !== group.version) throw new PaymentReturnReviewError('Payment details changed. Review the balance before continuing.');
    return attempt;
  };
  const groupRead = async () => {
    const group = await send<Group>(session, `/groups/${record.groupId}/summary`);
    if (group.id !== record.groupId || group.read_mode !== 'summary' || !group.history || !group.totals || !group.balances || !Array.isArray(group.transactions) || !Array.isArray(group.participants) || !Array.isArray(group.expenses) || !Array.isArray(group.settlements) || !Array.isArray(group.transfers) || !group.participants.some(value => value.id === record.sender && !value.removed && String(value.user_id) === session.userId)) throw new PaymentReturnReviewError('Could not load the complete payment. Refresh and review it again.');
    return group;
  };
  const complete = (attempt: ExactAttempt) => record.decision === 'unpaid' ? attempt.state === 'cancelled' :
    !!attempt.settlement && ['recorded', 'confirmed'].includes(attempt.state) && attempt.settlement.id === record.settlementId && attempt.settlement.sender === record.sender && attempt.settlement.recipient === record.recipient && attempt.settlement.amount === record.amount && !attempt.settlement.reversed;
  try {
    const queued = (await pendingCommands(db, owner)).find(value => value.command_id === command.command_id);
    if (!queued) {
      const group = await groupRead(), attempt = await exact(group);
      if (complete(attempt)) { await saveGroup(db, owner, group, 'shared'); await clearPaymentReturn(db, owner, record.attemptId); return group; }
      if (attempt.state !== 'prepared' || group.archived || !group.participants.some(value => value.id === record.recipient && !value.removed) || record.decision === 'paid' && group.version !== record.groupVersion) throw new PaymentReturnReviewError('This payment changed. Review the balance before recording.');
      await enqueue(db, owner, command);
    } else if (JSON.stringify(queued.body) !== JSON.stringify(command.body) || queued.path !== command.path || queued.method !== command.method || queued.state !== 'pending') throw new PaymentReturnReviewError('This saved update needs review. Open saved changes in Me.');
    await sync(db, session, 'summary');
    const group = await groupRead(), attempt = await exact(group);
    if (!complete(attempt)) throw new PaymentReturnReviewError('Review the current payment record before continuing.');
    await saveGroup(db, owner, group, 'shared');
    await discardCommand(db, owner, command.command_id);
    await clearPaymentReturn(db, owner, record.attemptId);
    return group;
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 409, 422].includes(error.status)) throw new PaymentReturnReviewError('This payment changed. Review the balance before continuing.');
    throw error;
  }
}
