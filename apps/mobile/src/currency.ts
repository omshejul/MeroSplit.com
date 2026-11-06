// Display preference only. Stored amounts and payment currencies never change.
export const DEFAULT_CURRENCY = 'INR';
export const currencies = [
  { value: 'INR', symbol: '₹', name: 'Indian rupee' },
  { value: 'USD', symbol: '$', name: 'US dollar' },
  { value: 'EUR', symbol: '€', name: 'Euro' },
  { value: 'GBP', symbol: '£', name: 'British pound' },
  { value: 'AED', symbol: 'د.إ', name: 'UAE dirham' },
  { value: 'AUD', symbol: 'A$', name: 'Australian dollar' },
  { value: 'CAD', symbol: 'CA$', name: 'Canadian dollar' },
  { value: 'SGD', symbol: 'S$', name: 'Singapore dollar' },
  { value: 'NZD', symbol: 'NZ$', name: 'New Zealand dollar' },
  { value: 'CHF', symbol: 'CHF', name: 'Swiss franc' },
  { value: 'JPY', symbol: '¥', name: 'Japanese yen' },
] as const;
export type Currency = typeof currencies[number]['value'];
export const isCurrency = (value: unknown): value is Currency => currencies.some(currency => currency.value === value);
let defaultCurrency: Currency = DEFAULT_CURRENCY;
export const currencyCode = () => defaultCurrency;
export function setDefaultCurrency(value: Currency) {
  if (!isCurrency(value)) throw new Error('Choose a currency.');
  defaultCurrency = value;
}
export const currencySymbol = (value: string = defaultCurrency) => currencies.find(currency => currency.value === value)?.symbol ?? value;
