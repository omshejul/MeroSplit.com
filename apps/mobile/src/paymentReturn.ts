/** A local reminder, never evidence of a bank transfer. All identity fields are frozen before opening UPI. */
export type PaymentReturn = {
  schemaVersion: 1;
  groupId: string; groupVersion: number; attemptId: string; sender: string; recipient: string; amount: string; payeeName: string; vpa: string;
  yesCommandId: string; noCommandId: string; settlementId: string; date: string;
  launch: 'prepared' | 'opening' | 'opened' | 'failed';
  handoffConfirmed: boolean; leftApp: boolean; returned: boolean; reviewRequested: boolean;
  decision: 'paid' | 'unpaid' | null;
};
type Identity = Pick<PaymentReturn, 'groupId' | 'groupVersion' | 'attemptId' | 'sender' | 'recipient' | 'amount' | 'payeeName' | 'vpa' | 'yesCommandId' | 'noCommandId' | 'settlementId' | 'date'>;
export class PaymentReturnReviewError extends Error {}
export function createPaymentReturn(identity: Identity): PaymentReturn {
  return { ...identity, schemaVersion: 1, launch: 'prepared', handoffConfirmed: false, leftApp: false, returned: false, reviewRequested: false, decision: null };
}
export type PaymentReturnEvent =
  | { type: 'opening' | 'failed' | 'background' | 'active' | 'review' }
  | { type: 'opened'; handoffConfirmed: boolean }
  | { type: 'decision'; paid: boolean };

export function paymentReturnEvent(record: PaymentReturn, event: PaymentReturnEvent): PaymentReturn {
  // A retry cannot change the answer or reset the immutable command identity.
  if (record.decision !== null) return record;
  switch (event.type) {
    case 'opening': return { ...record, launch: 'opening', handoffConfirmed: false, leftApp: false, returned: false, reviewRequested: false };
    case 'opened': return record.launch === 'opening' ? { ...record, launch: 'opened', handoffConfirmed: event.handoffConfirmed } : record;
    case 'failed': return { ...record, launch: 'failed', handoffConfirmed: false, leftApp: false, returned: false, reviewRequested: false };
    case 'background': return !record.leftApp && ['opening', 'opened'].includes(record.launch) ? { ...record, leftApp: true } : record;
    case 'active': return !record.returned && record.leftApp && ['opening', 'opened'].includes(record.launch) ? { ...record, returned: true } : record;
    case 'review': return ['prepared', 'opening', 'opened'].includes(record.launch) ? { ...record, reviewRequested: true } : record;
    case 'decision': return paymentReturnNeedsConfirmation(record) ? { ...record, decision: event.paid ? 'paid' : 'unpaid' } : record;
  }
}

export function paymentReturnNeedsConfirmation(record: PaymentReturn): boolean {
  return record.decision !== null || record.reviewRequested || record.launch === 'opened' && record.handoffConfirmed && record.leftApp && record.returned;
}

/** Persist before opening; lifecycle events may arrive before openURL resolves. */
export async function launchPaymentReturn(
  arm: () => Promise<void>,
  transition: (event: PaymentReturnEvent) => Promise<void>,
  open: () => Promise<unknown>,
  handoffConfirmed: boolean,
): Promise<void> {
  await arm();
  await transition({ type: 'opening' });
  let result: unknown;
  try { result = await open(); }
  catch (error) { await transition({ type: 'failed' }); throw error; }
  // The Android chooser adapter returns false on cancellation, even if the
  // chooser itself caused AppState background/active events.
  if (result === false) { await transition({ type: 'failed' }); return; }
  await transition({ type: 'opened', handoffConfirmed });
}
