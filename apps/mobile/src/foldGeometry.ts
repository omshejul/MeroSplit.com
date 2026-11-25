export type FoldRect = { x: number; y: number; width: number; height: number };
export type FoldRegion = { kind: 'division' | 'occlusion'; frame: FoldRect };

// Coordinates belong to the same root window. Bounds already exclude safe areas and IME.
export function usableFoldRegion(bounds: FoldRect, regions: readonly FoldRegion[]): FoldRect {
  const x = Number.isFinite(bounds.x) ? bounds.x : 0, y = Number.isFinite(bounds.y) ? bounds.y : 0;
  const width = Number.isFinite(bounds.width) && bounds.width > 0 && Number.isFinite(x + bounds.width) ? bounds.width : 0;
  const height = Number.isFinite(bounds.height) && bounds.height > 0 && Number.isFinite(y + bounds.height) ? bounds.height : 0;
  const right = x + width, bottom = y + height;
  let best: FoldRect = { x: right, y: bottom, width: 0, height: 0 }, bestArea = 0;
  if (!width || !height) return best;
  const covers = (a: FoldRect, b: FoldRect) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
  let obstacles: FoldRect[] = [];
  for (const { kind, frame: f } of regions) {
    if (![f.x, f.y, f.width, f.height, f.x + f.width, f.y + f.height].every(Number.isFinite) || f.width < 0 || f.height < 0) continue;
    if (!f.width && !f.height || kind === 'occlusion' && (!f.width || !f.height)) continue;
    if (f.x > right || f.y > bottom || f.x + f.width < x || f.y + f.height < y) continue;
    const gx = kind === 'division' && !f.width ? 8 : 0, gy = kind === 'division' && !f.height ? 8 : 0;
    const left = Math.max(x, f.x - gx), top = Math.max(y, f.y - gy);
    const clippedRight = Math.min(right, f.x + f.width + gx), clippedBottom = Math.min(bottom, f.y + f.height + gy);
    const rect = { x: left, y: top, width: clippedRight - left, height: clippedBottom - top };
    if (rect.width <= 0 || rect.height <= 0 || obstacles.some(other => covers(other, rect))) continue;
    obstacles = obstacles.filter(other => !covers(rect, other));
    obstacles.push(rect);
  }
  if (!obstacles.length) return { x, y, width, height };
  const edges = [...new Set([x, right, ...obstacles.flatMap(r => [r.x, r.x + r.width])])].sort((a, b) => a - b);
  const consider = (left: number, top: number, w: number, h: number) => {
    const area = w * h;
    if (area > bestArea || area === bestArea && area > 0 && (left > best.x || left === best.x && top > best.y)) {
      best = { x: left, y: top, width: w, height: h }; bestArea = area;
    }
  };
  // A maximal empty rectangle has left/right edges on bounds or obstacle edges.
  for (let i = 0; i < edges.length - 1; i++) for (let j = i + 1; j < edges.length; j++) {
    const left = edges[i], r = edges[j];
    const blocked = obstacles.filter(o => o.x < r && o.x + o.width > left).sort((a, b) => a.y - b.y);
    let top = y;
    for (const o of blocked) {
      if (o.y > top) consider(left, top, r - left, o.y - top);
      top = Math.max(top, o.y + o.height);
    }
    if (top < bottom) consider(left, top, r - left, bottom - top);
  }
  return best;
}
