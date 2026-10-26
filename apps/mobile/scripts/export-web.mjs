import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { webManifest, webShell } from './web-shell.mjs';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(project, '../api/web-dist');
const result = spawnSync(process.execPath, [join(project, 'node_modules/expo/bin/cli'), 'export', '--platform', 'web', '--output-dir', destination], { cwd: project, stdio: 'inherit', env: { ...process.env, EXPO_WEB_BUILD: '1', NODE_ENV: 'production' } });
if (result.status !== 0) process.exit(result.status ?? 1);
// Dependency-directory paths may be excluded by deployment uploaders, including
// paths generated from a symlinked node_modules. SQLite uses this public URL.
await copyFile(join(project, 'node_modules/expo-sqlite/web/wa-sqlite/wa-sqlite.wasm'), join(destination, 'sqlite.wasm'));
// Scrub an incoming email proof before the browser starts any app asset requests.
const index = join(destination, 'index.html');
const bootstrap = await readFile(join(project, 'scripts/email-link-bootstrap.js'), 'utf8');
await writeFile(index, webShell(await readFile(index, 'utf8'), bootstrap));
await writeFile(join(destination, 'manifest.json'), JSON.stringify(webManifest));
await copyFile(join(project, '../../store-assets/google-play/icon-512.png'), join(destination, 'icon-512.png'));
await copyFile(join(project, '../api/ledger/assets/apple-touch-icon.png'), join(destination, 'apple-touch-icon.png'));
async function files(folder) { const rows = await readdir(folder, { withFileTypes: true }); return (await Promise.all(rows.map(row => row.isDirectory() ? files(join(folder, row.name)) : join(folder, row.name)))).flat(); }
const paths = await files(destination);
const manifest = paths.filter(path => !path.endsWith('.map')).map(path => '/app/' + relative(destination, path).split('\\').join('/'));
const version = createHash('sha256').update(await readFile(join(destination, 'index.html'))).digest('hex').slice(0, 16);
const worker = `const CACHE='merosplit-shell-${version}';const ASSETS=${JSON.stringify(manifest)};\nself.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));\nself.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('merosplit-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));\nself.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith('/app/')||url.pathname.startsWith('/app/media/'))return;if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match('/app/index.html')));return;}if(ASSETS.includes(url.pathname))event.respondWith(caches.match(event.request,{ignoreSearch:true}).then(cached=>cached||fetch(event.request)));});\n`;
await writeFile(join(destination, 'sw.js'), worker);
await writeFile(join(destination, 'build.json'), JSON.stringify({ platform: 'web', basePath: '/app/', version, assetCount: manifest.length }));
console.log(`Web export ready in apps/api/web-dist with ${manifest.length} app-shell assets. No API responses are cached.`);
