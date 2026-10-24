import { Platform } from 'react-native';
import type { FontFamilyDefinition } from 'expo-font';

// Missing glyphs use the OS fallback; never apply this family to icon fonts.
export const appFontFamily = Platform.OS === 'web' ? '"Stack Sans Text", system-ui, sans-serif' : 'Stack Sans Text';
export const appFontFaces: FontFamilyDefinition[] = [{
  fontFamily: 'Stack Sans Text',
  fontDefinitions: [{ path: require('../assets/fonts/StackSansText.ttf'), weight: '200 700' }],
}];
