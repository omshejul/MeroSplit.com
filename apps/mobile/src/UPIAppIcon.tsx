import React from 'react';
import { Image } from 'react-native';
import { Icon } from './ui';

const icons = {
  'phonepe': require('../assets/upi/phonepe.png'),
  'google-pay': require('../assets/upi/google-pay.png'),
  'paytm': require('../assets/upi/paytm.png'),
  'navi': require('../assets/upi/navi.png'),
  'super-money': require('../assets/upi/super-money.png'),
  'bhim': require('../assets/upi/bhim.png'),
  'famapp': require('../assets/upi/famapp.png'),
  'cred': require('../assets/upi/cred.png'),
  'amazon-pay': require('../assets/upi/amazon-pay.png'),
  'mobikwik': require('../assets/upi/mobikwik.png'),
  'airtel-thanks': require('../assets/upi/airtel-thanks.png'),
  'bajaj-pay': require('../assets/upi/bajaj-pay.png'),
  'flipkart': require('../assets/upi/flipkart.png'),
  'freecharge': require('../assets/upi/freecharge.png'),
  'idfc-first': require('../assets/upi/idfc-first.png'),
  'imobile': require('../assets/upi/imobile.png'),
  'kiwi': require('../assets/upi/kiwi.png'),
  'kotak': require('../assets/upi/kotak.png'),
  'axis': require('../assets/upi/axis.png'),
  'payzapp': require('../assets/upi/payzapp.png'),
  'pop': require('../assets/upi/pop.png'),
  'slice': require('../assets/upi/slice.png'),
  'yono-sbi': require('../assets/upi/yono-sbi.png'),
};

export default function UPIAppIcon({ app }: { app: keyof typeof icons | 'upi' }) {
  return app === 'upi' ? <Icon name="pay" size={24} /> : <Image source={icons[app]} accessible={false} accessibilityIgnoresInvertColors style={{ width: 24, height: 24, borderRadius: 6 }} />;
}
