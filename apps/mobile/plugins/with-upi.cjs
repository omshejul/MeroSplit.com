const { withAndroidManifest } = require('expo/config-plugins');

module.exports = config => withAndroidManifest(config, mod => {
  const manifest = mod.modResults.manifest;
  manifest.queries ??= [];
  const exists = manifest.queries.some(query => (query.intent ?? []).some(intent =>
    intent.action?.some(action => action.$['android:name'] === 'android.intent.action.VIEW') &&
    intent.data?.some(data => data.$['android:scheme'] === 'upi' && data.$['android:host'] === 'pay')));
  if (!exists) manifest.queries.push({ intent: [{
    action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
    data: [{ $: { 'android:scheme': 'upi', 'android:host': 'pay' } }],
  }] });
  return mod;
});
