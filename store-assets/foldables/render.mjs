import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2] || source);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'merosplit-artwork-'));
const sizes = { apple: [[1398, 2034], [2853, 2007]], android: [[2106, 2106], [2688, 2016], [1260, 2016]] };
let chrome, session, sequence = 0, buffer = Buffer.alloc(0);
const pending = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => chrome?.kill('SIGTERM'), 180000);

function cdp(method, params = {}, target = session) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }) + '\0');
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error('Artwork evaluation failed: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
  return result.result.value;
}

try {
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--remote-debugging-pipe', '--user-data-dir=' + profile], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  chrome.stdio[4].on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(0);
      if (end < 0) break;
      const raw = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 1);
      if (!raw) continue;
      const message = JSON.parse(raw), item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      clearTimeout(item.timer);
      message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result);
    }
  });
  const target = await cdp('Target.createTarget', { url: 'about:blank' }, null);
  session = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  const proofs = [];
  for (const [platform, cases] of Object.entries(sizes)) {
    for (const [index, [width, height]] of cases.entries()) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const url = pathToFileURL(path.join(source, 'design.html'));
      url.searchParams.set('platform', platform);
      url.searchParams.set('shot', String(index + 1));
      await cdp('Page.navigate', { url: url.href });
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await evaluate("document.readyState === 'complete' && !!window.renderReady")) break;
        await pause(100);
      }
      await evaluate('window.renderReady');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const proof = await evaluate(`(() => {
        const frame = document.querySelector('.device').getBoundingClientRect();
        const copy = [...document.querySelectorAll('.headline,.sub')].map(x => { const r = x.getBoundingClientRect(); return { text: x.innerText, x:r.x, y:r.y, width:r.width, height:r.height, overflow:x.scrollWidth > x.clientWidth }; });
        const capture = document.querySelector('.capture');
        return { composition:window.composition, frame:{x:frame.x,y:frame.y,width:frame.width,height:frame.height}, copy, capture:{source:capture.getAttribute('src'),naturalWidth:capture.naturalWidth,naturalHeight:capture.naturalHeight,width:capture.width,height:capture.height}, fontLoaded:[...document.fonts].some(x=>x.status==='loaded') };
      })()`);
      const { composition, capture, frame, copy } = proof;
      if (!proof.fontLoaded || capture.naturalWidth !== composition.sw || capture.naturalHeight !== composition.sh) throw Error('Font or native capture dimension mismatch');
      if (copy.some(x => x.overflow || x.y + x.height >= frame.y) || frame.y + frame.height > height || frame.x < 0 || frame.x + frame.width > width) throw Error('Artwork content overlaps or leaves canvas');
      if (Math.abs(capture.width / capture.naturalWidth - capture.height / capture.naturalHeight) > 0.002) throw Error('Capture was distorted');
      const png = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: false });
      const file = path.join(output, composition.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const pixels = Buffer.from(png.data, 'base64');
      fs.writeFileSync(file, pixels);
      proofs.push({ ...proof, sha256: crypto.createHash('sha256').update(pixels).digest('hex') });
      process.stdout.write(composition.file + '\n');
    }
  }
  fs.writeFileSync(path.join(output, 'render-proof.json'), JSON.stringify(proofs, null, 2) + '\n');
} finally {
  try { if (chrome) await cdp('Browser.close', {}, null); } catch {}
  chrome?.kill('SIGTERM');
  if (chrome && chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), pause(2000)]);
  clearTimeout(deadline);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
