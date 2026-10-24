export type UPIDirectoryApp = { name: string; website: string; ios?: string; android?: string };

// Official product/store links only. These are discovery links, not payment routes.
// Popularity: NPCI UPI Apps total transaction volume, Aug 2025, latest verifiable indexed table.
// https://www.npci.org.in/what-we-do/upi/upi-ecosystem-statistics
// Rank only individually named apps. Aggregate "Axis Bank Apps" is not the open app's rank.
// Apps without an individual verified rank follow alphabetically; this is not a live ranking.
export const upiDirectory: UPIDirectoryApp[] = [
  { name: 'PhonePe', website: 'https://www.phonepe.com/', ios: 'https://apps.apple.com/in/app/id1170055821' },
  { name: 'Google Pay', website: 'https://pay.google.com/intl/en_in/about/', ios: 'https://apps.apple.com/in/app/id1193357041' },
  { name: 'Paytm', website: 'https://paytm.com/', ios: 'https://apps.apple.com/in/app/id473941634' },
  {"name": "Navi", "website": "https://navi.com/navi-upi", "ios": "https://apps.apple.com/in/app/navi-upi-payments-insurance/id1541152485", "android": "https://play.google.com/store/apps/details?id=com.naviapp"},
  {"name": "super.money", "website": "https://super.money/", "ios": "https://apps.apple.com/in/app/super-money/id6502597504", "android": "https://play.google.com/store/apps/details?id=money.super.payments"},
  { name: 'CRED', website: 'https://cred.club/', ios: 'https://apps.apple.com/in/app/id1428580080' },
  {"name": "FamApp by Trio", "website": "https://www.famapp.in/", "ios": "https://apps.apple.com/in/app/famapp-by-trio-upi-card/id1499806454", "android": "https://play.google.com/store/apps/details?id=com.fampay.in"},
  {"name": "Airtel Thanks", "website": "https://www.airtelpayments.bank.in/products/upi", "ios": "https://apps.apple.com/in/app/airtel-thanks-recharge-upi/id543184334", "android": "https://play.google.com/store/apps/details?id=com.myairtelapp"},
  { name: 'Amazon Pay', website: 'https://www.amazon.in/amazonpay/home', ios: 'https://apps.apple.com/in/app/id1478350915' },
  {"name": "Bajaj Pay", "website": "https://www.bajajfinserv.in/upi", "ios": "https://apps.apple.com/in/app/bajaj-finance-loans-upi-fd/id505454145", "android": "https://play.google.com/store/apps/details?id=org.altruist.BajajExperia"},
  { name: 'BHIM', website: 'https://www.bhimupi.org.in/', ios: 'https://apps.apple.com/in/app/id1200315258' },
  {"name": "Flipkart", "website": "https://www.flipkart.com/", "ios": "https://apps.apple.com/in/app/flipkart-online-shopping-app/id742044692", "android": "https://play.google.com/store/apps/details?id=com.flipkart.android"},
  {"name": "Freecharge", "website": "https://www.freecharge.in/", "ios": "https://apps.apple.com/in/app/freecharge-upi-bill-payments/id877495926", "android": "https://play.google.com/store/apps/details?id=com.freecharge.android"},
  { name: 'IDFC FIRST Bank', website: 'https://www.idfcfirst.bank.in/personal-banking/payments-upi/mobile-banking-services/mobile-banking-app', ios: 'https://apps.apple.com/in/app/id1521443352', android: 'https://play.google.com/store/apps/details?id=com.idfcfirstbank.optimus' },
  { name: 'iMobile by ICICI Bank', website: 'https://www.icici.bank.in/privilege-banking/personal/iMobile', ios: 'https://apps.apple.com/in/app/id375276006', android: 'https://play.google.com/store/apps/details?id=com.csam.icici.bank.imobile' },
  {"name": "Kiwi", "website": "https://gokiwi.in/", "ios": "https://apps.apple.com/in/app/kiwi-rupay-credit-card-on-upi/id6449386307", "android": "https://play.google.com/store/apps/details?id=in.gokiwi.kiwitpap"},
  { name: 'Kotak Bank', website: 'https://www.kotak.bank.in/en/digital-banking/ways-to-bank/mobile-banking.html', ios: 'https://apps.apple.com/in/app/id6471392908' },
  {"name": "MobiKwik", "website": "https://www.mobikwik.com/apps", "ios": "https://apps.apple.com/in/app/mobikwik-loans-upi-wallet/id600002523"},
  { name: 'open by Axis Bank', website: 'https://www.axis.bank.in/bank-smart/open-by-axis-bank', ios: 'https://apps.apple.com/in/app/id699582556', android: 'https://play.google.com/store/apps/details?id=com.axis.mobile' },
  {"name": "PayZapp", "website": "https://www.hdfc.bank.in/ps/payzapp", "ios": "https://apps.apple.com/in/app/payzapp-upi-pixel-credit-card/id6443480917", "android": "https://play.google.com/store/apps/details?id=com.hdfcbank.payzapp"},
  {"name": "POP", "website": "https://popclub.co/", "ios": "https://apps.apple.com/in/app/pop-upi-shop-credit-card/id6443502397"},
  {"name": "slice", "website": "https://slice.bank.in/", "ios": "https://apps.apple.com/in/app/slice-upi-credit-card-bank/id1123372237", "android": "https://play.google.com/store/apps/details?id=indwin.c3.shareapp"},
  { name: 'YONO SBI', website: 'https://apps.apple.com/in/app/yono-sbi-banking-upi-pay/id1231393474', ios: 'https://apps.apple.com/in/app/id1231393474' },
];

export function upiDirectoryLink(app: UPIDirectoryApp, platform: string) {
  if (platform === 'ios' && app.ios) return { url: app.ios, label: 'App Store' };
  if (platform === 'android' && app.android) return { url: app.android, label: 'Google Play' };
  return { url: app.website, label: 'Website' };
}
