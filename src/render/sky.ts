import { Rng } from '../core/rng';

/**
 * Pre-rendered backdrop: gradient sky, stars, the "halo ring" and three
 * tileable skyline layers. Rebuilt only on resize; per frame we just blit.
 */
export interface SkylineLayer {
  canvas: HTMLCanvasElement;
  width: number;
  /** Pixels of scroll per metre travelled. */
  speed: number;
  /** Pixels of shift per metre of camera x movement. */
  parallax: number;
  /** Vertical offset of the layer's bottom relative to the horizon. */
  y: number;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function buildSky(w: number, horizon: number, dpr: number): HTMLCanvasElement {
  const c = makeCanvas(w * dpr, (horizon + 2) * dpr);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const g = ctx.createLinearGradient(0, 0, 0, horizon);
  g.addColorStop(0, '#03020b');
  g.addColorStop(0.45, '#0b0623');
  g.addColorStop(0.8, '#1f0b3d');
  g.addColorStop(1, '#3a1159');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, horizon + 2);

  const rng = new Rng(7331);
  const stars = Math.round((w * horizon) / 2600);
  for (let i = 0; i < stars; i++) {
    const x = rng.next() * w;
    const y = rng.next() * horizon * 0.75;
    const a = 0.25 + rng.next() * 0.6;
    ctx.fillStyle = rng.chance(0.15) ? `rgba(255,170,240,${a})` : `rgba(200,230,255,${a})`;
    const s = rng.chance(0.1) ? 1.6 : 1;
    ctx.fillRect(x, y, s, s);
  }

  // Halo ring: a large eclipse-like ring sitting behind the city.
  const r = Math.min(w * 0.36, horizon * 0.75);
  const cx = w * 0.5;
  const cy = horizon + r * 0.15;
  const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.5);
  glow.addColorStop(0, 'rgba(255,60,200,0.18)');
  glow.addColorStop(0.5, 'rgba(120,60,255,0.08)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, horizon);
  const disc = ctx.createLinearGradient(0, cy - r, 0, cy);
  disc.addColorStop(0, 'rgba(40,12,70,0.95)');
  disc.addColorStop(1, 'rgba(70,16,90,0.95)');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.94, 0, Math.PI * 2);
  ctx.fillStyle = disc;
  ctx.fill();
  const rim = ctx.createLinearGradient(0, cy - r, 0, cy);
  rim.addColorStop(0, '#ffb347');
  rim.addColorStop(0.5, '#ff3fb4');
  rim.addColorStop(1, '#7a4dff');
  ctx.lineWidth = Math.max(2, r * 0.035);
  ctx.strokeStyle = rim;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = Math.max(1, r * 0.012);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.08, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // Horizontal scan cuts through the lower ring.
  ctx.fillStyle = '#2a0d48';
  for (let i = 0; i < 6; i++) {
    const y = cy - r * 0.45 + i * i * r * 0.025 + i * r * 0.05;
    ctx.fillRect(cx - r * 1.1, y, r * 2.2, Math.max(1, r * (0.012 + i * 0.006)));
  }
  return c;
}

export function buildSkyline(
  w: number,
  h: number,
  dpr: number,
  layer: 0 | 1 | 2,
  lowQuality: boolean,
): SkylineLayer {
  const unit = Math.max(0.6, h / 820);
  const width = Math.ceil(Math.max(w, 640) * 1.5);
  const maxH = [h * 0.17, h * 0.13, h * 0.09][layer];
  const c = makeCanvas(width * dpr, (maxH + 4) * dpr);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const rng = new Rng(1000 + layer * 77);
  const body = ['#170b33', '#120827', '#0b0519'][layer];
  const edge = ['rgba(150,90,255,0.35)', 'rgba(255,60,200,0.35)', 'rgba(60,240,255,0.4)'][layer];
  const windows = ['rgba(150,120,255,', 'rgba(255,90,210,', 'rgba(70,240,255,'][layer];

  let x = 0;
  while (x < width) {
    let bw = (14 + rng.next() * 46) * unit * (1 + layer * 0.25);
    if (x + bw > width) bw = width - x;
    const bh = maxH * (0.3 + rng.next() * 0.7) * (rng.chance(0.12) ? 1 : 0.8);
    const top = maxH + 4 - bh;
    ctx.fillStyle = body;
    ctx.fillRect(x, top, bw - 1, bh);
    ctx.fillStyle = edge;
    ctx.fillRect(x, top, bw - 1, 1);
    if (rng.chance(0.25)) {
      const ax = x + bw * (0.3 + rng.next() * 0.4);
      ctx.fillRect(ax, top - 8 * unit, 1, 8 * unit);
    }
    if (!lowQuality) {
      const cols = Math.max(1, Math.floor(bw / (6 * unit)));
      const rows = Math.max(1, Math.floor(bh / (7 * unit)));
      for (let cx = 0; cx < cols; cx++) {
        for (let ry = 1; ry < rows; ry++) {
          if (!rng.chance(0.16)) continue;
          ctx.fillStyle = windows + (0.25 + rng.next() * 0.5).toFixed(2) + ')';
          ctx.fillRect(x + 2 * unit + cx * 6 * unit, top + ry * 7 * unit, 2 * unit, 2.2 * unit);
        }
      }
    }
    x += bw + (rng.chance(0.3) ? rng.next() * 8 * unit : 0);
  }
  return {
    canvas: c,
    width,
    speed: [0.12, 0.3, 0.6][layer],
    parallax: [2, 5, 10][layer] * unit,
    y: maxH + 4,
  };
}
