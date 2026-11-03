import { registerRootComponent } from 'expo';
import Gallery from './BalanceSheetGallery';
import * as SplashScreen from 'expo-splash-screen';
void SplashScreen.hideAsync();
registerRootComponent(Gallery);
