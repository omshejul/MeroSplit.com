import React from 'react';
import { Image } from 'react-native';
import { Icon } from './ui';
import type { UPIApp } from './upi';

const icons = {
  phonepe: require('../assets/upi/phonepe.png'), 'google-pay': require('../assets/upi/google-pay.png'),
  paytm: require('../assets/upi/paytm.png'), cred: require('../assets/upi/cred.png'),
  bhim: require('../assets/upi/bhim.png'), 'amazon-pay': require('../assets/upi/amazon-pay.png'),
};
export default function UPIAppIcon({ app }: { app: UPIApp['id'] }) {
  return app === 'upi' ? <Icon name="pay" size={24} /> : <Image source={icons[app]} accessible={false} accessibilityIgnoresInvertColors style={{ width: 24, height: 24, borderRadius: 6 }} />;
}
