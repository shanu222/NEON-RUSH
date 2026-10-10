import { FIXED_DT, MAX_FRAME_DT, MAX_STEPS_PER_FRAME } from './config';

/**
 * Single requestAnimationFrame loop with a fixed simulation step.
 * Simulation speed is independent of display refresh rate (30/60/120/144 Hz
 * all advance the world identically). `start()` is idempotent, so the loop
 * can never be duplicated.
 */
export class Loop {
  private raf = 0;
  private running = false;
  private last = 0;
  private acc = 0;

  constructor(
    private readonly update: (dt: number) => void,
    private readonly render: (frameDt: number) => void,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Forget accumulated time (after pauses / hidden tabs). */
  resync(): void {
    this.last = performance.now();
    this.acc = 0;
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const frameDt = Math.min(Math.max(0, (now - this.last) / 1000), MAX_FRAME_DT);
    this.last = now;
    this.acc += frameDt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.update(FIXED_DT);
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.acc = 0;
    this.render(frameDt);
    this.raf = requestAnimationFrame(this.tick);
  };
}
