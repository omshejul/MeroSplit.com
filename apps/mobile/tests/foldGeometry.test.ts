import test from 'node:test';
import assert from 'node:assert/strict';
import { usableFoldRegion, type FoldRect, type FoldRegion } from '../src/foldGeometry.ts';

const bounds: FoldRect = { x: 0, y: 0, width: 1000, height: 800 };
const region = (x: number, y: number, width: number, height: number, kind: FoldRegion['kind'] = 'occlusion'): FoldRegion => ({ kind, frame: { x, y, width, height } });
const overlap = (a: FoldRect, b: FoldRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('no reported region preserves bounds including their root-window offset', () => {
  assert.deepEqual(usableFoldRegion(bounds, []), bounds);
  const inset = { x: 42, y: 60, width: 840, height: 400 };
  assert.deepEqual(usableFoldRegion(inset, []), inset);
  assert.notEqual(usableFoldRegion(bounds, []), bounds);
});

test('vertical and horizontal folds prefer trailing and bottom regions on equal area', () => {
  assert.deepEqual(usableFoldRegion(bounds, [region(490, 0, 20, 800, 'division')]), { x: 510, y: 0, width: 490, height: 800 });
  assert.deepEqual(usableFoldRegion(bounds, [region(0, 390, 1000, 20, 'division')]), { x: 0, y: 410, width: 1000, height: 390 });
});

test('zero-thickness division reserves an eight-point gutter on each side', () => {
  assert.deepEqual(usableFoldRegion(bounds, [region(500, 0, 0, 800, 'division')]), { x: 508, y: 0, width: 492, height: 800 });
  assert.deepEqual(usableFoldRegion(bounds, [region(0, 400, 1000, 0, 'division')]), { x: 0, y: 408, width: 1000, height: 392 });
});

test('asymmetric and clipped edge occlusions keep root coordinates and choose the largest area', () => {
  assert.deepEqual(usableFoldRegion(bounds, [region(-20, -40, 320, 900)]), { x: 300, y: 0, width: 700, height: 800 });
  const inset = { x: 100, y: 50, width: 800, height: 500 };
  assert.deepEqual(usableFoldRegion(inset, [region(400, 0, 20, 800, 'division')]), { x: 420, y: 50, width: 480, height: 500 });
  assert.deepEqual(usableFoldRegion(bounds, [region(0, 0, 100, 100)]), { x: 100, y: 0, width: 900, height: 800 });
});

test('multiple reported regions find the true empty rectangle and ignore covered duplicates', () => {
  const obstacles = [region(400, 0, 20, 200), region(700, 100, 20, 700)];
  const result = usableFoldRegion(bounds, [...obstacles, region(405, 100, 5, 50), obstacles[0]]);
  assert.deepEqual(result, { x: 0, y: 200, width: 700, height: 600 });
  assert.ok(obstacles.every(o => !overlap(result, o.frame)));
  assert.deepEqual(usableFoldRegion(bounds, [...obstacles].reverse()), result);
});

test('outside regions and degenerate occlusions do not change the usable rectangle', () => {
  const outside = [region(1100, 0, 20, 800), region(0, 900, 1000, 20), region(-5, 0, 0, 800, 'division'), region(0, 0, 0, 800), region(500, 400, 0, 0, 'division')];
  assert.deepEqual(usableFoldRegion(bounds, outside), bounds);
});

test('fully occluded or empty bounds return an empty rectangle at their trailing bottom edge', () => {
  assert.deepEqual(usableFoldRegion(bounds, [region(-1, -1, 1002, 802)]), { x: 1000, y: 800, width: 0, height: 0 });
  assert.deepEqual(usableFoldRegion(bounds, [region(0, 0, 600, 800), region(400, 0, 600, 800)]), { x: 1000, y: 800, width: 0, height: 0 });
  assert.deepEqual(usableFoldRegion({ x: 20, y: 30, width: 0, height: 100 }, []), { x: 20, y: 130, width: 0, height: 0 });
});

test('malformed dimensions cannot introduce NaN, infinite or negative output sizes', () => {
  assert.deepEqual(usableFoldRegion(bounds, [region(NaN, 0, 20, 800), region(0, 0, -10, 800), region(0, 0, Infinity, 800)]), bounds);
  for (const b of [{ x: NaN, y: Infinity, width: -20, height: NaN }, { x: 1e308, y: 0, width: 1e308, height: 2 }]) {
    const result = usableFoldRegion(b, []);
    assert.ok(Object.values(result).every(Number.isFinite));
    assert.ok(result.width >= 0 && result.height >= 0);
  }
});
