export function chooseBrowserFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
    input.style.display = 'none'; document.body.appendChild(input);
    let done = false;
    const finish = (file: File | null) => { if (done) return; done = true; input.remove(); resolve(file); };
    input.onchange = () => finish(input.files?.[0] ?? null); input.oncancel = () => finish(null);
    input.click();
  });
}
let database: Promise<IDBDatabase> | undefined;
function filesDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('merosplit-staged-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(new Error('Could not save this file in the browser. Keep site storage enabled.')); };
  });
  return database;
}
export async function stagedBlob(id: string): Promise<Blob> {
  const db = await filesDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get(id);
    request.onsuccess = () => request.result instanceof Blob ? resolve(request.result) : reject(new Error('This saved upload is unavailable. Choose the original file again.'));
    request.onerror = () => reject(new Error('Could not read the saved upload. Try again.'));
  });
}
export async function storeStagedBlob(id: string, blob: Blob | null): Promise<void> {
  const db = await filesDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite'), store = transaction.objectStore('files');
    if (blob) store.put(blob, id); else store.delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(new Error('Could not save the upload. Free browser storage and retry.'));
  });
}
