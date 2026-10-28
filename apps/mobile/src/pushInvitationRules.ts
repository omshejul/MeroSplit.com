import type { CachedGroup, Command } from './types';

export type PushOpportunity = { owner: string; token: string; groupId: string; expenseId?: string };

export function pushOpportunityReady(opportunity: PushOpportunity | null, owner: string, token: string | undefined, selected: CachedGroup | null, commands: Command[]): boolean {
  if (!opportunity || opportunity.owner !== owner || opportunity.token !== token || selected?.kind !== 'shared'
    || selected.group.id !== opportunity.groupId || selected.group.archived || selected.group.version < 1
    || commands.some(command => command.group_id === opportunity.groupId)) return false;
  const bills = [...selected.group.expenses, ...(selected.group.transactions?.flatMap(row => row.kind === 'bill' ? [row.bill] : []) ?? [])];
  return bills.some(bill => !bill.deleted && (!opportunity.expenseId || bill.id === opportunity.expenseId));
}
