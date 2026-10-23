import '@expo/metro-runtime';
if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {}); });
}
