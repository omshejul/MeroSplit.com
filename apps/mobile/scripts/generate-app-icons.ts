// Builds the alternate iOS app icons from the primary Icon Composer bundle.
// Each alternate keeps the primary's layers, scale and glass settings, swaps
// the two half colors in its SVG, and fills the tile with an automatic
// gradient of its ground color in both light and dark. Run: pnpm icons:generate
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appIcons, nativeIconName } from '../src/appIcons.ts';

// The two fills in assets/brand/merosplit.icon/Assets/merosplit-logo.svg.
const BRAND_FILLS = { left: '#ffb21e', right: '#f2545b' };

const srgb = (hex: string) => `srgb:${[1, 3, 5].map(at => (Number.parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(5)).join(',')},1.00000`;

export function primaryImageName(primaryJson: string): string {
  const name = JSON.parse(primaryJson)?.groups?.[0]?.layers?.[0]?.['image-name'];
  if (typeof name !== 'string') throw new Error('The primary icon needs an image layer.');
  return name;
}

/** Returns each alternate's files, keyed by path inside assets/brand/app-icons. */
export function buildAppIconBundles(primaryJson: string, primarySvg: string): Record<string, string> {
  const primary = JSON.parse(primaryJson), imageName = primaryImageName(primaryJson);
  for (const fill of Object.values(BRAND_FILLS)) {
    if (primarySvg.split(`fill="${fill}"`).length !== 2) throw new Error(`The primary mark should have exactly one half filled ${fill}.`);
  }
  const files: Record<string, string> = {};
  for (const icon of appIcons) {
    const name = nativeIconName(icon.id);
    if (!name) continue;
    const fill = { 'automatic-gradient': srgb(icon.ground) };
    files[`${name}.icon/icon.json`] = `${JSON.stringify({
      ...primary, 'fill-specializations': [{ value: fill }, { appearance: 'dark', value: fill }],
    }, null, 2)}\n`;
    files[`${name}.icon/Assets/${imageName}`] = primarySvg
      .replace(`fill="${BRAND_FILLS.left}"`, `fill="${icon.left.toLowerCase()}"`)
      .replace(`fill="${BRAND_FILLS.right}"`, `fill="${icon.right.toLowerCase()}"`);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const brand = new URL('../assets/brand/', import.meta.url);
  const primaryJson = readFileSync(new URL('merosplit.icon/icon.json', brand), 'utf8');
  const primarySvg = readFileSync(new URL(`merosplit.icon/Assets/${primaryImageName(primaryJson)}`, brand), 'utf8');
  const files = buildAppIconBundles(primaryJson, primarySvg), out = new URL('app-icons/', brand);
  rmSync(out, { recursive: true, force: true });
  for (const [file, content] of Object.entries(files)) {
    const target = fileURLToPath(new URL(file, out));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  console.log(`Wrote ${Object.keys(files).length / 2} alternate icons to ${fileURLToPath(out)}`);
}
