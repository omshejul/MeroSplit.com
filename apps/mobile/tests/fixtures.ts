import { addExpense, addSettlement, proposeTransfers, validateExpense } from '../src/accounting.ts';
import type { Expense, Group } from '../src/types.ts';

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
