import type { IconName } from './ui';
export type ExpenseIconRef = { id: string; groupId: string; title: string; category?: string; category_auto?: boolean | null };
export type ExpenseIcons = Record<string, string>;
export const categoryKey = (groupId: string, id: string, title: string) => JSON.stringify([groupId, id, title]);
const aliases: Record<string, string> = { foodanddrink: 'food', diningout: 'food', electricity: 'utilities', gas: 'utilities', transportation: 'transport', hotel: 'travel', medicine: 'health', medical: 'health' };
export const manualCategory = (category?: string) => { const key = category?.toLowerCase().replace(/[^a-z]/g, '') ?? ''; return aliases[key] ?? key; };
export const isGenericCategory = (category?: string) => ['', 'general', 'other'].includes(category?.trim().toLowerCase() ?? '');

const icons = { food: 'food', groceries: 'groceries', water: 'water', utilities: 'utilities', transport: 'transport', travel: 'travel', rent: 'rent', shopping: 'shopping', entertainment: 'entertainment', health: 'health', education: 'education' } satisfies Record<string, IconName>;

// Only fixed categories select assets. Pending, uncertain and unfamiliar values keep the receipt.
export function categoryIcon(category?: string | null): IconName {
  return icons[manualCategory(category ?? undefined) as keyof typeof icons] ?? 'bill';
}

const labels: Record<string, string> = { food: 'Food', groceries: 'Groceries', water: 'Water', utilities: 'Utilities', transport: 'Transport', travel: 'Travel', rent: 'Rent', shopping: 'Shopping', entertainment: 'Entertainment', health: 'Health', education: 'Education' };
export const categoryMeaning = (category?: string | null) => labels[category ?? ''] ? `${labels[category!]} category` : '';
export function expenseCategory(ref: ExpenseIconRef, icons: ExpenseIcons) {
  if (ref.category_auto === false || !isGenericCategory(ref.category)) return manualCategory(ref.category);
  return icons[categoryKey(ref.groupId, ref.id, ref.title)];
}
