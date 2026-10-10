import { AudioEngine } from '../audio/audio';
import { Loop } from '../core/loop';
import { randomSeed } from '../core/rng';
import { Input } from '../input/input';
import { Renderer } from '../render/renderer';
import { SaveStore, type Settings } from '../storage/save';
import { UI } from '../ui/ui';
import type { Action, ActionResult } from './player';
import { isSliding } from './player';
import { World } from './world';

/**
 * loading  - booting
 * menu     - main menu, attract-mode scenery (no hazards, no scoring)
 * ready    - 3-2-1 countdown before a run or after resuming; world frozen
 * playing  - simulation running, gameplay input enabled
 * paused   - everything frozen; nothing advances
 * gameover - crash animation, then the summary card
 */
export type GameState = 'loading' | 'menu' | 'ready' | 'playing' | 'paused' | 'gameover';

export interface GameOptions {
  /** Fixed track seed for reproducible runs (`?seed=123`). */
  seed: number | null;
  /** Expose a read-only state snapshot on `window.__NEON_RUSH__` (`?debug=1`). */
  debug: boolean;
}

const COUNT_STEP = 0.5;
const COUNT_FROM = 3;
const GAMEOVER_DELAY = 0.85;
const RESTART_GUARD = 0.25;
const MENU_SPEED = 13;

export interface Snapshot {
  state: GameState;
  seed: number;
  distance: number;
  score: number;
  orbs: number;
  lane: number;
  x: number;
  y: number;
  airborne: boolean;
  sliding: boolean;
  tier: number;
  speed: number;
  alive: boolean;
  gameOverCount: number;
  runsStarted: number;
  quality: string;
  reducedMotion: boolean;
  canvas: { width: number; height: number; cssWidth: number; cssHeight: number };
  audioUnlocked: boolean;
  storageAvailable: boolean;
  activeObstacles: number;
}

export class Game {
  state: GameState = 'loading';
  readonly world = new World(1);
  readonly save = new SaveStore();
  readonly audio = new AudioEngine();
  readonly renderer: Renderer;
  readonly ui: UI;
  readonly input: Input;
  private readonly loop: Loop;

