import { requireOptionalNativeModule } from 'expo';
import { Linking, Platform } from 'react-native';
import { appStores } from './storeUpdate';
type NativeReview = { isAvailableAsync(): Promise<boolean>; requestReview(): Promise<void> };
// Build 32 has no review module. Keep OTA launches safe and never open a store automatically.
export function nativeReviewModule(): NativeReview | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try { return requireOptionalNativeModule<NativeReview>('ExpoStoreReview'); } catch { return null; }
}
export async function openStoreReview(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  const store = appStores[Platform.OS], query = Platform.OS === 'ios' ? '?action=write-review' : '&showAllReviews=true';
  const native = store.native + query, web = store.web + query;
  try { await Linking.openURL(native); } catch { await Linking.openURL(web); }
}
