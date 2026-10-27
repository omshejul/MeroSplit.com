export type Palette = { background: string; surface: string; text: string; muted: string; accent: string; soft: string; line: string; outline: string; error: string; positive: string; negative: string; info: string; warning: string; switchOn: string };
export const defaultColorFamily = 'orchid' as const;
export type ColorFamily = 'basic' | 'cove' | 'orchid' | 'rose' | 'obsidian';
type PairedFamily = Exclude<ColorFamily, 'obsidian'>;
export type ThemeColors = { palette: Palette; elevation: readonly [string, string, string, string, string] };

// Balance, error and warning colors are shared by every family. Family accents
// avoid their green, red and amber hues so money states never read as decoration.
const lightStates = { error: '#B42318', positive: '#176B3A', negative: '#B42318', warning: '#8A5300' };
const darkStates = { error: '#FF9B93', positive: '#78D9A0', negative: '#FF9B93', warning: '#F2C266' };

export const colorFamilies: readonly { value: ColorFamily; label: string }[] = [
  { value: 'basic', label: 'Basic' }, { value: 'cove', label: 'Cove' }, { value: 'orchid', label: 'Orchid' }, { value: 'rose', label: 'Rose' }, { value: 'obsidian', label: 'Obsidian' },
];
export const isColorFamily = (value: unknown): value is ColorFamily => colorFamilies.some(family => family.value === value);
// Obsidian is the one dark-only look: it ignores the saved System/Light/Dark mode
// without changing it, so other colors still use that mode.
export const isDarkOnly = (family: ColorFamily) => family === 'obsidian';
export const lookColors = (family: ColorFamily, dark: boolean): ThemeColors => family === 'obsidian' ? obsidianColors : themeColors[family][dark ? 'dark' : 'light'];

// Pure black page with Basic dark text, accent and money states on bounded dark surfaces.
export const obsidianColors: ThemeColors = {
  palette: { background: '#000000', surface: '#121212', text: '#F5F5F5', muted: '#B5B5B5', accent: '#83B9FF', soft: '#242424', line: '#3A3A3A', outline: '#808080', ...darkStates, info: '#83B9FF', switchOn: '#007AFF' },
  elevation: ['#141414', '#181818', '#1C1C1C', '#202020', '#242424'],
};

export const themeColors: Record<PairedFamily, { light: ThemeColors; dark: ThemeColors }> = {
  basic: {
    light: { palette: { background: '#F7F7F7', surface: '#FFFFFF', text: '#161616', muted: '#626262', accent: '#075DB4', soft: '#ECECEC', line: '#D4D4D4', outline: '#8A8A8A', ...lightStates, info: '#075DB4', switchOn: '#007AFF' },
      elevation: ['#FAFAFA', '#F7F7F7', '#F2F2F2', '#EEEEEE', '#EAEAEA'] },
    dark: { palette: { background: '#111111', surface: '#1C1C1C', text: '#F5F5F5', muted: '#B5B5B5', accent: '#83B9FF', soft: '#2D2D2D', line: '#444444', outline: '#808080', ...darkStates, info: '#83B9FF', switchOn: '#007AFF' },
      elevation: ['#202020', '#242424', '#282828', '#2C2C2C', '#303030'] },
  },
  cove: {
    light: { palette: { background: '#F1F6F7', surface: '#FFFFFF', text: '#0F1F22', muted: '#4A6166', accent: '#00687A', soft: '#E1EEF0', line: '#C8DADD', outline: '#7A9297', ...lightStates, info: '#00687A', switchOn: '#00687A' },
      elevation: ['#F8FBFB', '#F4F9F9', '#EFF6F7', '#EAF3F4', '#E6F0F2'] },
    dark: { palette: { background: '#0D1719', surface: '#142124', text: '#EAF4F5', muted: '#A6BCC0', accent: '#6CCFE0', soft: '#1F3236', line: '#33494D', outline: '#6F8A8F', ...darkStates, info: '#6CCFE0', switchOn: '#2C8FA2' },
      elevation: ['#152427', '#18282B', '#1B2C30', '#1E3034', '#213438'] },
  },
  orchid: {
    light: { palette: { background: '#F7F4FA', surface: '#FFFFFF', text: '#1E1626', muted: '#625A6B', accent: '#6B3FA0', soft: '#EEE7F5', line: '#DAD0E4', outline: '#8F8599', ...lightStates, info: '#6B3FA0', switchOn: '#6B3FA0' },
      elevation: ['#FBF9FC', '#F9F6FB', '#F6F2F9', '#F3EEF7', '#F0EAF5'] },
    dark: { palette: { background: '#141018', surface: '#1D1823', text: '#F3EEF7', muted: '#BDB2C8', accent: '#C7A6F2', soft: '#2D2536', line: '#453B50', outline: '#867B92', ...darkStates, info: '#C7A6F2', switchOn: '#8A5CC7' },
      elevation: ['#1F1A26', '#231D2A', '#26202E', '#2A2332', '#2D2636'] },
  },
  rose: {
    light: { palette: { background: '#FAF4F7', surface: '#FFFFFF', text: '#26141D', muted: '#6A5862', accent: '#9C2A78', soft: '#F5E6EE', line: '#E4CFDA', outline: '#998590', ...lightStates, info: '#9C2A78', switchOn: '#9C2A78' },
      elevation: ['#FCF9FA', '#FBF6F8', '#F9F2F5', '#F7EEF2', '#F5EAF0'] },
    dark: { palette: { background: '#180F14', surface: '#22171D', text: '#F8EEF3', muted: '#C8B2BE', accent: '#F0A3D6', soft: '#35242D', line: '#4E3A45', outline: '#927B87', ...darkStates, info: '#F0A3D6', switchOn: '#B5468F' },
      elevation: ['#251A20', '#291D24', '#2D2027', '#31232B', '#35262F'] },
  },
};
