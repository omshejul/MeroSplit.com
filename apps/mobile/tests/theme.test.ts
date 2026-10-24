import test from 'node:test';
import assert from 'node:assert/strict';
import { colorFamilies, isColorFamily, isDarkOnly, lookColors, obsidianColors, themeColors } from '../src/theme.ts';

const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => channel(parseInt(hex.slice(i, i + 2), 16))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueGap = (a: string, b: string) => { const gap = Math.abs(hue(a) - hue(b)) % 360; return Math.min(gap, 360 - gap); };

test('Basic light and dark keep the released colors exactly', () => {
  assert.deepEqual(themeColors.basic.light.palette, { background: '#F7F7F7', surface: '#FFFFFF', text: '#161616', muted: '#626262', accent: '#075DB4', soft: '#ECECEC', line: '#D4D4D4', outline: '#8A8A8A', error: '#B42318', positive: '#176B3A', negative: '#B42318', info: '#075DB4', warning: '#8A5300', switchOn: '#007AFF' });
  assert.deepEqual(themeColors.basic.dark.palette, { background: '#111111', surface: '#1C1C1C', text: '#F5F5F5', muted: '#B5B5B5', accent: '#83B9FF', soft: '#2D2D2D', line: '#444444', outline: '#808080', error: '#FF9B93', positive: '#78D9A0', negative: '#FF9B93', info: '#83B9FF', warning: '#F2C266', switchOn: '#007AFF' });
  assert.deepEqual(themeColors.basic.light.elevation, ['#FAFAFA', '#F7F7F7', '#F2F2F2', '#EEEEEE', '#EAEAEA']);
  assert.deepEqual(themeColors.basic.dark.elevation, ['#202020', '#242424', '#282828', '#2C2C2C', '#303030']);
});

const looks = [
  ...(Object.keys(themeColors) as (keyof typeof themeColors)[]).flatMap(family => (['light', 'dark'] as const).map(mode => ({ name: `${family} ${mode}`, mode, colors: themeColors[family][mode] }))),
  { name: 'obsidian dark', mode: 'dark' as const, colors: obsidianColors },
];
test('exactly nine looks: four color families in light and dark, plus dark-only Obsidian', () => {
  assert.deepEqual(colorFamilies.map(family => family.value), [...Object.keys(themeColors), 'obsidian']);
  assert.equal(looks.length, 9);
  for (const family of colorFamilies) for (const dark of [false, true]) {
    const expected = family.value === 'obsidian' ? obsidianColors : themeColors[family.value as keyof typeof themeColors][dark ? 'dark' : 'light'];
    assert.equal(lookColors(family.value, dark), expected, `${family.label} ${dark ? 'dark' : 'light'}`);
    assert.equal(isDarkOnly(family.value), family.value === 'obsidian');
  }
  assert.ok(!('obsidian' in themeColors), 'no invented light Obsidian');
});

test('Obsidian is pure black with bounded dark surfaces and Basic dark accent and money states', () => {
  const p = obsidianColors.palette, basic = themeColors.basic.dark.palette;
  assert.equal(p.background, '#000000');
  for (const ground of [p.surface, p.soft, ...obsidianColors.elevation]) assert.ok(luminance(ground) > 0 && contrast(ground, '#000000') < 1.6, `${ground} is a quiet raised dark surface`);
  assert.deepEqual([p.text, p.muted, p.accent, p.info, p.error, p.positive, p.negative, p.warning, p.switchOn], [basic.text, basic.muted, basic.accent, basic.info, basic.error, basic.positive, basic.negative, basic.warning, basic.switchOn]);
});

test('all nine looks meet text, control and button contrast on every app surface', () => {
  for (const look of looks) {
    const { palette: p, elevation } = look.colors, onAccent = look.mode === 'dark' ? '#161616' : '#FFFFFF', name = look.name;
    const surfaces = { background: p.background, surface: p.surface, dialog: elevation[2] };
    for (const [where, ground] of Object.entries(surfaces)) {
      assert.ok(contrast(p.text, ground) >= 7, `${name} text on ${where}`);
      for (const token of ['muted', 'accent', 'error', 'positive', 'negative', 'info', 'warning'] as const) assert.ok(contrast(p[token], ground) >= 4.5, `${name} ${token} on ${where}`);
      assert.ok(contrast(p.outline, ground) >= 3, `${name} outline on ${where}`);
      assert.ok(contrast(p.switchOn, ground) >= 3, `${name} switch on ${where}`);
    }
    for (const token of ['text', 'muted', 'accent'] as const) assert.ok(contrast(p[token], p.soft) >= 4.5, `${name} ${token} on soft`);
    assert.ok(contrast(p.accent, onAccent) >= 4.5, `${name} primary button text`);
    assert.ok(contrast(p.error, onAccent) >= 4.5, `${name} danger button text`);
    assert.ok(contrast(p.switchOn, '#FFFFFF') >= 3, `${name} switch thumb`);
  }
});

test('colorful accents stay apart from money, error and warning states and from Basic', () => {
  for (const family of (['cove', 'orchid', 'rose'] as const).map(value => ({ value, label: value }))) for (const mode of ['light', 'dark'] as const) {
    const p = themeColors[family.value][mode].palette, basic = themeColors.basic[mode].palette;
    for (const token of ['positive', 'negative', 'warning'] as const) assert.ok(hueGap(p.accent, p[token]) >= 30, `${family.label} ${mode} accent vs ${token}`);
    assert.ok(hueGap(p.accent, basic.accent) >= 20, `${family.label} ${mode} differs from Basic`);
    assert.deepEqual([p.error, p.positive, p.negative, p.warning], [basic.error, basic.positive, basic.negative, basic.warning]);
  }
});

test('only known families are accepted', () => {
  for (const value of ['basic', 'cove', 'orchid', 'rose', 'obsidian']) assert.equal(isColorFamily(value), true);
  for (const value of [null, '', 'Basic', 'Obsidian', 'ember', 'system', 'black', 1]) assert.equal(isColorFamily(value), false);
});
