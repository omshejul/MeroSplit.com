import { integer, proposeTransfers, type Transfer } from './accounting.ts';
import { previewPending } from './ledger.ts';
import type { Command, Expense, Group, Settlement } from './types.ts';

export const changedBalance = 'This balance changed. Close and reopen the group to see its latest amount.';
export const balanceKey = (group: Group, commands: Command[]) => JSON.stringify([group.id, group.version, group.balances, group.transfers, commands.filter(command => command.group_id === group.id)]);

type HistoryRecord = { key: string; date: string | null; effect: string; excluded: boolean } & ({ kind: 'bill'; bill: Expense } | { kind: 'payment'; payment: Settlement });
const validDate = (date: string | null): date is string => {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

/** Current records in bill/payment date order, with balances only at day boundaries. */
export function balanceHistory(group: Group, selfId: string) {
  const records: HistoryRecord[] = [
    ...group.expenses.filter(bill => BigInt(bill.paid[selfId] ?? '0') || BigInt(bill.shares[selfId] ?? '0')).map(bill => ({ key: `bill:${bill.id}`, kind: 'bill' as const, bill, date: bill.date || null, effect: bill.deleted ? '0' : (BigInt(bill.paid[selfId] ?? '0') - BigInt(bill.shares[selfId] ?? '0')).toString(), excluded: bill.deleted })),
    ...group.settlements.filter(payment => payment.sender === selfId || payment.recipient === selfId).map(payment => ({ key: `payment:${payment.id}`, kind: 'payment' as const, payment, date: payment.date || null, effect: payment.reversed ? '0' : (BigInt(payment.amount) * (payment.sender === selfId ? 1n : -1n)).toString(), excluded: !!payment.reversed })),
  ];
  records.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.key.localeCompare(b.key));
  const active = records.filter(row => !row.excluded), excluded = records.filter(row => row.excluded);
  const opening = group.opening_balance?.accepted ? group.opening_balance.balances[selfId] ?? '0' : '0';
  const ordered = active.every(row => validDate(row.date)) && (!group.opening_balance?.accepted || validDate(group.opening_balance.cutoff) && (!active.length || group.opening_balance.cutoff <= active[0].date!));
  let balance = BigInt(opening), settledIndex = -1, settledDate: string | null = null, dayChanged = false;
  const entries = active.map((row, index) => {
    balance += BigInt(row.effect); dayChanged ||= row.effect !== '0';
    const dayEnd = index === active.length - 1 || row.date !== active[index + 1].date;
    if (ordered && dayEnd && balance === 0n && dayChanged) { settledIndex = index; settledDate = row.date; }
    if (dayEnd) dayChanged = false;
    return { ...row, balance: ordered && dayEnd ? balance.toString() : null };
  });
  if (balance.toString() !== group.balances[selfId]) throw new Error(changedBalance);
  const recent = entries.slice(settledIndex + 1).filter(row => row.effect !== '0');
  const single = group.participants.length === 2 && recent.length === 1 && recent[0].kind === 'bill' && recent[0].effect === balance.toString() ? recent[0].bill : null;
  return { entries, excluded, opening, ordered, settledDate, recent, single };
}

/** Explain a complete snapshot using the same saved-change preview and Simplify functions as the app. */
export function explainTransfer(source: Group, displayed: Group, selfId: string, transfer: Transfer, commands: Command[] = []) {
  if (source.read_mode === 'summary') throw new Error('Connect to load the full breakdown. The saved total is still available on the group page.');
  if (source.id !== displayed.id || source.version !== displayed.version) throw new Error(changedBalance);
  const pending = commands.filter(command => command.group_id === source.id);
  const group = pending.length ? previewPending(source, pending) : source;
  if (!group.participants.some(person => person.id === selfId && !person.removed) || ![transfer.sender, transfer.recipient].includes(selfId)) throw new Error('This balance is unavailable for your account.');
  const people = group.participants.map(person => ({ id: person.id, name: person.id === selfId ? 'You' : person.name, paid: 0n, share: 0n, sent: 0n, received: 0n, opening: 0n }));
  const byId = new Map(people.map(person => [person.id, person]));
  let spending = 0n;
  for (const bill of group.expenses) {
    if (bill.deleted) continue;
    spending += integer(bill.total);
    for (const [id, amount] of Object.entries(bill.paid)) {
      const person = byId.get(id); if (!person) throw new Error(changedBalance);
      person.paid += integer(amount);
    }
    for (const [id, amount] of Object.entries(bill.shares)) {
      const person = byId.get(id); if (!person) throw new Error(changedBalance);
      person.share += integer(amount);
    }
  }
  for (const payment of group.settlements) {
    if (payment.reversed) continue;
    const sender = byId.get(payment.sender), recipient = byId.get(payment.recipient);
    if (!sender || !recipient || sender === recipient) throw new Error(changedBalance);
    sender.sent += integer(payment.amount); recipient.received += integer(payment.amount);
  }
  if (group.opening_balance?.accepted) for (const [id, amount] of Object.entries(group.opening_balance.balances)) {
    const person = byId.get(id); if (!person) throw new Error(changedBalance);
    person.opening += integer(amount, true);
  }
  const totals = people.map(person => ({ ...person, balance: person.paid - person.share + person.sent - person.received + person.opening }));
  const balances = Object.fromEntries(totals.map(person => [person.id, person.balance.toString()]));
  if (Object.keys(displayed.balances).length !== people.length || totals.some(person => person.balance.toString() !== displayed.balances[person.id])) throw new Error(changedBalance);
  if (!pending.length && source.totals && (spending.toString() !== source.totals.spending || totals.some(person => person.paid.toString() !== (source.totals!.paid[person.id] ?? '0') || person.share.toString() !== (source.totals!.shares[person.id] ?? '0')))) throw new Error(changedBalance);
  const plan = proposeTransfers(balances);
  if (JSON.stringify(plan) !== JSON.stringify(displayed.transfers)) throw new Error(changedBalance);
  const index = plan.findIndex(row => row.sender === transfer.sender && row.recipient === transfer.recipient && row.amount === transfer.amount);
  if (index < 0) throw new Error(changedBalance);
  const remaining = { ...balances };
  for (const row of plan.slice(0, index)) {
    remaining[row.sender] = (integer(remaining[row.sender], true) + integer(row.amount)).toString();
    remaining[row.recipient] = (integer(remaining[row.recipient], true) - integer(row.amount)).toString();
  }
  return { group, plan, index, history: balanceHistory(group, selfId), owing: (-integer(remaining[transfer.sender], true)).toString(), owed: remaining[transfer.recipient], spending: spending.toString(), pending: pending.length > 0,
    people: totals.map(person => ({ ...person, paid: person.paid.toString(), share: person.share.toString(), sent: person.sent.toString(), received: person.received.toString(), opening: person.opening.toString(), balance: person.balance.toString() })) };
}
