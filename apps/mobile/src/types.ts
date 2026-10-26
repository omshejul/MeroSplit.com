import type { Amounts, Split, Transfer } from './accounting';

export type Participant = { id: string; name: string; recorded_name?: string; email?: string; account_email?: string | null; user_id?: number | null; removed?: boolean; payment_profile?: { vpa: string; version: number; bank_verified: false } | null };
export type Expense = {
  id: string; version: number; description: string; total: string;
  added_by?: string | null; reversal?: { actor_name?: string | null };
  paid: Amounts; shares: Amounts; split: Split; date: string; category: string; category_auto?: boolean | null; notes: string; deleted: boolean;
};
export type Settlement = { id: string; sender: string; recipient: string; amount: string; provenance?: string; method?: string; recorded_by?: number; recorded_by_name?: string | null; reversal?: { actor_name?: string | null }; date?: string | null; attempt_id?: string | null; reversed?: boolean };
export type BillRow = Pick<Expense, 'id' | 'version' | 'description' | 'total' | 'paid' | 'shares' | 'date' | 'category' | 'category_auto' | 'deleted'>;
export type GroupTransaction = { kind: 'bill'; date: string | null; bill: BillRow } | { kind: 'payment'; date: string | null; payment: Settlement };
export type ActivityTarget = { kind: 'bill'; groupId: string; expenseId: string } | { kind: 'payment'; groupId: string; settlementId: string } | { kind: 'group'; groupId: string };
export type ActivityPerson = { id: string; name: string; is_self: boolean };
export type ActivityItem = {
  id: string; kind: 'bill_added' | 'bill_edited' | 'bill_deleted' | 'bill_restored' | 'bill_reversed' | 'payment_recorded' | 'payment_reversed' | 'member_added' | 'member_joined' | 'member_removed' | 'group_created' | 'group_archived' | 'group_unarchived';
  created_at: string; group: { id: string; name: string }; actor: { name: string; is_self: boolean } | null;
  bill?: { id: string; description: string; deleted: boolean; category?: string; category_auto?: boolean | null };
  payment?: { id: string; sender: ActivityPerson; recipient: ActivityPerson; amount: string; reversed: boolean };
  person?: ActivityPerson;
};
export type ActivityPage = { read_mode: 'activity'; revision: string; items: ActivityItem[]; next_cursor: string | null };
export type HistoryResource = 'bills' | 'activity' | 'settlements' | 'attempts' | 'transactions';
export type HistoryWindow = { next_cursor: string | null; cursor?: string | null; previous?: (string | null)[]; query?: string };
export type Group = {
  read_mode?: 'summary'; focused_expense?: Expense; focused_settlement?: Settlement; history?: Partial<Record<HistoryResource, HistoryWindow>>; transactions?: GroupTransaction[];
  id: string; name: string; version: number; participants: Participant[]; expenses: Expense[];
  settlements: Settlement[]; balances: Amounts; transfers: Transfer[]; activity: unknown[];
  is_direct?: boolean; archived?: boolean; hidden?: boolean; owner_id?: number;
  opening_balance?: { id: string; balances: Amounts; source: string; cutoff: string; acknowledgments: Record<string, unknown>; accepted: boolean } | null;
  invites?: { id: string; participant_id: string; claimant_id: number | null; claimant_email: string | null; approved: boolean; revoked: boolean; intended_email?: string; send_state?: string; sent_at?: string | null; expires_at?: string }[];
  totals?: { spending: string; paid: Amounts; shares: Amounts };
  payment_attempts?: { id: string; sender: string; recipient: string; amount: string; state: string; recorded_amount?: string | null; settlement_id?: string | null }[];
};
export type CachedGroup = { group: Group; kind: 'local' | 'shared' | 'unavailable' };
export type Command = {
  command_id: string; group_id: string; base_version?: number | null; attempted?: boolean; method: 'POST' | 'PUT' | 'DELETE'; path: string;
  body: Record<string, unknown>; state: 'pending' | 'conflict' | 'rejected'; error: string | null;
};
export type Session = { token: string; userId: string; email: string; baseUrl: string; displayName?: string };
export type LegacySource = { group: Group; draft: unknown; commands: Command[] };
export type LegacyRecovery = LegacySource & { selfId: string; status: 'queued' | 'existing' | 'conflict'; reason: string | null };
