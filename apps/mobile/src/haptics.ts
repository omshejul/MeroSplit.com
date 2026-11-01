import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

export function tapHaptic(): void {
  try {
    const feedback = Platform.OS === 'android'
      ? Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Virtual_Key)
      : Haptics.selectionAsync();
    void feedback.catch(() => {});
  } catch { /* Haptics must never prevent the action. */ }
}
