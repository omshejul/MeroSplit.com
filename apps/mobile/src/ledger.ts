import { addExpense, addSettlement, proposeTransfers, validateExpense } from './accounting.ts';
import type { Command, Expense, Group, Participant } from './types';

export function emptyGroup(id: string, name: string, participants: Participant[]): Group {
  if (!name.trim() || name.trim().length > 120 || !participants.length || participants.length > 100 || participants.some(p => !p.name.trim() || p.name.length > 120)) throw new Error('Enter group/participant names of at most 120 characters, with 1 to 100 participants.');
  return { id, name: name.trim(), version: 0, participants, expenses: [], settlements: [], balances: Object.fromEntries(participants.map(p => [p.id, '0'])), transfers: [], activity: [] };
}

export function recalculateLocal(group: Group): Group {
  let balances = Object.fromEntries(group.participants.map(p => [p.id, '0']));
  for (const expense of group.expenses) if (!expense.deleted) balances = addExpense(balances, expense.paid, expense.shares);
  for (const settlement of group.settlements) if (!settlement.reversed) balances = addSettlement(balances, settlement.sender, settlement.recipient, settlement.amount);
  return { ...group, balances, transfers: proposeTransfers(balances) };
}

export function putLocalExpense(group: Group, input: Omit<Expense, 'shares'>): Group {
  const vectors = validateExpense(input.total, input.paid, input.split, group.participants.map(p => p.id));
  const expenses = group.expenses.filter(expense => expense.id !== input.id);
  expenses.push({ ...input, ...vectors });
  return recalculateLocal({ ...group, version: group.version + 1, expenses });
}

// Accepted balances remain untouched. This is explicitly a pending preview.
export function previewPending(accepted: Group, commands: Command[]): Group {
  let group: Group = JSON.parse(JSON.stringify(accepted));
  for (const command of commands.filter(row => row.group_id === accepted.id)) {
    const body = command.body;
    if (/\/expenses(?:\/[^/]+)?$/.test(command.path) && command.method !== 'DELETE') {
      const input = body as unknown as Omit<Expense, 'shares'>;
      const before = group.expenses.find(expense => expense.id === input.id);
      if (before && !before.deleted) group.balances = addExpense(group.balances, before.paid, before.shares, -1n);
      const vectors = validateExpense(input.total, input.paid, input.split, group.participants.map(p => p.id));
      group.balances = addExpense(group.balances, vectors.paid, vectors.shares);
      group.expenses = [...group.expenses.filter(expense => expense.id !== input.id), { ...input, ...vectors, deleted: false, version: before?.version ?? 0 }];
    } else if (command.method === 'DELETE' && command.path.includes('/expenses/')) {
      const id = command.path.split('/').at(-1);
      const before = group.expenses.find(expense => expense.id === id);
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
      if (expense?.deleted) {
        group.balances = addExpense(group.balances, expense.paid, expense.shares);
        group.expenses = group.expenses.map(value => value.id === id ? { ...value, deleted: false } : value);
      }
    } else if (command.path.endsWith('/reverse') && command.path.includes('/settlements/')) {
      const id = command.path.split('/').at(-2), settlement = group.settlements.find(value => value.id === id);
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
