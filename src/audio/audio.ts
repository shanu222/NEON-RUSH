/**
 * Original, fully synthesized audio (Web Audio API). No audio files and no
 * network requests. The AudioContext is only created after a user gesture,
 * and every public method is a safe no-op when audio is unsupported,
 * blocked, or disabled, so gameplay never depends on it.
 */

export type Sfx =
  | 'orb'
  | 'jump'
  | 'slide'
  | 'land'
  | 'lane'
  | 'edge'
  | 'crash'
  | 'click'
  | 'tier'
  | 'best'
  | 'closecall'
  | 'count'
  | 'go';

export type MusicMode = 'menu' | 'game';

interface AudioSettings {
  sound: boolean;
  musicVolume: number;
  sfxVolume: number;
}

type AudioContextCtor = typeof AudioContext;

const BPM = 112;
const STEP = 60 / BPM / 4; // sixteenth note
const LOOKAHEAD = 0.12;
const SCHEDULE_MS = 25;

// Am - F - C - G, one chord per bar (16 steps).
const CHORDS = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];
const BASS_ROOTS = [33, 29, 36, 31];
const ARP_ORDER = [0, 1, 2, 1, 0, 2, 1, 2];

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class AudioEngine {
  readonly supported: boolean;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  private settings: AudioSettings = { sound: true, musicVolume: 0.6, sfxVolume: 0.8 };
  private musicMode: MusicMode | null = null;
  private intensity = 0;
  private hidden = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextNoteTime = 0;
  private step = 0;

  constructor() {
    this.supported = this.contextCtor() !== null;
  }

  private contextCtor(): AudioContextCtor | null {
    const w = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    return w.AudioContext ?? w.webkitAudioContext ?? null;
  }

  /** Call from a user gesture (click/key/touch). Safe to call repeatedly. */
  unlock(): void {
    if (!this.supported || this.hidden) return;
    try {
      if (!this.ctx) this.createGraph();
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
      this.syncMusic();
    } catch {
      this.ctx = null;
    }
  }

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  private createGraph(): void {
    const Ctor = this.contextCtor();
    if (!Ctor) return;
    const ctx = new Ctor();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.connect(comp);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);

    const len = Math.floor(ctx.sampleRate * 1.0);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.applyVolumes(true);
  }

  applySettings(s: AudioSettings): void {
    this.settings = { sound: s.sound, musicVolume: s.musicVolume, sfxVolume: s.sfxVolume };
    this.applyVolumes(false);
    this.syncMusic();
  }

  private applyVolumes(immediate: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.sfxBus) return;
    const t = ctx.currentTime;
    const ramp = (param: AudioParam, value: number) => {
      param.cancelScheduledValues(t);
      if (immediate) param.setValueAtTime(value, t);
      else {
        param.setValueAtTime(param.value, t);
        param.linearRampToValueAtTime(value, t + 0.08);
      }
    };
    ramp(this.master.gain, this.settings.sound ? 1 : 0);
    ramp(this.sfxBus.gain, this.settings.sfxVolume * 0.75);
    if (this.musicBus && this.timer) ramp(this.musicBus.gain, this.musicLevel());
  }

  private musicLevel(): number {
    return this.settings.musicVolume * (this.musicMode === 'menu' ? 0.32 : 0.42);
  }

  /** Select the background track, or null to stop music (e.g. paused). */
  setMusic(mode: MusicMode | null): void {
    this.musicMode = mode;
    this.syncMusic();
  }

  setIntensity(level: number): void {
    this.intensity = level;
  }

  /** Document visibility: suspend everything while hidden. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (!this.ctx) return;
    if (hidden) {
      this.stopScheduler(true);
      void this.ctx.suspend().catch(() => {});
    } else {
      void this.ctx.resume().catch(() => {});
      this.syncMusic();
    }
  }

  private syncMusic(): void {
    const want = this.ctx !== null && this.musicMode !== null && this.settings.sound && this.settings.musicVolume > 0 && !this.hidden;
    if (want) this.startScheduler();
    else this.stopScheduler(false);
    if (want && this.musicBus && this.ctx) {
      const t = this.ctx.currentTime;
      this.musicBus.gain.cancelScheduledValues(t);
      this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, t);
      this.musicBus.gain.linearRampToValueAtTime(this.musicLevel(), t + 0.4);
    }
  }

  private startScheduler(): void {
    if (this.timer || !this.ctx) return;
    this.nextNoteTime = this.ctx.currentTime + 0.06;
    this.step = 0;
    this.timer = setInterval(() => this.schedule(), SCHEDULE_MS);
  }

  private stopScheduler(immediate: boolean): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.ctx && this.musicBus) {
      const t = this.ctx.currentTime;
      this.musicBus.gain.cancelScheduledValues(t);
      this.musicBus.gain.setValueAtTime(immediate ? 0 : this.musicBus.gain.value, t);
      this.musicBus.gain.linearRampToValueAtTime(0, t + (immediate ? 0.01 : 0.2));
    }
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    // If the tab stalled, skip ahead instead of firing a burst of notes.
    if (this.nextNoteTime < ctx.currentTime - 0.2) this.nextNoteTime = ctx.currentTime + 0.02;
    while (this.nextNoteTime < ctx.currentTime + LOOKAHEAD) {
      this.scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += STEP;
      this.step = (this.step + 1) % 64;
    }
  }

  private scheduleStep(step: number, t: number): void {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const chord = CHORDS[bar];
    const game = this.musicMode === 'game';

    if (s === 0) {
      for (const n of chord) this.tone(midi(n - 12), t, STEP * 16, 'sawtooth', 0.035, 900, 0.4, 0.6, this.musicBus);
    }
    if (s % 2 === 0) {
      const root = BASS_ROOTS[bar] + (s % 8 === 6 ? 12 : 0);
      this.tone(midi(root), t, STEP * 1.6, 'triangle', game ? 0.2 : 0.13, 500, 0.005, 0.12, this.musicBus);
    }
    if (game || s % 4 === 0) {
      const note = chord[ARP_ORDER[s % 8]] + 12 + (s >= 8 && game ? 12 : 0);
      this.tone(midi(note), t, STEP * 0.9, 'square', game ? 0.035 : 0.025, 2400, 0.004, 0.08, this.musicBus);
    }
    if (!game) return;
    if (s % 4 === 0) this.kick(t);
    if (s === 4 || s === 12) this.noiseHit(t, 0.12, 1800, 'bandpass', 0.16, this.musicBus);
    const hats = this.intensity >= 2 ? true : s % 2 === 1;
    if (hats) this.noiseHit(t, 0.03, 8000, 'highpass', s % 4 === 2 ? 0.06 : 0.035, this.musicBus);
  }

  // ---- synthesis primitives -------------------------------------------------

  private tone(
    freq: number,
    t: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    cutoff: number,
    attack: number,
    release: number,
    bus: GainNode | null,
    endFreq?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !bus) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, t + Math.max(attack, dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
    osc.connect(filter).connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + release + 0.05);
  }

  private noiseHit(t: number, dur: number, freq: number, type: BiquadFilterType, gain: number, bus: GainNode | null, endFreq?: number): void {
    const ctx = this.ctx;
    if (!ctx || !bus || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    if (endFreq) filter.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(bus);
    src.start(t, Math.random() * 0.25);
    src.stop(t + dur + 0.02);
  }

  private kick(t: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(g).connect(this.musicBus);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  play(sfx: Sfx, param = 0): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.settings.sound || this.settings.sfxVolume <= 0 || this.hidden) return;
    const bus = this.sfxBus;
    const t = ctx.currentTime + 0.005;
    try {
      switch (sfx) {
        case 'orb': {
          const f = 880 * Math.pow(2, Math.min(param, 12) / 24);
          this.tone(f, t, 0.06, 'sine', 0.16, 6000, 0.003, 0.09, bus, f * 1.5);
          this.tone(f * 2, t + 0.02, 0.04, 'triangle', 0.05, 6000, 0.003, 0.06, bus);
          break;
        }
        case 'jump':
          this.tone(240, t, 0.13, 'square', 0.07, 1800, 0.005, 0.06, bus, 560);
          break;
        case 'slide':
          this.noiseHit(t, 0.28, 2400, 'bandpass', 0.18, bus, 500);
          break;
        case 'land':
          this.tone(130, t, 0.05, 'sine', 0.12, 800, 0.002, 0.05, bus, 60);
          break;
        case 'lane':
          this.noiseHit(t, 0.07, 3500, 'bandpass', 0.06, bus, 1500);
          break;
        case 'edge':
          this.tone(110, t, 0.06, 'square', 0.05, 600, 0.002, 0.04, bus);
          break;
        case 'crash':
          this.noiseHit(t, 0.7, 1600, 'lowpass', 0.45, bus, 120);
          this.tone(170, t, 0.5, 'sawtooth', 0.16, 1200, 0.004, 0.25, bus, 38);
          break;
        case 'click':
          this.tone(1250, t, 0.025, 'sine', 0.08, 8000, 0.002, 0.03, bus);
          break;
        case 'tier':
          [69, 72, 76, 81].forEach((n, i) => this.tone(midi(n + 12), t + i * 0.07, 0.08, 'triangle', 0.1, 6000, 0.004, 0.1, bus));
          break;
        case 'best':
          [72, 76, 79, 84, 88].forEach((n, i) => this.tone(midi(n), t + i * 0.09, 0.12, 'triangle', 0.12, 6000, 0.004, 0.16, bus));
          break;
        case 'closecall':
          this.noiseHit(t, 0.18, 1200, 'highpass', 0.1, bus, 6000);
          this.tone(1560, t + 0.04, 0.05, 'sine', 0.07, 8000, 0.003, 0.1, bus);
          break;
        case 'count':
          this.tone(660, t, 0.08, 'sine', 0.12, 5000, 0.004, 0.08, bus);
          break;
        case 'go':
          this.tone(990, t, 0.16, 'sine', 0.14, 5000, 0.004, 0.14, bus);
          break;
      }
    } catch {
      // Audio must never interrupt gameplay.
    }
  }
}
