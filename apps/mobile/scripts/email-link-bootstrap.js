(() => {
  if (!location.pathname.startsWith('/app/sign-in/')) return;
  const id = location.pathname.match(/^\/app\/sign-in\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/?$/i)?.[1] ?? null;
  const proof = location.hash.match(/^#proof=([A-Za-z0-9_-]{43,128})$/)?.[1] ?? null;
  window.__meroSplitEmailLink = { id, proof };
  history.replaceState(null, '', id ? `/app/sign-in/${id}` : '/app/sign-in/');
})();