  private time = 0;
  private countdown = 0;
  private countdownShown = -1;
  private goTimer = 0;
  private crashT = -1;
  private overShown = false;
  private overT = 0;
  private runFinalized = false;
  private newBest = false;
  private bestAtStart = 0;
  private bestToastShown = false;
  private renderedPaused = false;
  private systemReducedMotion = false;
  private autoLow = false;
  private perfAcc = 0;
  private perfFrames = 0;
  private perfSlowWindows = 0;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private gameOverCount = 0;
  private runsStarted = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: GameOptions,
  ) {
    this.renderer = new Renderer(canvas);
    this.ui = new UI({
      play: () => this.state === 'menu' && this.startRun(),
      resume: () => this.resume(),
      restart: () => (this.state === 'paused' || this.state === 'gameover') && this.startRun(),
      menu: () => this.goMenu(),
      pause: () => this.pause(),
      toggleMute: () => {
        this.updateSettings({ sound: !this.save.settings.sound });
        this.blurControls();
      },
      toggleFullscreen: () => this.toggleFullscreen(),
      settingsChanged: (patch) => this.updateSettings(patch),
      resetRecords: () => {
        this.save.resetRecords();
        this.ui.setStats(this.save.records);
      },
      click: () => this.audio.play('click'),
      panelClosed: () => {
        this.renderedPaused = false;
      },
    });
    this.input = new Input(this.ui.root, document.getElementById('touchpad')!, {
      gesture: () => this.audio.unlock(),
      acceptsActions: () => this.state === 'playing' && this.ui.panel === null,
      capturesKeys: () => this.state === 'playing' || this.state === 'ready',
      action: (a) => this.onAction(a),
      pauseKey: (key) => this.onPauseKey(key),
      primary: () => this.onPrimary(),
    });
    this.loop = new Loop(
      (dt) => this.update(dt),
      (dt) => this.frame(dt),
    );
    this.bindWorldEvents();
  }

  init(): void {
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.systemReducedMotion = mq?.matches ?? false;
    mq?.addEventListener?.('change', (e) => {
      this.systemReducedMotion = e.matches;
      this.applySettings();
    });
    this.applySettings();
    this.observeSize();

    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('blur', () => {
      if (this.state === 'playing' || this.state === 'ready') this.pause();
    });
    window.addEventListener('pagehide', () => this.audio.setHidden(true));
    window.addEventListener('pageshow', () => this.audio.setHidden(document.hidden));

    const fsEnabled =
      document.fullscreenEnabled || (document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled === true;
    this.ui.setFullscreenAvailable(Boolean(fsEnabled));
    document.addEventListener('fullscreenchange', () => this.ui.setFullscreenActive(document.fullscreenElement !== null));

    if (this.opts.debug) this.exposeDebug();
    this.loop.start();
    this.goMenu();
  }

  // ---- state transitions ---------------------------------------------------------

  private setState(state: GameState): void {
    this.state = state;
    this.ui.setState(state);
    this.input.reset();
    this.renderedPaused = false;
  }

  goMenu(): void {
    this.setState('menu');
    this.world.reset(this.opts.seed ?? 1);
    this.world.clearHazards();
    this.renderer.particles.clear();
    this.crashT = -1;
    this.ui.closePanel(false);
    this.ui.hideHint();
    this.ui.clearToasts();
    this.ui.showCountdown(null);
    this.ui.setHudVisible(false);
    this.ui.setStats(this.save.records);
    this.ui.showScreen('menu');
    this.audio.setIntensity(0);
    this.audio.setMusic('menu');
  }

  startRun(): void {
    const seed = this.opts.seed ?? randomSeed();
    this.world.reset(seed);
    this.renderer.particles.clear();
    this.crashT = -1;
    this.overShown = false;
    this.runFinalized = false;
    this.newBest = false;
    this.bestAtStart = this.save.records.bestScore;
    this.bestToastShown = false;
    this.runsStarted++;
    this.ui.closePanel(false);
    this.ui.clearToasts();
    this.ui.resetHud();
    this.ui.setHudVisible(true);
    this.ui.showScreen(null);
    if (this.save.records.runs === 0) this.ui.showHint();
    this.audio.setIntensity(0);
    this.beginCountdown();
  }

  private beginCountdown(): void {
    this.setState('ready');
    this.countdown = COUNT_FROM * COUNT_STEP;
    this.countdownShown = -1;
    this.audio.setMusic('game');
    this.loop.resync();
  }

  pause(): void {
    if (this.state !== 'playing' && this.state !== 'ready') return;
    this.setState('paused');
    this.ui.showCountdown(null);
    this.ui.hideHint();
    this.ui.showScreen('pause');
    this.audio.setMusic(null);
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.ui.closePanel(false);
    this.ui.showScreen(null);
    this.beginCountdown();
  }

  private toGameOver(): void {
    if (this.state !== 'playing') return;
    this.setState('gameover');
    this.crashT = 0;
    this.overT = 0;
    this.ui.hideHint();
    this.audio.setMusic(null);
    this.finalizeRun();
  }

  /** Runs exactly once per run: records are saved before the summary shows. */
  private finalizeRun(): void {
    if (this.runFinalized) return;
    this.runFinalized = true;
    this.gameOverCount++;
    const w = this.world;
    const score = w.totalScore;
    const result = this.save.recordRun(score, w.distance, w.score.orbs);
    this.newBest = result.score && score > 0;
    this.ui.setGameOver(score, w.distance, w.score.orbs, this.save.records.bestScore, this.newBest);
  }

  private showGameOver(): void {
    this.overShown = true;
    this.ui.setHudVisible(false);
    this.ui.showScreen('over');
    this.audio.setMusic('menu');
    if (this.newBest) {
      this.audio.play('best');
      this.confetti();
    }
  }

  // ---- input -------------------------------------------------------------------------

  private onAction(action: Action): void {
    if (this.state !== 'playing') return;
    this.world.act(action);
  }

  private onPauseKey(key: 'escape' | 'p'): void {
    if (this.ui.panel) {
      if (key === 'escape') this.ui.closePanel();
      return;
    }
    if (this.state === 'playing' || this.state === 'ready') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  private onPrimary(): boolean {
    if (this.ui.panel) return false;
    switch (this.state) {
      case 'menu':
        this.startRun();
        return true;
      case 'paused':
        this.resume();
        return true;
      case 'gameover':
        if (this.overShown && this.overT >= RESTART_GUARD) {
          this.startRun();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  private blurControls(): void {
    if (this.state === 'playing' && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  // ---- loop ----------------------------------------------------------------------------

  private update(dt: number): void {
    switch (this.state) {
      case 'menu':
        this.world.attract(dt, MENU_SPEED);
        break;
      case 'ready': {
        this.countdown -= dt;
        const n = Math.ceil(this.countdown / COUNT_STEP);
        if (n !== this.countdownShown && n > 0) {
          this.countdownShown = n;
          this.ui.showCountdown(String(n));
          this.audio.play('count');
        }
        if (this.countdown <= 0) {
          this.setState('playing');
          this.ui.showCountdown('GO');
          this.goTimer = 0.45;
          this.audio.play('go');
        }
        break;
      }
      case 'playing': {
        this.world.update(dt);
        if (!this.bestToastShown && this.bestAtStart > 0 && this.world.totalScore > this.bestAtStart) {
          this.bestToastShown = true;
          this.ui.toast('New best!', 'amber', 1600);
          this.audio.play('best');
        }
        if (!this.world.alive) this.toGameOver();
        break;
      }
      case 'gameover':
        this.crashT += dt;
        if (this.overShown) this.overT += dt;
        else if (this.crashT >= GAMEOVER_DELAY) this.showGameOver();
        break;
      default:
        break;
    }
    if (this.goTimer > 0) {
      this.goTimer -= dt;
      if (this.goTimer <= 0 || this.state !== 'playing') {
        this.goTimer = 0;
        if (this.state === 'playing') this.ui.showCountdown(null);
      }
    }
  }

  private frame(dt: number): void {
    this.time += dt;
    if (this.state === 'paused' && this.renderedPaused) return;
    if (this.state === 'playing') this.monitorPerformance(dt);
    const w = this.world;
    if (this.state === 'playing' || this.state === 'ready' || this.state === 'gameover') {
      this.ui.updateHud(w.totalScore, w.distance, w.score.orbs, w.tier + 1);
    }
    // Freeze ambient animation and particles while paused.
    const visualDt = this.state === 'paused' ? 0 : dt;
    this.renderer.render({ world: w, time: this.time, dt: visualDt, crashT: this.crashT });
    if (this.state === 'paused') this.renderedPaused = true;
  }

  private monitorPerformance(dt: number): void {
    if (this.save.settings.quality !== 'auto' || this.autoLow) return;
    this.perfAcc += dt;
    this.perfFrames++;
    if (this.perfAcc < 2) return;
    const avg = this.perfAcc / this.perfFrames;
    this.perfAcc = 0;
    this.perfFrames = 0;
    this.perfSlowWindows = avg > 1 / 42 ? this.perfSlowWindows + 1 : 0;
    if (this.perfSlowWindows >= 2) {
      this.autoLow = true;
      this.renderer.setQuality('low');
    }
  }

  // ---- world events -> audio / visuals --------------------------------------------------

  private bindWorldEvents(): void {
    const r = this.renderer;
    this.world.events = {
      onAction: (result: ActionResult) => {
        switch (result) {
          case 'jump':
            this.audio.play('jump');
            break;
          case 'slide':
          case 'fastfall':
            this.audio.play('slide');
            break;
          case 'lane':
            this.audio.play('lane');
            break;
          case 'edge':
            this.audio.play('edge');
            r.shake(3);
            break;
          default:
            break;
        }
      },
      onLand: () => {
        if (!isSliding(this.world.player)) this.audio.play('land');
      },
      onOrb: (orb, streak) => {
        this.audio.play('orb', streak);
        const pos = r.orbScreen(orb, this.world);
        r.particles.burst(pos.x, pos.y, 10, '#ffc552', 220, 0.45, 4);
        r.particles.burst(pos.x, pos.y, 4, '#fff3c4', 120, 0.3, 3);
      },
      onCrash: () => {
        this.audio.play('crash');
        r.shake(16);
        r.impact();
        const pos = r.playerScreen(this.world);
        r.particles.burst(pos.x, pos.y, 28, '#ff3ad2', 9 * pos.s, 0.8, 0.12 * pos.s, 4 * pos.s, 1);
        r.particles.burst(pos.x, pos.y, 22, '#36f1ff', 7 * pos.s, 0.7, 0.1 * pos.s, 4 * pos.s, 0);
      },
      onCloseCall: () => {
        this.audio.play('closecall');
        this.ui.toast('+50 Close call', 'magenta', 1000);
      },
      onTier: (tier) => {
        this.audio.play('tier');
        this.audio.setIntensity(tier);
        this.ui.toast(`Speed level ${tier + 1}`, 'cyan', 1400);
        r.shake(4);
      },
    };
  }

  private confetti(): void {
    const r = this.renderer;
    const colors = ['#ffc552', '#36f1ff', '#ff3ad2', '#9b6bff'];
    for (let i = 0; i < colors.length; i++) {
      r.particles.burst(r.width * (0.2 + i * 0.2), r.height * 0.18, 14, colors[i], 320, 1.4, 6, 380, 0, Math.PI * 0.9, -Math.PI / 2);
    }
  }

  // ---- settings, sizing, visibility --------------------------------------------------------

  private updateSettings(patch: Partial<Settings>): void {
    this.save.updateSettings(patch);
    this.applySettings();
  }

  private applySettings(): void {
    const s = this.save.settings;
    this.audio.applySettings(s);
    this.ui.applySettings(s, this.save.available);
    const quality = s.quality === 'auto' ? (this.autoLow ? 'low' : 'high') : s.quality;
    if (quality !== this.renderer.quality && this.cssW > 0) this.renderer.setQuality(quality);
    else this.renderer.quality = quality;
    const reduced = s.reducedMotion === 'on' || (s.reducedMotion === 'system' && this.systemReducedMotion);
    this.renderer.setReducedMotion(reduced);
    this.ui.setReducedMotion(reduced);
    this.renderedPaused = false;
  }

  private observeSize(): void {
    const root = this.ui.root;
    const apply = (w: number, h: number) => {
      const dpr = window.devicePixelRatio || 1;
      if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
      this.cssW = w;
      this.cssH = h;
      this.dpr = dpr;
      this.renderer.resize(w, h, dpr);
      this.input.setSurfaceSize(w, h);
      this.renderedPaused = false;
    };
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver((entries) => {
        const rect = entries[entries.length - 1].contentRect;
        apply(Math.round(rect.width), Math.round(rect.height));
      }).observe(root);
    }
    // Also catches devicePixelRatio changes (browser zoom, moving screens).
    window.addEventListener('resize', () => apply(root.clientWidth, root.clientHeight));
    apply(root.clientWidth, root.clientHeight);
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      if (this.state === 'playing' || this.state === 'ready') this.pause();
      this.audio.setHidden(true);
    } else {
      this.audio.setHidden(false);
      this.loop.resync();
      this.renderedPaused = false;
    }
  };

  private toggleFullscreen(): void {
    const root = this.ui.root as HTMLElement & { webkitRequestFullscreen?: () => void };
    const doc = document as Document & { webkitExitFullscreen?: () => void; webkitFullscreenElement?: Element | null };
    try {
      if (document.fullscreenElement || doc.webkitFullscreenElement) {
        if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
        else doc.webkitExitFullscreen?.();
      } else if (root.requestFullscreen) {
        void root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      } else {
        root.webkitRequestFullscreen?.();
      }
    } catch {
      // Fullscreen is optional; ignore refusals.
    }
  }

  // ---- debug / automated testing ---------------------------------------------------------

  snapshot(): Snapshot {
    const w = this.world;
    return {
      state: this.state,
      seed: w.seed,
      distance: w.distance,
      score: w.totalScore,
      orbs: w.score.orbs,
      lane: w.player.lane,
      x: w.player.x,
      y: w.player.y,
      airborne: w.player.airborne,
      sliding: isSliding(w.player),
      tier: w.tier,
      speed: w.speed,
      alive: w.alive,
      gameOverCount: this.gameOverCount,
      runsStarted: this.runsStarted,
      quality: this.renderer.quality,
      reducedMotion: this.renderer.reducedMotion,
      canvas: { width: this.canvas.width, height: this.canvas.height, cssWidth: this.cssW, cssHeight: this.cssH },
      audioUnlocked: this.audio.unlocked,
      storageAvailable: this.save.available,
      activeObstacles: w.obstacles.filter((o) => o.active).length,
    };
  }

  private exposeDebug(): void {
    const api = {
      snapshot: () => this.snapshot(),
      setInvulnerable: (on: boolean) => {
        this.world.invulnerable = on;
      },
      /** Advance the running simulation synchronously (fixed steps). */
      fastForward: (seconds: number) => {
        if (this.state !== 'playing') return;
        const steps = Math.min(120 * 600, Math.round(seconds * 120));
        for (let i = 0; i < steps && this.world.alive; i++) this.world.update(1 / 120);
      },
    };
    (window as unknown as { __NEON_RUSH__: typeof api }).__NEON_RUSH__ = api;
  }
}
