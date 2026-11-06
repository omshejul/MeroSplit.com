import { Platform } from 'react-native';
export const pageWidthStyle = Platform.OS === 'web' ? { width: '100%' as const, maxWidth: 760, alignSelf: 'center' as const } : {};
