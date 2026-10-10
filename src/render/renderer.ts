import { LANE_WIDTH, OBSTACLE, PLAYER, ROAD_HALF_WIDTH, TRACK } from '../core/config';
import { SPEED_MAX, SPEED_START } from '../game/difficulty';
import type { Obstacle, Orb } from '../game/entities';
import { isSliding, laneToX } from '../game/player';
import type { World } from '../game/world';
import { Particles } from './particles';
import { drawRunner, type RunnerPose } from './runner';
import { buildSky, buildSkyline, type SkylineLayer } from './sky';

export type Quality = 'high' | 'low';

export interface RenderFrame {
  world: World;
  /** Ambient clock (seconds), runs in menus too. */
  time: number;
  /** Real frame delta for visual-only animation. */
  dt: number;
  /** Seconds since the crash, or -1 while alive. */
  crashT: number;
}

const CYAN = '#36f1ff';
const MAGENTA = '#ff3ad2';
const VIOLET = '#9b6bff';
const AMBER = '#ffc552';
const HAZARD = '#ff3d7a';

const CAM_BACK = 6.2;
const FAR = 150;

const enum ItemType {
  Obstacle,
  Orb,
  Player,
  Arch,
}

interface DrawItem {
  z: number;
  type: ItemType;
  obstacle: Obstacle | null;
  orb: Orb | null;
}

