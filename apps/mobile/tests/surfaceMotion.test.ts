import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function surface(file: string, enabled: boolean, active: boolean) {
  let cleanup: (() => void) | undefined;
  const animations: any[] = [];
  class HTMLElement {}
  const element = new HTMLElement();
  const exports: any = {};
  const modules: Record<string, any> = {
    react: { createElement: (...args: unknown[]) => args, useRef: () => ({ current: element }), useEffect: (effect: () => any) => { cleanup = effect(); } },
    './ui': { useUI: () => ({ motion: { enabled } }) },
    'framer-motion': { animate: (target: unknown, values: unknown, options: unknown) => {
      const animation = { target, values, options, cancelled: false, cancel() { this.cancelled = true; } }; animations.push(animation); return animation;
    } },
  };
  const code = ts.transpile(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  new Function('require', 'exports', 'HTMLElement', code)((name: string) => modules[name], exports, HTMLElement);
  if (file.startsWith('Scene')) exports.default({ children: 'preserved form', changeKey: 'home|People', active });
  else exports.useDialogMotion({ current: element }, active);
  return { animations, cleanup: () => cleanup?.() };
}
for (const file of ['SceneTransition.web.tsx', 'useDialogMotion.web.ts']) {
  test(`${file} animates a visible surface, cancels safely, and respects reduced motion`, () => {
    const h = surface(file, true, true);
    assert.equal(h.animations.length, 1);
    assert.equal(h.animations[0].options.duration, 0.2);
    assert.ok(h.animations[0].values.opacity[0] < 0.5);
    assert.ok(h.animations[0].values.transform[0].includes('translateY('));
    h.cleanup(); assert.equal(h.animations[0].cancelled, true);
    assert.equal(surface(file, false, true).animations.length, 0);
    assert.equal(surface(file, true, false).animations.length, 0);
  });
}
