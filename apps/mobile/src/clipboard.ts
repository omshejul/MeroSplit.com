import { Clipboard } from 'react-native';

export async function copyText(text: string): Promise<void> {
  Clipboard.setString(text);
}
