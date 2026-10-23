import { addExpense, addSettlement, proposeTransfers, validateExpense } from './accounting.ts';
import type { Command, Expense, Group, Participant } from './types';

export function emptyGroup(id: string, name: string, participants: Participant[]): Group {
  if (!name.trim() || name.trim().length > 120 || !participants.length || participants.length > 100 || participants.some(p => !p.name.trim() || p.name.length > 120)) throw new Error('Enter group/participant names of at most 120 characters, with 1 to 100 participants.');
  return { id, name: name.trim(), version: 0, participants, expenses: [], settlements: [], balances: Object.fromEntries(participants.map(p => [p.id, '0'])), transfers: [], activity: [] };
}

// Local revision counters and server bookkeeping are not comparable. Keep the
// complete original separately; this comparison only decides whether to reuse
// an existing server ledger without uploading its bills again.
export function legacyMatchesServer(legacy: Group, canonical: Group): boolean {
  const sort = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const amounts = (values: Record<string, string>) => Object.entries(values).filter(([, value]) => value !== '0').sort(([a], [b]) => a.localeCompare(b));
  const content = (group: Group) => ({
    id: group.id, name: group.name, is_direct: !!group.is_direct, archived: !!group.archived,
    participants: sort(group.participants).map(({ id, name, recorded_name, removed }) => ({ id, name: recorded_name ?? name, removed: !!removed })),
    expenses: sort(group.expenses).map(({ id, description, total, paid, shares, split, date, category, notes, deleted }) => ({
      id, description, total, paid: amounts(paid), shares: amounts(shares), split: { mode: split.mode, values: amounts(split.values) }, date, category, notes, deleted,
    })),
    settlements: sort(group.settlements).map(({ id, sender, recipient, amount, reversed, date }) => ({
      id, sender, recipient, amount, reversed: !!reversed,
      // Early phone-only payments did not record a date.
      date: legacy.settlements.find(row => row.id === id)?.date ? date : undefined,
    })),
    opening_balance: group.opening_balance ? { balances: amounts(group.opening_balance.balances), source: group.opening_balance.source, cutoff: group.opening_balance.cutoff, accepted: group.opening_balance.accepted } : null,
  });
  return JSON.stringify(content(legacy)) === JSON.stringify(content(canonical));
}

// Accepted balances remain untouched. This is explicitly a pending preview.
export function previewPending(accepted: Group, commands: Command[]): Group {
  if (accepted.read_mode === 'summary' && commands.some(command => command.group_id === accepted.id && command.base_version !== accepted.version)) throw new Error('Balances show accepted records. Sync or review saved changes before previewing a new total.');
  let group: Group = JSON.parse(JSON.stringify(accepted));
  if (group.focused_expense && !group.expenses.some(value => value.id === group.focused_expense!.id)) group.expenses.push(group.focused_expense);
  for (const command of commands.filter(row => row.group_id === accepted.id)) {
    const body = command.body;
    if (/\/expenses(?:\/[^/]+)?$/.test(command.path) && command.method !== 'DELETE') {
      const input = body as unknown as Omit<Expense, 'shares'>;
      const before = group.expenses.find(expense => expense.id === input.id);
      if (group.read_mode === 'summary' && command.method === 'PUT' && !before) throw new Error('Open this saved bill online to review its pending balance.');
      if (before && !before.deleted) group.balances = addExpense(group.balances, before.paid, before.shares, -1n);
      const vectors = validateExpense(input.total, input.paid, input.split, group.participants.map(p => p.id));
      group.balances = addExpense(group.balances, vectors.paid, vectors.shares);
      group.expenses = [...group.expenses.filter(expense => expense.id !== input.id), { ...input, ...vectors, deleted: false, version: before?.version ?? 0 }];
    } else if (command.method === 'DELETE' && command.path.includes('/expenses/')) {
      const id = command.path.split('/').at(-1);
      const before = group.expenses.find(expense => expense.id === id);
      if (group.read_mode === 'summary' && !before) throw new Error('Open this saved bill online to review its pending balance.');
      if (before && !before.deleted) group.balances = addExpense(group.balances, before.paid, before.shares, -1n);
      group.expenses = group.expenses.map(expense => expense.id === id ? { ...expense, deleted: true } : expense);
    } else if (command.path.endsWith('/settlements')) {
      const { id, sender, recipient, amount } = body as Record<string, string>;
      if (!group.settlements.some(settlement => settlement.id === id)) {
        group.balances = addSettlement(group.balances, sender, recipient, amount);
        group.settlements.push({ id, sender, recipient, amount, provenance: 'pending_manual' });
      }
    } else if (command.path.endsWith('/restore') && command.path.includes('/expenses/')) {
      const id = command.path.split('/').at(-2), expense = group.expenses.find(value => value.id === id);
      if (group.read_mode === 'summary' && !expense) throw new Error('Open this saved bill online to review its pending balance.');
      if (expense?.deleted) {
        group.balances = addExpense(group.balances, expense.paid, expense.shares);
        group.expenses = group.expenses.map(value => value.id === id ? { ...value, deleted: false } : value);
      }
    } else if (command.path.endsWith('/reverse') && command.path.includes('/settlements/')) {
      const id = command.path.split('/').at(-2), settlement = group.settlements.find(value => value.id === id);
      if (group.read_mode === 'summary' && !settlement) throw new Error('Load this payment online to review its pending balance.');
      if (settlement && !settlement.reversed) {
        group.balances = addSettlement(group.balances, settlement.recipient, settlement.sender, settlement.amount);
        group.settlements = group.settlements.map(value => value.id === id ? { ...value, reversed: true } : value);
      }
    } else if (command.path.includes('/opening-balances') || command.path.endsWith('/confirm')) {
      throw new Error('This acknowledgment needs the accepted server result. Sync before viewing a pending total.');
    } else if (command.path !== '/groups' && !/\/(invites|archive|payment-attempts)(\/|$)/.test(command.path)) {
      throw new Error('Pending total is unavailable for this command until sync.');
    }
  }
  return { ...group, transfers: proposeTransfers(group.balances) };
}
