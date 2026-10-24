import { integer, proposeTransfers, type Transfer } from './accounting.ts';
import { previewPending } from './ledger.ts';
import type { Command, Group } from './types.ts';

export const changedBalance = 'This balance changed. Close and reopen the group to see its latest amount.';
export const balanceKey = (group: Group, commands: Command[]) => JSON.stringify([group.id, group.version, group.balances, group.transfers, commands.filter(command => command.group_id === group.id)]);

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
  return { group, plan, index, owing: (-integer(remaining[transfer.sender], true)).toString(), owed: remaining[transfer.recipient], spending: spending.toString(), pending: pending.length > 0,
    people: totals.map(person => ({ ...person, paid: person.paid.toString(), share: person.share.toString(), sent: person.sent.toString(), received: person.received.toString(), opening: person.opening.toString(), balance: person.balance.toString() })) };
}
