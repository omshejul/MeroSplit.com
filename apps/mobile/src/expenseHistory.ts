import { formatMoney } from './accounting.ts';

export type VersionChange = { field: string; before: unknown; after: unknown };
export type ExpenseVersion = { id: string; sequence: number; created_at: string; actor_name: string | null; names: Record<string, string>; currency: string; kind: 'created' | 'edited'; changes: VersionChange[]; labels_recorded: boolean; via_mcp?: boolean };
export type ExpenseHistoryPage = { group_id: string; expense_id: string; items: ExpenseVersion[]; next_before: number | null; legacy_gap: boolean; version: number };
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const modes: Record<string, string> = { equal: 'Equal split', exact: 'Custom amounts', percent: 'By percentage', shares: 'By shares' };
export const historyLabels: Record<string, string> = { description: 'Name', total: 'Amount', paid: 'Paid by', split: 'Split', date: 'Date', category: 'Category', notes: 'Note', deleted: 'Record' };
export const historyActions: Record<string, string> = { description: 'renamed the expense', total: 'changed the amount', paid: 'changed who paid', split: 'changed the split', date: 'changed the date', category: 'changed the category', notes: 'changed the note', deleted: 'reversed the bill record' };

export function historyValue(field: string, value: unknown, names: Record<string, string>, currency: string) {
  if (value === null || value === undefined) return 'Not recorded';
  const money = (raw: unknown) => typeof raw === 'string' && /^\d+$/.test(raw) ? currency === 'INR' ? formatMoney(raw) : `${currency} ${raw}` : 'Not recorded';
  const name = (id: string) => names[id] || 'Name not recorded';
  if (field === 'total') return money(value);
  if (field === 'paid') return Object.entries(object(value)).filter(([, amount]) => amount !== '0').map(([id, amount]) => `${name(id)} ${money(amount)}`).join('\n') || 'None';
  if (field === 'split') {
    const split = object(object(value).definition), shares = object(object(value).shares), weights = object(split.values);
    return [modes[split.mode] || 'Split not recorded', ...Object.entries(shares).filter(([id]) => Object.hasOwn(weights, id)).map(([id, amount]) =>
      `${name(id)} ${money(amount)}${split.mode === 'percent' ? ` (${weights[id]}%)` : split.mode === 'shares' ? ` (${weights[id]} shares)` : ''}`)].join('\n');
  }
  if (field === 'deleted') return value ? 'Reversed' : 'Active';
  return typeof value === 'string' ? value || 'Empty' : 'Not recorded';
}

export function historyTime(value: string, now = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Time not recorded';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  const [unit, duration] = seconds < 3600 ? ['minute', 60] : seconds < 86400 ? ['hour', 3600] : ['day', 86400];
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' }).format(-Math.floor(seconds / Number(duration)), unit as Intl.RelativeTimeFormatUnit);
}