function makeSprite(size: number, inner: string, outer: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/**
 * Canvas 2D renderer with a simple pinhole projection. The camera sits
 * CAM_BACK metres behind the runner; layout adapts to any aspect ratio so
 * all three lanes stay on screen in portrait and landscape.
 */
export class Renderer {
  readonly particles = new Particles(240);
  quality: Quality = 'high';
  reducedMotion = false;

  private readonly ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private horizon = 0;
  private f = 1;
  private camYBase = 3;
  private follow = 0.4;
  private camX = 0;
  private camY = 3;
  private readonly camZ = -CAM_BACK;
  private zMin = 0;

  private sky: HTMLCanvasElement | null = null;
  private layers: SkylineLayer[] = [];
  private roadGrad: CanvasGradient | null = null;
  private abyssGrad: CanvasGradient | null = null;
  private vignette: CanvasGradient | null = null;
  private readonly orbGlow = makeSprite(64, 'rgba(255,240,190,1)', 'rgba(255,170,40,0.45)');
  private readonly cyanGlow = makeSprite(64, 'rgba(200,255,255,0.9)', 'rgba(40,220,255,0.35)');
  private readonly magentaGlow = makeSprite(64, 'rgba(255,220,250,0.9)', 'rgba(255,50,200,0.35)');

  private shakeAmp = 0;
  private shakeTime = 0;
  private hitFlash = 0;
  private readonly items: DrawItem[] = [];
  private itemCount = 0;
  private readonly lines = new Float32Array(48 * 3);

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;
    for (let i = 0; i < 320; i++) this.items.push({ z: 0, type: ItemType.Obstacle, obstacle: null, orb: null });
    for (let i = 0; i < 48; i++) this.resetLine(i, Math.random());
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  resize(cssW: number, cssH: number, devicePixelRatio: number): void {
    const w = Math.max(1, cssW);
    const h = Math.max(1, cssH);
    // Cap backing-store size: DPR <= 2 (1.25 in low quality) and <= ~2.4 MP.
    let dpr = Math.min(devicePixelRatio || 1, this.quality === 'low' ? 1.25 : 2);
    const maxPixels = this.quality === 'low' ? 1.2e6 : 2.4e6;
    if (w * h * dpr * dpr > maxPixels) dpr = Math.sqrt(maxPixels / (w * h));
    dpr = Math.max(0.5, dpr);
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);

    const aspect = w / h;
    const portrait = aspect < 1;
    this.follow = portrait ? 0.15 : 0.4;
    this.horizon = h * (portrait ? 0.34 : 0.4);
    const ground = h * (portrait ? 0.85 : 0.87);
    const G = ground - this.horizon;
    // Keep the whole road (plus camera follow) inside 47% of the half-width.
    const needHalf = OBSTACLE.halfWidth + LANE_WIDTH + this.follow * LANE_WIDTH;
    let camY = 3.4;
    if ((needHalf * G) / camY > w * 0.47) camY = (needHalf * G) / (w * 0.47);
    camY = Math.min(camY, 7);
    this.camYBase = camY;
    this.f = (G * CAM_BACK) / camY;
    // Nearest visible ground plane (bottom of the screen).
    const zcBottom = (camY * this.f) / (h - this.horizon);
    this.zMin = Math.max(0.6, zcBottom * 0.9) + this.camZ;

    const ctx = this.ctx;
    this.roadGrad = ctx.createLinearGradient(0, this.horizon, 0, h);
    this.roadGrad.addColorStop(0, '#1a0d36');
    this.roadGrad.addColorStop(0.35, '#130a2c');
    this.roadGrad.addColorStop(1, '#0d0820');
    this.abyssGrad = ctx.createLinearGradient(0, this.horizon, 0, h);
    this.abyssGrad.addColorStop(0, '#2a0f4a');
    this.abyssGrad.addColorStop(0.25, '#0c0619');
    this.abyssGrad.addColorStop(1, '#030208');
    this.vignette = ctx.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.35, w / 2, h * 0.55, Math.max(w, h) * 0.8);
    this.vignette.addColorStop(0, 'rgba(0,0,0,0)');
    this.vignette.addColorStop(1, 'rgba(0,0,0,0.55)');

    this.sky = buildSky(w, this.horizon, dpr);
    const low = this.quality === 'low';
    this.layers = low ? [buildSkyline(w, h, dpr, 1, true)] : [buildSkyline(w, h, dpr, 0, false), buildSkyline(w, h, dpr, 1, false), buildSkyline(w, h, dpr, 2, false)];
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.particles.density = q === 'low' ? 0.45 : this.reducedMotion ? 0.5 : 1;
    this.resize(this.w, this.h, window.devicePixelRatio || 1);
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.particles.density = this.quality === 'low' ? 0.45 : on ? 0.5 : 1;
  }

  shake(amount: number): void {
    if (this.reducedMotion) return;
    this.shakeAmp = Math.max(this.shakeAmp, amount);
    this.shakeTime = 0;
  }

  /** Soft magenta edge pulse on impact (no full-screen white flashes). */
  impact(): void {
    this.hitFlash = 1;
  }

  // ---- projection -------------------------------------------------------------

  private sx(x: number, z: number): number {
    return this.w * 0.5 + ((x - this.camX) * this.f) / (z - this.camZ);
  }

  private sy(y: number, z: number): number {
    return this.horizon + ((this.camY - y) * this.f) / (z - this.camZ);
  }

  private scaleAt(z: number): number {
    return this.f / (z - this.camZ);
  }

  /** Screen position of the runner, for particles spawned by game events. */
  playerScreen(world: World): { x: number; y: number; s: number } {
    const p = world.player;
    return { x: this.sx(laneToX(p.x), 0), y: this.sy(p.y + 0.9, 0), s: this.scaleAt(0) };
  }

  orbScreen(orb: Orb, world: World): { x: number; y: number } {
    const z = Math.max(orb.z - world.distance, this.zMin + 0.1);
    return { x: this.sx(laneToX(orb.x), z), y: this.sy(orb.y, z) };
  }

  // ---- frame ---------------------------------------------------------------------

  render(frame: RenderFrame): void {
    const { world, dt } = frame;
    const ctx = this.ctx;
    const p = world.player;

    // Camera follows the runner a little, and rises slightly with jumps.
    this.camX = laneToX(p.x) * this.follow;
    this.camY = this.camYBase + p.y * 0.25;

    let ox = 0;
    let oy = 0;
    if (this.shakeAmp > 0.05) {
      this.shakeTime += dt;
      const decay = Math.exp(-this.shakeTime * 9);
      ox = (Math.random() - 0.5) * this.shakeAmp * decay;
      oy = (Math.random() - 0.5) * this.shakeAmp * decay;
      if (decay < 0.02) this.shakeAmp = 0;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, ox * this.dpr, oy * this.dpr);

    this.drawBackdrop(world.distance);
    this.drawRoad(world.distance, frame.time);
    this.drawHazardStrips(world);
    this.drawRails(world.distance);
    this.buildDrawList(world);
    this.drawItems(frame);
    if (!this.reducedMotion && this.quality === 'high') this.drawSpeedLines(world.speed, dt, frame.crashT < 0 && world.alive);

    this.particles.update(dt);
    this.particles.draw(ctx);

    ctx.fillStyle = this.vignette!;
    ctx.fillRect(-20, -20, this.w + 40, this.h + 40);
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt * 1.6);
      ctx.globalAlpha = this.hitFlash * 0.35;
      ctx.strokeStyle = HAZARD;
      ctx.lineWidth = Math.min(this.w, this.h) * 0.08;
      ctx.strokeRect(0, 0, this.w, this.h);
      ctx.globalAlpha = 1;
    }
  }

  private drawBackdrop(distance: number): void {
    const ctx = this.ctx;
    const w = this.w;
    if (this.sky) ctx.drawImage(this.sky, 0, 0, w, this.horizon + 2);
    for (const layer of this.layers) {
      const scroll = distance * layer.speed + this.camX * layer.parallax;
      let x = -(((scroll % layer.width) + layer.width) % layer.width);
      const top = this.horizon - layer.y + 1;
      const lh = layer.canvas.height / this.dpr;
      while (x < w) {
        ctx.drawImage(layer.canvas, x, top, layer.width, lh);
        x += layer.width;
      }
    }
    ctx.fillStyle = this.abyssGrad!;
    ctx.fillRect(0, this.horizon, w, this.h - this.horizon + 20);
    if (this.quality === 'high') this.drawCityBelow(distance);
    // Horizon haze line.
    ctx.fillStyle = 'rgba(255,80,210,0.35)';
    ctx.fillRect(0, this.horizon - 1, w, 2);
  }

  /** City lights far below the elevated highway; perspective gives free parallax. */
  private drawCityBelow(distance: number): void {
    const ctx = this.ctx;
    const step = 25;
    const depth = 30;
    const base = Math.floor(distance / step);
    const off = distance - base * step;
    const colors = ['rgba(54,241,255,0.55)', 'rgba(255,58,210,0.5)', 'rgba(255,197,82,0.5)'];
    for (let pass = 0; pass < 3; pass++) {
      ctx.fillStyle = colors[pass];
      for (let r = 0; r < 22; r++) {
        const z = 40 + r * step - off;
        const zc = z - this.camZ;
        const k = this.f / zc;
        const y = this.horizon + (this.camY + depth) * k;
        if (y > this.h) continue;
        const rowId = base + r;
        const size = Math.max(1, 0.9 * k);
        for (let c = -14; c <= 14; c++) {
          const hash = Math.imul(rowId, 73856093) ^ Math.imul(c + 50, 19349663);
          const v = (hash >>> 0) % 11;
          if (v > 3 || v % 3 !== pass) continue;
          const x = c * 12 + ((hash >>> 8) % 7);
          const sx = this.w * 0.5 + (x - this.camX) * k;
          if (sx < -4 || sx > this.w + 4) continue;
          ctx.fillRect(sx, y, size * (1 + (v & 1)), size);
        }
      }
    }
  }

  private quad(x0: number, x1: number, y: number, z0: number, z1: number): void {
    const ctx = this.ctx;
    ctx.moveTo(this.sx(x0, z0), this.sy(y, z0));
    ctx.lineTo(this.sx(x1, z0), this.sy(y, z0));
    ctx.lineTo(this.sx(x1, z1), this.sy(y, z1));
    ctx.lineTo(this.sx(x0, z1), this.sy(y, z1));
    ctx.closePath();
  }

  private drawRoad(distance: number, time: number): void {
    const ctx = this.ctx;
    const zn = this.zMin;
    const R = ROAD_HALF_WIDTH;
    const high = this.quality === 'high';

    ctx.fillStyle = this.roadGrad!;
    ctx.beginPath();
    this.quad(-R, R, 0, zn, FAR);
    ctx.fill();

    // Centre lane tint so the three lanes read clearly.
    ctx.fillStyle = 'rgba(120,80,255,0.07)';
    ctx.beginPath();
    this.quad(-LANE_WIDTH / 2, LANE_WIDTH / 2, 0, zn, FAR);
    ctx.fill();

    // Cross grid scrolling toward the player.
    const spacing = 6;
    const phase = distance % spacing;
    ctx.lineWidth = 1;
    const bands = high ? [24, 60, 120] : [40, 110];
    const alphas = high ? [0.22, 0.13, 0.06] : [0.18, 0.08];
    let z = Math.ceil((zn + phase) / spacing) * spacing - phase;
    for (let b = 0; b < bands.length; b++) {
      ctx.strokeStyle = `rgba(80,220,255,${alphas[b]})`;
      ctx.beginPath();
      while (z < bands[b]) {
        const y = this.sy(0, z);
        ctx.moveTo(this.sx(-R, z), y);
        ctx.lineTo(this.sx(R, z), y);
        z += spacing;
      }
      ctx.stroke();
    }

    // Lane dividers: dashed light strips.
    const period = 8;
    const dash = 3.4;
    const dphase = distance % period;
    ctx.fillStyle = 'rgba(120,240,255,0.75)';
    ctx.beginPath();
    for (let side = -1; side <= 1; side += 2) {
      const x = (side * LANE_WIDTH) / 2;
      for (let dz = -dphase; dz < 120; dz += period) {
        const z0 = Math.max(dz, zn);
        const z1 = dz + dash;
        if (z1 <= z0) continue;
        this.quad(x - 0.06, x + 0.06, 0, z0, z1);
      }
    }
    ctx.fill();

    // Track edges: bright cores with additive glow.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pulse = 0.85 + 0.15 * Math.sin(time * 2.2);
    if (high) {
      ctx.globalAlpha = 0.18 * pulse;
      ctx.fillStyle = CYAN;
      ctx.beginPath();
      this.quad(-R - 0.45, -R + 0.45, 0, zn, FAR);
      this.quad(R - 0.45, R + 0.45, 0, zn, FAR);
      ctx.fill();
    }
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = CYAN;
    ctx.beginPath();
    this.quad(-R - 0.09, -R + 0.09, 0, zn, FAR);
    this.quad(R - 0.09, R + 0.09, 0, zn, FAR);
    ctx.fill();
    ctx.restore();
  }

  private drawHazardStrips(world: World): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const o of world.obstacles) {
      if (!o.active) continue;
      const rel = o.z - world.distance;
      if (rel < 1 || rel > 115) continue;
      const fade = rel > 95 ? (115 - rel) / 20 : 1;
      const x = laneToX(o.lane);
      ctx.fillStyle = o.kind === 'low' ? AMBER : o.kind === 'gate' ? VIOLET : HAZARD;
      ctx.globalAlpha = 0.06 * fade;
      ctx.beginPath();
      this.quad(x - 1.05, x + 1.05, 0, Math.max(rel - 9, this.zMin), rel - 3);
      ctx.fill();
      ctx.globalAlpha = 0.14 * fade;
      ctx.beginPath();
      this.quad(x - 1.05, x + 1.05, 0, Math.max(rel - 3, this.zMin), rel);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawRails(distance: number): void {
    const ctx = this.ctx;
    const R = ROAD_HALF_WIDTH + 0.55;
    const zn = this.zMin;
    const railY = 0.7;

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,58,210,0.75)';
    ctx.beginPath();
    for (let side = -1; side <= 1; side += 2) {
      ctx.moveTo(this.sx(side * R, zn), this.sy(railY, zn));
      ctx.lineTo(this.sx(side * R, FAR), this.sy(railY, FAR));
    }
    // Rail posts every 10 m.
    const phase = distance % 10;
    for (let z = 10 - phase; z < 110; z += 10) {
      if (z < zn) continue;
      for (let side = -1; side <= 1; side += 2) {
        const x = this.sx(side * R, z);
        ctx.moveTo(x, this.sy(0, z));
        ctx.lineTo(x, this.sy(railY, z));
      }
    }
    ctx.stroke();

    // Light pylons every 40 m with glowing heads.
    const pphase = distance % 40;
    ctx.save();
    for (let z = 40 - pphase; z < 140; z += 40) {
      if (z < zn + 0.5) continue;
      const k = this.scaleAt(z);
      const fade = z > 110 ? (140 - z) / 30 : 1;
      for (let side = -1; side <= 1; side += 2) {
        const x = this.sx(side * (R + 0.9), z);
        const y0 = this.sy(0, z);
        const y1 = this.sy(5, z);
        ctx.globalAlpha = fade;
        ctx.strokeStyle = '#3b2a7a';
        ctx.lineWidth = Math.max(1, 0.12 * k);
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
        ctx.lineTo(x - side * 0.8 * k, y1);
        ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
        const g = 1.6 * k;
        ctx.drawImage(side < 0 ? this.cyanGlow : this.magentaGlow, x - side * 0.8 * k - g, y1 - g, g * 2, g * 2);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.restore();
  }

  // ---- objects -------------------------------------------------------------------

  private pushItem(z: number, type: ItemType, obstacle: Obstacle | null, orb: Orb | null): void {
    if (this.itemCount >= this.items.length) return;
    const it = this.items[this.itemCount++];
    it.z = z;
    it.type = type;
    it.obstacle = obstacle;
    it.orb = orb;
  }

  private buildDrawList(world: World): void {
    this.itemCount = 0;
    const d = world.distance;
    const nearest = this.zMin;
    for (const o of world.obstacles) {
      if (!o.active) continue;
      const rel = o.z - d;
      if (rel > FAR || rel + o.depth < nearest) continue;
      // Objects alongside the runner are drawn before it.
      const key = rel + o.depth < -0.35 ? rel : Math.max(rel, 0.01);
      this.pushItem(key, ItemType.Obstacle, o, null);
    }
    for (const orb of world.orbs) {
      if (!orb.active || orb.collected) continue;
      const rel = orb.z - d;
      if (rel > FAR || rel < nearest) continue;
      this.pushItem(rel, ItemType.Orb, null, orb);
    }
    this.pushItem(0, ItemType.Player, null, null);
    if (this.quality === 'high') {
      const phase = d % 180;
      for (let z = 180 - phase - 180; z < FAR; z += 180) {
        if (z > nearest + 1) this.pushItem(z, ItemType.Arch, null, null);
      }
    }
    // Insertion sort, far to near. The list is nearly sorted frame to frame.
    const items = this.items;
    for (let i = 1; i < this.itemCount; i++) {
      const it = items[i];
      let j = i - 1;
      while (j >= 0 && items[j].z < it.z) {
        items[j + 1] = items[j];
        j--;
      }
      items[j + 1] = it;
    }
  }

  private drawItems(frame: RenderFrame): void {
    for (let i = 0; i < this.itemCount; i++) {
      const it = this.items[i];
      switch (it.type) {
        case ItemType.Obstacle:
          this.drawObstacle(it.obstacle!, frame.world.distance, frame.time);
          break;
        case ItemType.Orb:
          this.drawOrb(it.orb!, frame.world.distance, frame.time);
          break;
        case ItemType.Player:
          this.drawPlayer(frame);
          break;
        case ItemType.Arch:
          this.drawArch(it.z);
          break;
      }
    }
    this.ctx.globalAlpha = 1;
  }

  private box(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    front: string,
    side: string,
    top: string,
    edge: string,
  ): void {
    const ctx = this.ctx;
    const zc = Math.max(z0, this.zMin);
    if (z1 <= zc) return;
    const fx0 = this.sx(x0, zc);
    const fx1 = this.sx(x1, zc);
    const fy0 = this.sy(y0, zc);
    const fy1 = this.sy(y1, zc);
    const bx0 = this.sx(x0, z1);
    const bx1 = this.sx(x1, z1);
    const by0 = this.sy(y0, z1);
    const by1 = this.sy(y1, z1);

    if (this.camY > y1) {
      ctx.fillStyle = top;
      ctx.beginPath();
      ctx.moveTo(fx0, fy1);
      ctx.lineTo(fx1, fy1);
      ctx.lineTo(bx1, by1);
      ctx.lineTo(bx0, by1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = side;
    if (this.camX < x0) {
      ctx.beginPath();
      ctx.moveTo(fx0, fy0);
      ctx.lineTo(fx0, fy1);
      ctx.lineTo(bx0, by1);
      ctx.lineTo(bx0, by0);
      ctx.closePath();
      ctx.fill();
    } else if (this.camX > x1) {
      ctx.beginPath();
      ctx.moveTo(fx1, fy0);
      ctx.lineTo(fx1, fy1);
      ctx.lineTo(bx1, by1);
      ctx.lineTo(bx1, by0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = front;
    ctx.fillRect(fx0, fy1, fx1 - fx0, fy0 - fy1);
    ctx.strokeStyle = edge;
    ctx.lineWidth = Math.max(1, this.scaleAt(zc) * 0.05);
    ctx.strokeRect(fx0, fy1, fx1 - fx0, fy0 - fy1);
    ctx.beginPath();
    ctx.moveTo(fx0, fy1);
    ctx.lineTo(bx0, by1);
    ctx.lineTo(bx1, by1);
    ctx.lineTo(fx1, fy1);
    ctx.stroke();
  }

  private drawObstacle(o: Obstacle, distance: number, time: number): void {
    const ctx = this.ctx;
    const rel = o.z - distance;
    const x = laneToX(o.lane);
    const hw = OBSTACLE.halfWidth - 0.05;
    const fadeStart = TRACK.viewDistance;
    ctx.globalAlpha = rel > fadeStart ? Math.max(0, (FAR - rel) / (FAR - fadeStart)) : 1;
    const z0 = rel;
    const z1 = rel + o.depth;
    const zf = Math.max(z0, this.zMin);
    const k = this.scaleAt(zf);
    const lw = Math.max(1, k * 0.05);

    switch (o.kind) {
      case 'low': {
        const H = OBSTACLE.lowHeight;
        this.box(x - hw, x - hw + 0.16, 0, H + 0.12, z0, z1, '#3a1546', '#2a0f36', '#5a2066', MAGENTA);
        this.box(x + hw - 0.16, x + hw, 0, H + 0.12, z0, z1, '#3a1546', '#2a0f36', '#5a2066', MAGENTA);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = AMBER;
        const xa = this.sx(x - hw + 0.16, zf);
        const xb = this.sx(x + hw - 0.16, zf);
        const pulse = 0.75 + 0.25 * Math.sin(time * 6 + o.variant);
        ctx.globalAlpha *= pulse;
        ctx.fillRect(xa, this.sy(H, zf), xb - xa, Math.max(1.5, 0.14 * k));
        ctx.fillRect(xa, this.sy(0.36, zf), xb - xa, Math.max(1, 0.08 * k));
        if (this.quality === 'high') {
          ctx.globalAlpha *= 0.35;
          ctx.fillRect(xa, this.sy(H + 0.1, zf), xb - xa, 0.32 * k);
        }
        ctx.restore();
        // Holographic "jump" chevron floating above the barrier.
        if (rel < 70) this.chevron(x, 1.15, zf, 1, AMBER, k);
        break;
      }
      case 'gate': {
        const top = OBSTACLE.gateTop;
        this.box(x - hw, x - hw + 0.18, 0, top, z0, z1, '#2b1f5c', '#1d1544', '#3d2c80', VIOLET);
        this.box(x + hw - 0.18, x + hw, 0, top, z0, z1, '#2b1f5c', '#1d1544', '#3d2c80', VIOLET);
        this.box(x - hw, x + hw, top - 0.18, top, z0, z1, '#2b1f5c', '#1d1544', '#3d2c80', VIOLET);
        // Energy beam at head height; slide underneath.
        const xa = this.sx(x - hw + 0.18, zf);
        const xb = this.sx(x + hw - 0.18, zf);
        const yb = this.sy(OBSTACLE.gateBottom, zf);
        const yt = this.sy(OBSTACLE.gateBottom + 0.5, zf);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(160,110,255,0.55)';
        ctx.fillRect(xa, yt, xb - xa, yb - yt);
        ctx.fillStyle = CYAN;
        ctx.fillRect(xa, yb - Math.max(1.5, 0.06 * k), xb - xa, Math.max(1.5, 0.06 * k));
        ctx.fillRect(xa, yt, xb - xa, Math.max(1, 0.04 * k));
        ctx.restore();
        if (rel < 70) {
          for (let i = -1; i <= 1; i++) this.chevron(x + i * 0.55, OBSTACLE.gateBottom + 0.38, zf, -1, '#140b33', k * 0.7);
        }
        break;
      }
      case 'block': {
        this.box(x - hw, x + hw, 0, OBSTACLE.wallHeight, z0, z1, '#2a0a2e', '#1f0824', '#45124c', HAZARD);
        const xa = this.sx(x - hw, zf);
        const xb = this.sx(x + hw, zf);
        const ya = this.sy(OBSTACLE.wallHeight, zf);
        const yb = this.sy(0, zf);
        const m = (xb - xa) * 0.18;
        ctx.strokeStyle = MAGENTA;
        ctx.lineWidth = lw * 2.2;
        ctx.beginPath();
        ctx.moveTo(xa + m, ya + m);
        ctx.lineTo(xb - m, yb - m);
        ctx.moveTo(xb - m, ya + m);
        ctx.lineTo(xa + m, yb - m);
        ctx.stroke();
        break;
      }
      case 'wall': {
        const H = OBSTACLE.wallHeight - 0.1;
        this.box(x - hw, x + hw, 0, H, z0, z1, '#0f1a3d', '#0b1330', '#1b2d5e', CYAN);
        // Running lights along the side facing the camera.
        const sideX = this.camX < x - hw ? x - hw : this.camX > x + hw ? x + hw : NaN;
        if (!Number.isNaN(sideX)) {
          ctx.strokeStyle = MAGENTA;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(this.sx(sideX, zf), this.sy(1.6, zf));
          ctx.lineTo(this.sx(sideX, z1), this.sy(1.6, z1));
          ctx.moveTo(this.sx(sideX, zf), this.sy(0.5, zf));
          ctx.lineTo(this.sx(sideX, z1), this.sy(0.5, z1));
          ctx.stroke();
        }
        // Hazard stripes on the front face.
        if (z0 >= this.zMin) {
          const xa = this.sx(x - hw, z0);
          const xb = this.sx(x + hw, z0);
          const yt = this.sy(H * 0.55, z0);
          const ybm = this.sy(H * 0.3, z0);
          ctx.save();
          ctx.beginPath();
          ctx.rect(xa, yt, xb - xa, ybm - yt);
          ctx.clip();
          ctx.fillStyle = HAZARD;
          const step = (xb - xa) / 5;
          ctx.beginPath();
          for (let i = -1; i < 6; i++) {
            const sx = xa + i * step;
            ctx.moveTo(sx, ybm);
            ctx.lineTo(sx + step * 0.5, ybm);
            ctx.lineTo(sx + step, yt);
            ctx.lineTo(sx + step * 0.5, yt);
            ctx.closePath();
          }
          ctx.fill();
          ctx.restore();
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = CYAN;
          ctx.fillRect(xa, this.sy(H, z0), xb - xa, Math.max(1.5, 0.08 * k));
          ctx.restore();
        }
        break;
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Chevron glyph on a front plane: dir 1 points up (jump), -1 points down (slide). */
  private chevron(x: number, y: number, z: number, dir: 1 | -1, color: string, k: number): void {
    const ctx = this.ctx;
    const cx = this.sx(x, z);
    const cy = this.sy(y, z);
    const s = 0.22 * k;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, 0.07 * k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - s, cy + s * 0.5 * dir);
    ctx.lineTo(cx, cy - s * 0.5 * dir);
    ctx.lineTo(cx + s, cy + s * 0.5 * dir);
    ctx.stroke();
  }

  private drawOrb(orb: Orb, distance: number, time: number): void {
    const ctx = this.ctx;
    const z = orb.z - distance;
    const k = this.scaleAt(z);
    const x = this.sx(laneToX(orb.x), z);
    const bob = Math.sin(time * 4 + orb.z) * 0.05;
    const y = this.sy(orb.y + bob, z);
    const r = 0.3 * k;
    // Fade in at the horizon; fade out once behind the runner (close to the camera).
    ctx.globalAlpha = z > TRACK.viewDistance ? Math.max(0, (FAR - z) / (FAR - TRACK.viewDistance)) : z < 0 ? Math.max(0, 1 + z / 2.5) : 1;
    if (ctx.globalAlpha <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = r * (this.quality === 'high' ? 3.2 : 2.2);
    ctx.drawImage(this.orbGlow, x - g, y - g, g * 2, g * 2);
    ctx.restore();
    const spin = Math.abs(Math.cos(time * 3 + orb.z * 0.3));
    ctx.fillStyle = '#fff3c4';
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * (0.25 + 0.55 * spin), y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r * (0.25 + 0.55 * spin), y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = Math.max(1, r * 0.18);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawArch(z: number): void {
    const ctx = this.ctx;
    const k = this.scaleAt(z);
    const R = ROAD_HALF_WIDTH + 1.4;
    const H = 7.5;
    ctx.save();
    ctx.globalAlpha = z > 110 ? Math.max(0, (FAR - z) / 40) * 0.8 : 0.8;
    ctx.strokeStyle = VIOLET;
    ctx.lineWidth = Math.max(1, 0.18 * k);
    ctx.beginPath();
    ctx.moveTo(this.sx(-R, z), this.sy(0, z));
    ctx.lineTo(this.sx(-R, z), this.sy(H - 1.2, z));
    ctx.lineTo(this.sx(-R + 1.2, z), this.sy(H, z));
    ctx.lineTo(this.sx(R - 1.2, z), this.sy(H, z));
    ctx.lineTo(this.sx(R, z), this.sy(H - 1.2, z));
    ctx.lineTo(this.sx(R, z), this.sy(0, z));
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = MAGENTA;
    for (let i = -3; i <= 3; i++) {
      const lx = this.sx(i * 1.1, z);
      ctx.fillRect(lx - 0.25 * k, this.sy(H - 0.05, z), 0.5 * k, Math.max(1, 0.12 * k));
    }
    ctx.restore();
  }

  private drawPlayer(frame: RenderFrame): void {
    const ctx = this.ctx;
    const world = frame.world;
    const p = world.player;
    const wx = laneToX(p.x);
    const k = this.scaleAt(0);
    const x = this.sx(wx, 0);
    const ground = this.sy(0, 0);

    // Ground shadow + glow, shrinking with height.
    const shadowScale = Math.max(0.35, 1 - p.y * 0.4);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(x, ground, 0.5 * k * shadowScale, 0.12 * k * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 * shadowScale;
    const g = 1.2 * k * shadowScale;
    ctx.drawImage(this.cyanGlow, x - g, ground - g * 0.35, g * 2, g * 0.7);
    ctx.restore();

    const sliding = isSliding(p);
    const pose: RunnerPose = this.pose;
    pose.phase = world.distance * 1.9;
    pose.tilt = Math.max(-0.35, Math.min(0.35, (p.lane - p.x) * 0.3));
    pose.air = p.airborne ? Math.min(1, p.y / 0.5) : 0;
    pose.slide = sliding ? Math.min(1, (PLAYER.slideDuration - p.slideTime) / 0.08, p.slideTime / 0.1) : 0;
    pose.crash = frame.crashT >= 0 ? Math.min(1, frame.crashT / 0.7) : 0;
    drawRunner(ctx, x, this.sy(p.y, 0), k, pose);

    // Slide sparks.
    if (sliding && frame.crashT < 0 && Math.random() < 0.6) {
      this.particles.burst(x + (Math.random() - 0.5) * 0.6 * k, ground, 1, Math.random() < 0.5 ? AMBER : MAGENTA, 0.9 * k * 3, 0.35, 0.06 * k, 40, 1, 0.8, -Math.PI / 2);
    }
  }

  private readonly pose: RunnerPose = { phase: 0, tilt: 0, air: 0, slide: 0, crash: 0 };

  // ---- speed lines -----------------------------------------------------------------

  private resetLine(i: number, r: number): void {
    // Only upper and side directions so lines never cross the track.
    const a = -Math.PI * (0.02 + Math.random() * 0.96);
    this.lines[i * 3] = a;
    this.lines[i * 3 + 1] = r;
    this.lines[i * 3 + 2] = 0.04 + Math.random() * 0.08;
  }

  private drawSpeedLines(speed: number, dt: number, active: boolean): void {
    const intensity = Math.max(0, (speed - SPEED_START - 4) / (SPEED_MAX - SPEED_START - 4));
    if (intensity <= 0 || !active) return;
    const ctx = this.ctx;
    const count = Math.floor(10 + intensity * 38);
    const cx = this.w * 0.5;
    const cy = this.horizon;
    const maxR = Math.hypot(this.w, this.h) * 0.6;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(160,220,255,1)';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.12 + intensity * 0.18;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      let r = this.lines[i * 3 + 1] + dt * (0.5 + intensity * 1.3);
      if (r > 1) {
        this.resetLine(i, 0.25);
        r = 0.25;
      }
      this.lines[i * 3 + 1] = r;
      const a = this.lines[i * 3];
      const len = this.lines[i * 3 + 2];
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      ctx.moveTo(cx + ca * r * maxR, cy + sa * r * maxR * 0.9);
      ctx.lineTo(cx + ca * (r + len) * maxR, cy + sa * (r + len) * maxR * 0.9);
    }
    ctx.stroke();
    ctx.restore();
  }
}
