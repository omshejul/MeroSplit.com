import { Clipboard } from 'react-native';

export async function copyText(text: string | Promise<string>): Promise<void> {
  Clipboard.setString(typeof text === 'string' ? text : await text);
}
