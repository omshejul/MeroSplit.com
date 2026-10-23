import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
export async function pickSplitwiseCsv(): Promise<{ name: string; contents: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false, copyToCacheDirectory: true }); if (result.canceled) return null;
  const asset = result.assets[0], file = new File(asset.uri);
  try {
    if (!asset.name.toLowerCase().endsWith('.csv')) throw new Error('Choose the CSV export from a Splitwise group.');
    if ((asset.size ?? file.size) > 1_048_576) throw new Error('Choose a CSV file up to 1 MB.');
    return { name: asset.name, contents: await file.text() };
  } finally { try { if (file.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, '')}/`) && file.exists) file.delete(); } catch { /* Only a picker copy is removed. */ } }
}
