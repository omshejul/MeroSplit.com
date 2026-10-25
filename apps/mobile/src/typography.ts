import { Platform } from 'react-native';
import type { FontFamilyDefinition } from 'expo-font';

// Missing glyphs use the OS fallback; never apply this family to icon fonts.
export const appFontFamily = Platform.OS === 'web' ? '"Stack Sans Text", system-ui, sans-serif' : 'Stack Sans Text';
export const googleFontFamily = Platform.OS === 'web' ? '"Google Sans", system-ui, sans-serif' : 'Google Sans';
export const appFontFaces: FontFamilyDefinition[] = [{
  fontFamily: 'Stack Sans Text',
  fontDefinitions: [{ path: require('../assets/fonts/StackSansText.ttf'), weight: '200 700' }],
}, { fontFamily: 'Google Sans', fontDefinitions: [{ path: require('../assets/fonts/GoogleSans-Medium.ttf'), weight: 500 }] }];
