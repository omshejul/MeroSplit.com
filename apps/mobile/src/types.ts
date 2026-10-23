import type { Amounts, Split, Transfer } from './accounting';

export type Participant = { id: string; name: string; user_id?: number | null; removed?: boolean; payment_profile?: { vpa: string; version: number; bank_verified: false } | null };
export type Expense = {
  id: string; version: number; description: string; total: string;
  paid: Amounts; shares: Amounts; split: Split; date: string; category: string; notes: string; deleted: boolean;
};
export type Settlement = { id: string; sender: string; recipient: string; amount: string; provenance?: string; method?: string; recorded_by?: number; date?: string | null; attempt_id?: string | null; reversed?: boolean };
export type Group = {
  id: string; name: string; version: number; participants: Participant[]; expenses: Expense[];
  settlements: Settlement[]; balances: Amounts; transfers: Transfer[]; activity: unknown[];
  is_direct?: boolean; archived?: boolean; owner_id?: number;
  opening_balance?: { id: string; balances: Amounts; source: string; cutoff: string; acknowledgments: Record<string, unknown>; accepted: boolean } | null;
  invites?: { id: string; participant_id: string; claimant_id: number | null; claimant_email: string | null; approved: boolean; revoked: boolean }[];
  totals?: { spending: string; paid: Amounts; shares: Amounts };
  payment_attempts?: { id: string; sender: string; recipient: string; amount: string; state: string; recorded_amount?: string | null; settlement_id?: string | null }[];
};
export type CachedGroup = { group: Group; kind: 'local' | 'shared' | 'unavailable' };
export type Command = {
  command_id: string; group_id: string; method: 'POST' | 'PUT' | 'DELETE'; path: string;
  body: Record<string, unknown>; state: 'pending' | 'conflict' | 'rejected'; error: string | null;
};
export type Session = { token: string; userId: string; email: string; baseUrl: string };
export type LegacySource = { group: Group; draft: unknown; commands: Command[] };
export type LegacyRecovery = LegacySource & { selfId: string; status: 'queued' | 'existing' | 'conflict'; reason: string | null };
