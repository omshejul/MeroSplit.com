import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

// Build 32 explicitly excludes camera permission. The camera-enabled native
// release must be build 33 or newer; OTA configuration cannot enable build 32.
export function canTakePhoto(): boolean {
  if (Platform.OS === 'web') return true;
  const application = requireOptionalNativeModule<{ nativeBuildVersion?: string }>('ExpoApplication');
  return Number(application?.nativeBuildVersion ?? '0') >= 33;
}
