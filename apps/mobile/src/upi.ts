import { integer, MAX_AMOUNT } from './accounting.ts';
import type { Group } from './types.ts';

export type UPIPayment = { sender: string; recipient: string; amount: string };
export type UPILaunchQuote = {
  id: string; vpa: string; amount: string; currency: string; recipient: string; note: string;
  bank_verified: false; direct_launch_supported: boolean; expires_at: string; group_version: number;
};
export type UPIApp = { id: 'phonepe' | 'google-pay' | 'paytm' | 'cred' | 'bhim' | 'amazon-pay' | 'upi'; name: string };
const vpaPattern = /^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$/;
export const validUPIAddress = (value: string) => value.length <= 254 && vpaPattern.test(value);
// Ordinary-payment routes from the user's QRScanner reference. A detected
// handler is not proof that the installed version accepts a payment request.
const prefixes = {
  phonepe: 'phonepe://upi/pay', 'google-pay': 'gpay://upi/pay', paytm: 'paytmmp://upi/pay',
  cred: 'credpay://upi/pay', bhim: 'bhim://upi/pay', 'amazon-pay': 'amazonpay://upi/pay', upi: 'upi://pay',
};

export function validateUPIPayment(group: Group, selfId: string, payment: UPIPayment): { vpa: string; name: string } {
  const sender = group.participants.find(person => person.id === payment.sender && !person.removed);
  const recipient = group.participants.find(person => person.id === payment.recipient && !person.removed);
  if (group.archived) throw new Error('Reopen this group before paying.');
  if (!sender || sender.id !== selfId || !recipient || recipient.id === sender.id) throw new Error('You can pay only your own outstanding balance.');
  const amount = integer(payment.amount), debt = group.transfers.find(row => row.sender === sender.id && row.recipient === recipient.id);
  if (amount <= 0n || amount > MAX_AMOUNT || !debt || amount > integer(debt.amount)) throw new Error('Enter an amount up to the current amount you owe this person.');
  const vpa = recipient.payment_profile?.vpa;
  if (!recipient.user_id || !vpa || vpa.length > 254 || !vpaPattern.test(vpa)) throw new Error(recipient.user_id ? 'Ask this person to add their UPI address. You can still record a payment made outside MeroSplit.' : 'Ask this person to join and add their UPI address. You can still record a payment made outside MeroSplit.');
  return { vpa, name: recipient.name };
}

export function buildUPIUrl(quote: UPILaunchQuote, app: UPIApp['id'] = 'upi'): string {
  const amount = integer(quote.amount);
  if (quote.currency !== 'INR') throw new Error('UPI is available for Indian rupees only.');
  if (!quote.direct_launch_supported) throw new Error('UPI opening is unavailable. Use the payment address in your UPI app.');
  if (amount <= 0n || amount > MAX_AMOUNT || !vpaPattern.test(quote.vpa) || quote.vpa.length > 254) throw new Error('The payment details are invalid. Refresh and review them again.');
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(quote.id) || !Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= Date.now()) throw new Error('These payment details expired. Review them again before paying.');
  if (typeof quote.recipient !== 'string' || !quote.recipient.trim() || quote.recipient.length > 120 || typeof quote.note !== 'string' || quote.note.length > 200 || !Number.isSafeInteger(quote.group_version) || quote.group_version < 1 || !Object.hasOwn(prefixes, app)) throw new Error('The payment details are invalid. Refresh and review them again.');
  const values = { pa: quote.vpa, pn: quote.recipient, am: `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`, cu: 'INR', tr: quote.id.replaceAll('-', '') };
  return `${prefixes[app]}?${Object.entries(values).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

export async function availableUPIApps(platform: string, canOpenURL: (url: string) => Promise<boolean>): Promise<UPIApp[]> {
  // Browser scheme probes do not establish whether a payment app is installed.
  if (platform !== 'ios' && platform !== 'android') return [];
  // iOS has app-specific handlers, not Android's generic UPI resolver. Do not
  // assume these iOS routes or installed-app detection work on other platforms.
  // Relative order matches the dated payer-app volume snapshot in upiDirectory.ts; generic stays last.
  const choices: UPIApp[] = platform === 'ios' ? [
    { id: 'phonepe', name: 'PhonePe' }, { id: 'google-pay', name: 'Google Pay' },
    { id: 'paytm', name: 'Paytm' }, { id: 'bhim', name: 'BHIM' }, { id: 'cred', name: 'CRED' },
    { id: 'amazon-pay', name: 'Amazon Pay' }, { id: 'upi', name: 'Other UPI app' },
  ] : [{ id: 'upi', name: 'UPI apps' }];
  const found = await Promise.all(choices.map(async app => { try { return await canOpenURL(prefixes[app.id]) ? app : null; } catch { return null; } }));
  return found.filter((app): app is UPIApp => app !== null);
}

export async function openUPIPayment(quote: UPILaunchQuote, app: UPIApp['id'], expected: { amount: string; vpa: string; name: string }, openURL: (url: string) => Promise<unknown>): Promise<unknown> {
  if (quote.amount !== expected.amount || quote.vpa !== expected.vpa || quote.recipient !== expected.name) throw new Error('The amount or recipient changed. Review the payment again.');
  const url = buildUPIUrl(quote, app);
  // Preserve the Android chooser's selection/cancellation signal. It still says
  // nothing about whether the user paid in the selected app.
  try { return await openURL(url); }
  catch { throw new Error('No UPI app opened. Use the payment address in your UPI app, or try another app.'); }
}
