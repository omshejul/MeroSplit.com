import { addExpense, addSettlement, proposeTransfers, validateExpense } from './accounting.ts';
import type { Command, Expense, Group, GroupTransaction, Participant } from './types';

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
  function previewTransaction(row: GroupTransaction) {
    if (!group.transactions) return;
    const id = (value: GroupTransaction) => value.kind === 'bill' ? `bill:${value.bill.id}` : `payment:${value.payment.id}`;
    // Use accepted date/kind/id order, keeping its downloaded rows and cursors.
    const key = (value: GroupTransaction) => `${value.date ? 1 : 0}|${value.date ?? ''}|${id(value)}`;
    const rows = group.transactions.filter(value => id(value) !== id(row));
    const index = rows.findIndex(value => key(value) < key(row));
    rows.splice(index < 0 ? rows.length : index, 0, row);
    group.transactions = rows;
  }
  if (group.focused_expense && !group.expenses.some(value => value.id === group.focused_expense!.id)) group.expenses.push(group.focused_expense);
  for (const command of commands.filter(row => row.group_id === accepted.id)) {
    const body = command.body;
    if (command.method === 'POST' && command.path === `/groups/${group.id}/participants`) {
      const id = String(body.id), name = String(body.name).trim();
      if (!id || !name || group.participants.some(person => person.id === id)) throw new Error('Review this saved person before syncing.');
      group.participants.push({ id, name, recorded_name: name, email: String(body.email ?? ''), account_email: null, user_id: null });
      group.balances[id] = '0';
    } else if (command.method === 'POST' && /^\/groups\/[^/]+\/participants\/[^/]+\/name$/.test(command.path)) {
      const id = command.path.split('/').at(-2), person = group.participants.find(person => person.id === id);
      if (!person || person.removed || person.user_id != null) throw new Error('Review this saved person before syncing.');
      person.name = String(body.name).trim();
    } else if (/\/expenses(?:\/[^/]+)?$/.test(command.path) && command.method !== 'DELETE') {
      const input = body as unknown as Omit<Expense, 'shares'>;
      const before = group.expenses.find(expense => expense.id === input.id);
      if (group.read_mode === 'summary' && command.method === 'PUT' && !before) throw new Error('Open this saved bill online to review its pending balance.');
      if (before && !before.deleted) group.balances = addExpense(group.balances, before.paid, before.shares, -1n);
      const vectors = validateExpense(input.total, input.paid, input.split, group.participants.map(p => p.id));
      group.balances = addExpense(group.balances, vectors.paid, vectors.shares);
      const expense = { ...input, ...vectors, deleted: false, version: before?.version ?? 0 };
      group.expenses = [...group.expenses.filter(value => value.id !== input.id), expense];
      previewTransaction({ kind: 'bill', date: expense.date, bill: expense });
    } else if (command.method === 'POST' && command.path.endsWith('/reverse') && command.path.includes('/expenses/')) {
      const id = command.path.split('/').at(-2);
      const before = group.expenses.find(expense => expense.id === id);
      if (group.read_mode === 'summary' && !before) throw new Error('Open this saved bill online to review its pending balance.');
      if (before && !before.deleted) group.balances = addExpense(group.balances, before.paid, before.shares, -1n);
      group.expenses = group.expenses.map(expense => expense.id === id ? { ...expense, deleted: true } : expense);
      if (before) previewTransaction({ kind: 'bill', date: before.date, bill: { ...before, deleted: true } });
    } else if (command.path.endsWith('/settlements')) {
      const { id, sender, recipient, amount, date } = body as Record<string, string>;
      if (!group.settlements.some(settlement => settlement.id === id)) {
        group.balances = addSettlement(group.balances, sender, recipient, amount);
        const payment = { id, sender, recipient, amount, date, provenance: 'pending_manual' };
        group.settlements.push(payment);
        previewTransaction({ kind: 'payment', date: date ?? null, payment });
      }
    } else if (command.path.endsWith('/reverse') && command.path.includes('/settlements/')) {
      const id = command.path.split('/').at(-2), settlement = group.settlements.find(value => value.id === id);
      if (group.read_mode === 'summary' && !settlement) throw new Error('Load this payment online to review its pending balance.');
      if (settlement && !settlement.reversed) {
        group.balances = addSettlement(group.balances, settlement.recipient, settlement.sender, settlement.amount);
        group.settlements = group.settlements.map(value => value.id === id ? { ...value, reversed: true } : value);
        previewTransaction({ kind: 'payment', date: settlement.date ?? null, payment: { ...settlement, reversed: true } });
      }
    } else if (command.path.includes('/opening-balances') || command.path.endsWith('/confirm')) {
      throw new Error('This acknowledgment needs the accepted server result. Sync before viewing a pending total.');
    } else if (command.path !== '/groups' && !/\/(invites|archive|payment-attempts)(\/|$)/.test(command.path)) {
      throw new Error('Pending total is unavailable for this command until sync.');
    }
  }
  return { ...group, transfers: proposeTransfers(group.balances) };
}
