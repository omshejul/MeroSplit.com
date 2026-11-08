import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

// iOS build 33 and earlier lack the packaged camera usage description.
export function canTakePhoto(): boolean {
  if (Platform.OS === 'web') return true;
  const application = requireOptionalNativeModule<{ nativeBuildVersion?: string }>('ExpoApplication');
  const minimumBuild = Platform.OS === 'ios' ? 34 : 33;
  return Number(application?.nativeBuildVersion ?? '0') >= minimumBuild;
}
