import { currencySymbol } from './currency.ts';
export const MAX_AMOUNT = 1_000_000_000n;
export type Amounts = Record<string, string>;
export type Split = { mode: 'equal' | 'exact' | 'percent' | 'shares'; values: Amounts };
export type Transfer = { sender: string; recipient: string; amount: string };

export function integer(value: string, signed = false): bigint {
  const pattern = signed ? /^(0|-?[1-9]\d*)$/ : /^(0|[1-9]\d*)$/;
  if (typeof value !== 'string' || value.length > 40 || pattern.exec(value)?.[0] !== value) {
    throw new Error('Use a canonical integer paise string.');
  }
  return BigInt(value);
}

function scaled(value: string, precision: number): bigint {
  if (typeof value !== 'string' || value.length > 40 || /^(0|[1-9]\d*)(\.\d+)?$/.exec(value)?.[0] !== value) {
    throw new Error('Use a nonnegative decimal without commas or spaces.');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > precision) throw new Error(`At most ${precision} decimal places.`);
  return BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0'));
}

export function rupeesToPaise(value: string): string {
  const amount = scaled(value, 2);
  if (amount <= 0n || amount > MAX_AMOUNT) throw new Error(`Amount must be above zero and at most ${currencySymbol()}1,00,00,000.`);
  return amount.toString();
}

export function formatMoney(value: string, currency?: string): string {
  const amount = integer(value, true);
  const absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / 100n).toString();
  const tail = whole.slice(-3);
  const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${amount < 0n ? '-' : ''}${currencySymbol(currency)}${head ? `${head},` : ''}${tail}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export function validateExpense(
  total: string, paid: Amounts, split: Split, participantIds: string[],
): { paid: Amounts; shares: Amounts } {
  const amount = integer(total);
  if (amount <= 0n || amount > MAX_AMOUNT) throw new Error('Bill amount is outside the supported range.');
  if (!Array.isArray(participantIds) || participantIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Participants must be nonempty IDs.');
  if (!split || typeof split !== 'object' || Array.isArray(split)) throw new Error('Expected a split definition.');
  const ids = [...participantIds].sort();
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Participants must be unique.');
  for (const vector of [paid, split.values]) {
    if (!vector || typeof vector !== 'object' || Array.isArray(vector)) throw new Error('Expected participant amounts.');
    if (Object.keys(vector).some(id => !ids.includes(id))) throw new Error('Unknown participant.');
  }
  const contributions = Object.fromEntries(ids.map(id => [id, integer(paid[id] ?? '0')]));
  if (Object.values(contributions).reduce((a, b) => a + b, 0n) !== amount) throw new Error('Payers must add up to the bill.');
  const selected = Object.keys(split.values).sort();
  if (!selected.length) throw new Error('Select a beneficiary.');
  let shares: Record<string, bigint>;
  if (split.mode === 'exact') {
    shares = Object.fromEntries(ids.map(id => [id, integer(split.values[id] ?? '0')]));
    if (Object.values(shares).reduce((a, b) => a + b, 0n) !== amount) throw new Error('Exact shares must add up to the bill.');
  } else {
    let weights: Record<string, bigint>;
    if (split.mode === 'equal') {
      if (Object.values(split.values).some(value => value !== '1')) throw new Error('Equal split values must be 1.');
      weights = Object.fromEntries(selected.map(id => [id, 1n]));
    } else if (split.mode === 'percent' || split.mode === 'shares') {
      weights = Object.fromEntries(selected.map(id => [id, scaled(split.values[id], split.mode === 'percent' ? 2 : 4)]));
    } else throw new Error('Unsupported split mode.');
    const denominator = Object.values(weights).reduce((a, b) => a + b, 0n);
    if (denominator <= 0n) throw new Error('At least one weight must be positive.');
    if (split.mode === 'percent' && denominator !== 10_000n) throw new Error('Percentages must add up to 100.00.');
    shares = Object.fromEntries(ids.map(id => [id, 0n]));
    for (const id of selected) shares[id] = amount * weights[id] / denominator;
    const order = [...selected].sort((a, b) => {
      const left = amount * weights[a] % denominator;
      const right = amount * weights[b] % denominator;
      return left === right ? (a < b ? -1 : a > b ? 1 : 0) : left > right ? -1 : 1;
    });
    let remainder = amount - Object.values(shares).reduce((a, b) => a + b, 0n);
    for (const id of order) {
      if (remainder === 0n) break;
      shares[id] += 1n;
      remainder -= 1n;
    }
  }
  return {
    paid: Object.fromEntries(ids.map(id => [id, contributions[id].toString()])),
    shares: Object.fromEntries(ids.map(id => [id, shares[id].toString()])),
  };
}

export function addExpense(balances: Amounts, paid: Amounts, shares: Amounts, sign = 1n): Amounts {
  const result = { ...balances };
  for (const id of Object.keys(result)) {
    result[id] = (integer(result[id], true) + sign * (integer(paid[id] ?? '0') - integer(shares[id] ?? '0'))).toString();
  }
  return result;
}

/** A bill changes the balance by paid minus the already allocated share, not its gross total. */
export function expenseBalanceChange(expense: { paid: Amounts; shares: Amounts; deleted?: boolean }, selfId: string): string {
  if (expense.deleted) return '0';
  return (integer(expense.paid[selfId] ?? '0') - integer(expense.shares[selfId] ?? '0')).toString();
}

/** Direction of an accepted settlement record, not proof of receipt or a pending payment attempt. */
export function settlementCashflow(payment: { sender: string; recipient: string; amount: string; reversed?: boolean }, selfId: string): string {
  if (payment.reversed) return '0';
  const direction = (payment.recipient === selfId ? 1n : 0n) - (payment.sender === selfId ? 1n : 0n);
  return direction === 0n ? '0' : (direction * integer(payment.amount)).toString();
}

export function addSettlement(balances: Amounts, sender: string, recipient: string, amount: string): Amounts {
  const value = integer(amount);
  if (!(sender in balances) || !(recipient in balances) || sender === recipient || value <= 0n || value > MAX_AMOUNT) {
    throw new Error('Choose different participants and a valid repayment amount.');
  }
  return { ...balances, [sender]: (integer(balances[sender], true) + value).toString(), [recipient]: (integer(balances[recipient], true) - value).toString() };
}

export function proposeTransfers(balances: Amounts): Transfer[] {
  if (!balances || typeof balances !== 'object' || Array.isArray(balances) || Object.keys(balances).some(id => !id.trim())) throw new Error('Expected balances by participant ID.');
  const nets = Object.entries(balances).map(([id, amount]) => ({ id, amount: integer(amount, true) }));
  if (nets.reduce((sum, row) => sum + row.amount, 0n) !== 0n) throw new Error('Balances must sum to zero.');
  const debtors = nets.filter(row => row.amount < 0n).map(row => ({ id: row.id, amount: -row.amount }));
  const creditors = nets.filter(row => row.amount > 0n);
  const byAmount = (a: typeof nets[number], b: typeof nets[number]) => a.amount === b.amount ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.amount > b.amount ? -1 : 1;
  const transfers: Transfer[] = [];
  while (debtors.length && creditors.length) {
    debtors.sort(byAmount); creditors.sort(byAmount);
    const debtor = debtors[0], creditor = creditors[0];
    const amount = debtor.amount < creditor.amount ? debtor.amount : creditor.amount;
    transfers.push({ sender: debtor.id, recipient: creditor.id, amount: amount.toString() });
    debtor.amount -= amount; creditor.amount -= amount;
    if (!debtor.amount) debtors.shift();
    if (!creditor.amount) creditors.shift();
  }
  return transfers;
}
