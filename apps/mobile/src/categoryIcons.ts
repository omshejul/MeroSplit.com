import type { IconName } from './ui';
export type ExpenseIconRef = { id: string; groupId: string; title: string; category?: string; category_auto?: boolean | null };
export type ExpenseIcons = Record<string, string>;
export const categoryKey = (groupId: string, id: string, title: string) => JSON.stringify([groupId, id, title]);
const aliases: Record<string, string> = {
  "general": "general",
  "other": "general",
  "food": "food",
  "bakery": "food",
  "dessert": "food",
  "fastfood": "food",
  "coffee": "drinks",
  "tea": "drinks",
  "alcohol": "drinks",
  "groceries": "groceries",
  "produce": "groceries",
  "meat": "groceries",
  "seafood": "groceries",
  "dairy": "groceries",
  "snacks": "groceries",
  "utilities": "utilities",
  "water": "utilities",
  "electricity": "utilities",
  "gas": "utilities",
  "internet": "utilities",
  "mobile": "utilities",
  "transport": "transport",
  "taxi": "transport",
  "fuel": "transport",
  "parking": "transport",
  "tolls": "transport",
  "cycling": "transport",
  "carmaintenance": "transport",
  "bus": "transit",
  "train": "transit",
  "metro": "transit",
  "travel": "travel",
  "flights": "travel",
  "hotel": "travel",
  "rent": "home",
  "household": "home",
  "furniture": "home",
  "appliances": "home",
  "childcare": "home",
  "shopping": "shopping",
  "electronics": "shopping",
  "clothing": "shopping",
  "footwear": "shopping",
  "beauty": "shopping",
  "haircut": "shopping",
  "health": "health",
  "medicine": "health",
  "dental": "health",
  "education": "education",
  "books": "education",
  "stationery": "education",
  "tuition": "education",
  "entertainment": "entertainment",
  "movies": "entertainment",
  "music": "entertainment",
  "gaming": "entertainment",
  "photography": "entertainment",
  "sports": "fitness",
  "fitness": "fitness",
  "office": "work",
  "software": "work",
  "gifts": "gifts",
  "charity": "gifts",
  "flowers": "gifts",
  "pets": "pets",
  "insurance": "fees",
  "taxes": "fees",
  "bankfees": "fees",
  "subscriptions": "fees",
  "cleaning": "services",
  "laundry": "services",
  "repairs": "services",
  "shipping": "services",
  "garbage": "waste",
  "wastecollection": "waste",
  "recycling": "waste",
  "foodanddrink": "food",
  "diningout": "food",
  "transportation": "transport",
  "medical": "health"
};
export const manualCategory = (category?: string) => { const key = category?.toLowerCase().replace(/[^a-z]/g, '') ?? ''; return aliases[key] ?? key; };
export const isGenericCategory = (category?: string) => ['', 'general', 'other'].includes(category?.trim().toLowerCase() ?? '');

export const categoryIcons = {
  "general": "bill",
  "food": "food",
  "drinks": "tea",
  "groceries": "groceries",
  "utilities": "utilities",
  "transport": "transport",
  "transit": "train",
  "travel": "travel",
  "home": "rent",
  "shopping": "shopping",
  "health": "health",
  "education": "education",
  "entertainment": "entertainment",
  "fitness": "fitness",
  "work": "work",
  "gifts": "gifts",
  "pets": "pets",
  "fees": "bankfees",
  "services": "services",
  "waste": "garbage"
} satisfies Record<string, IconName>;

// Only fixed categories select assets. Pending, uncertain and unfamiliar values keep the receipt.
export function categoryIcon(category?: string | null): IconName {
  return categoryIcons[manualCategory(category ?? undefined) as keyof typeof categoryIcons] ?? 'bill';
}

const labels: Record<string, string> = {
  "general": "Other",
  "food": "Food",
  "drinks": "Drinks",
  "groceries": "Groceries",
  "utilities": "Utilities",
  "transport": "Transport",
  "transit": "Transit",
  "travel": "Travel",
  "home": "Home & family",
  "shopping": "Shopping",
  "health": "Health",
  "education": "Education",
  "entertainment": "Leisure",
  "fitness": "Fitness",
  "work": "Work",
  "gifts": "Gifts & giving",
  "pets": "Pets",
  "fees": "Fees & taxes",
  "services": "Services",
  "waste": "Waste"
};
export const categoryMeaning = (category?: string | null) => { const label = labels[manualCategory(category ?? undefined)]; return label ? `${label} category` : ''; };
export function expenseCategory(ref: ExpenseIconRef, icons: ExpenseIcons) {
  if (ref.category_auto === false || !isGenericCategory(ref.category)) return manualCategory(ref.category);
  return icons[categoryKey(ref.groupId, ref.id, ref.title)];
}

export const expenseIconChoices = Object.entries(categoryIcons).map(([category, icon]) => ({ category, icon, label: labels[category] }));
