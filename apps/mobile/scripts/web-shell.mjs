import { themeColors, obsidianColors } from '../src/theme.ts';

export const webManifest = {
  id: '/app/', name: 'MeroSplit', short_name: 'MeroSplit', lang: 'en',
  start_url: '/app/', scope: '/app/', display: 'standalone',
  background_color: themeColors.orchid.light.palette.background,
  theme_color: themeColors.orchid.light.palette.background,
  icons: [{ src: '/app/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
};

export function webShell(html, proofBootstrap) {
  // Use the same palette as the app, before its bundle or fonts can paint.
  const backgrounds = Object.fromEntries(Object.entries(themeColors).map(([name, modes]) => [name, {
    light: modes.light.palette.background, dark: modes.dark.palette.background,
  }]));
  backgrounds.obsidian = { light: obsidianColors.palette.background, dark: obsidianColors.palette.background };
  const themeBootstrap = `(()=>{const colors=${JSON.stringify(backgrounds)};let mode='system',family='orchid';try{mode=localStorage.getItem('merosplit.web.appearance')||mode;family=localStorage.getItem('merosplit.web.colorFamily')||family}catch{}if(!Object.hasOwn(colors,family))family='orchid';const dark=family==='obsidian'||(mode==='dark'||mode!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches),background=colors[family][dark?'dark':'light'];document.documentElement.style.backgroundColor=background;document.documentElement.style.colorScheme=dark?'dark':'light';document.querySelector('meta[name="theme-color"]').content=background;document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]').content=dark?'black-translucent':'default'})();`;
  return html.replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')
    .replace('<head>', `<head><link rel="canonical" href="https://merosplit.com/app/"><meta property="og:url" content="https://merosplit.com/app/"><script>${proofBootstrap}</script><meta name="theme-color" content="${webManifest.theme_color}"><meta name="color-scheme" content="light dark"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="MeroSplit"><link rel="apple-touch-icon" href="/app/apple-touch-icon.png"><link rel="manifest" href="/app/manifest.json"><script>${themeBootstrap}</script>`)
    .replace('</head>', `<style>html{background:${webManifest.background_color};color-scheme:light dark}body{background:inherit;margin:0}html,body{width:100%}#root{height:100%;height:100dvh;min-height:0}button,[role="button"]{touch-action:manipulation;-webkit-tap-highlight-color:transparent}button:focus:not(:focus-visible),[role="button"]:focus:not(:focus-visible){outline:none!important}</style></head>`);
}
