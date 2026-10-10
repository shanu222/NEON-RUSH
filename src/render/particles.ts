/**
 * Fixed-capacity screen-space particle system. Particles live in a
 * preallocated pool; spawning when full overwrites the oldest slot, so no
 * allocation happens after construction.
 */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  gravity: number;
  drag: number;
  shape: 0 | 1; // 0 = dot, 1 = streak
}

export class Particles {
  private readonly pool: Particle[] = [];
  private cursor = 0;
  /** Fraction of requested particles actually spawned (quality / reduced motion). */
  density = 1;

  constructor(capacity: number) {
    for (let i = 0; i < capacity; i++) {
      this.pool.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1, color: '#fff', gravity: 0, drag: 0, shape: 0 });
    }
  }

  clear(): void {
    for (const p of this.pool) p.life = 0;
  }

  burst(
    x: number,
    y: number,
    count: number,
    color: string,
    speed: number,
    life: number,
    size: number,
    gravity = 0,
    shape: 0 | 1 = 0,
    spreadAngle = Math.PI * 2,
    baseAngle = 0,
  ): void {
    const n = Math.max(1, Math.round(count * this.density));
    for (let i = 0; i < n; i++) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.pool.length;
      const a = baseAngle + (Math.random() - 0.5) * spreadAngle;
      const v = speed * (0.35 + Math.random() * 0.65);
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v;
      p.max = p.life = life * (0.6 + Math.random() * 0.4);
      p.size = size * (0.6 + Math.random() * 0.6);
      p.color = color;
      p.gravity = gravity;
      p.drag = 2.2;
      p.shape = shape;
    }
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      const t = p.life / p.max;
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      if (p.shape === 1) {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.6;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        ctx.stroke();
      } else {
        const s = p.size * (0.5 + 0.5 * t);
        ctx.fillRect(p.x - s * 0.5, p.y - s * 0.5, s, s);
      }
    }
    ctx.restore();
  }
}
