import { requireOptionalNativeModule } from 'expo';

/** true means an Android chooser target was selected, never that money moved. */
export async function openAndroidUPIChooser(url: string): Promise<boolean> {
  const module = requireOptionalNativeModule<{ openChooser(url: string): Promise<boolean> }>('MeroSplitUPIHandoff');
  if (!module) throw new Error('Update MeroSplit to open the UPI app chooser.');
  return module.openChooser(url);
}
