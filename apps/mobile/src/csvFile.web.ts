import { chooseBrowserFile } from './webFiles';
export async function pickSplitwiseCsv(): Promise<{ name: string; contents: string } | null> {
  const file = await chooseBrowserFile('.csv,text/csv'); if (!file) return null;
  if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('Choose the CSV export from a Splitwise group.');
  if (file.size > 1_048_576) throw new Error('Choose a CSV file up to 1 MB.');
  return { name: file.name, contents: await file.text() };
}
