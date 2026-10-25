export async function copyText(text: string | Promise<string>): Promise<void> {
  if (typeof text === 'string') { await navigator.clipboard.writeText(text); return; }
  const data = text.then(value => new Blob([value], { type: 'text/plain' }));
  // A denied write may never consume its data; still observe a later API error.
  void data.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })]);
}
