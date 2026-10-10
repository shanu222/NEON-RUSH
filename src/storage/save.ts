/**
 * Versioned local save. No personal data: only records and preferences.
 * Every field is validated on load so a corrupted or hand-edited save can
 * never break the game; missing or inaccessible storage falls back to an
 * in-memory copy for the session.
 */

export const SAVE_KEY = 'neon-rush:save';
export const SAVE_VERSION = 1;

export type ReducedMotionPref = 'system' | 'on' | 'off';
export type QualityPref = 'auto' | 'high' | 'low';

export interface Settings {
  sound: boolean;
  musicVolume: number;
  sfxVolume: number;
  reducedMotion: ReducedMotionPref;
  touchButtons: boolean;
  quality: QualityPref;
}

export interface Records {
  bestScore: number;
  bestDistance: number;
  bestOrbs: number;
  runs: number;
  totalOrbs: number;
  totalDistance: number;
}

export interface SaveData {
  version: typeof SAVE_VERSION;
  records: Records;
  settings: Settings;
}

export function defaultSettings(): Settings {
  return { sound: true, musicVolume: 0.6, sfxVolume: 0.8, reducedMotion: 'system', touchButtons: false, quality: 'auto' };
}

export function defaultRecords(): Records {
  return { bestScore: 0, bestDistance: 0, bestOrbs: 0, runs: 0, totalOrbs: 0, totalDistance: 0 };
}

export function defaultSave(): SaveData {
  return { version: SAVE_VERSION, records: defaultRecords(), settings: defaultSettings() };
}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

function count(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e12) : fallback;
}

function unit(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Upgrade older save shapes to the current version. */
export function migrate(raw: unknown): Dict | null {
  if (!isDict(raw)) return null;
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version > SAVE_VERSION) return raw; // newer build wrote it: read what we understand
  if (version === 0) {
    // Pre-release shape: { best, sound }
    return {
      version: 1,
      records: { bestScore: raw.best },
      settings: { sound: raw.sound },
    };
  }
  return raw;
}

export function sanitize(raw: unknown): SaveData {
  const data = migrate(raw);
  const out = defaultSave();
  if (!data) return out;
  const r = isDict(data.records) ? data.records : {};
  const s = isDict(data.settings) ? data.settings : {};
  const d = out.records;
  out.records = {
    bestScore: count(r.bestScore, d.bestScore),
    bestDistance: count(r.bestDistance, d.bestDistance),
    bestOrbs: count(r.bestOrbs, d.bestOrbs),
    runs: count(r.runs, d.runs),
    totalOrbs: count(r.totalOrbs, d.totalOrbs),
    totalDistance: count(r.totalDistance, d.totalDistance),
  };
  const ds = out.settings;
  out.settings = {
    sound: typeof s.sound === 'boolean' ? s.sound : ds.sound,
    musicVolume: unit(s.musicVolume, ds.musicVolume),
    sfxVolume: unit(s.sfxVolume, ds.sfxVolume),
    reducedMotion: oneOf(s.reducedMotion, ['system', 'on', 'off'] as const, ds.reducedMotion),
    touchButtons: typeof s.touchButtons === 'boolean' ? s.touchButtons : ds.touchButtons,
    quality: oneOf(s.quality, ['auto', 'high', 'low'] as const, ds.quality),
  };
  return out;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function probeStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__neon_rush_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export class SaveStore {
  readonly available: boolean;
  data: SaveData;
  private readonly storage: StorageLike | null;

  constructor(storage: StorageLike | null = probeStorage()) {
    this.storage = storage;
    this.available = storage !== null;
    this.data = this.load();
  }

  private load(): SaveData {
    if (!this.storage) return defaultSave();
    try {
      const text = this.storage.getItem(SAVE_KEY);
      return text ? sanitize(JSON.parse(text)) : defaultSave();
    } catch {
      return defaultSave();
    }
  }

  /** Persist; returns false when storage is unavailable or full. */
  save(): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(SAVE_KEY, JSON.stringify(this.data));
      return true;
    } catch {
      return false;
    }
  }

  get settings(): Settings {
    return this.data.settings;
  }

  get records(): Records {
    return this.data.records;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = sanitize({ ...this.data, settings: { ...this.data.settings, ...patch } }).settings;
    this.save();
  }

  resetRecords(): void {
    this.data.records = defaultRecords();
    this.save();
  }

  /** Records a finished run; returns which personal bests were beaten. */
  recordRun(score: number, distance: number, orbs: number): { score: boolean; distance: boolean } {
    const r = this.data.records;
    const result = { score: score > r.bestScore, distance: distance > r.bestDistance };
    r.bestScore = Math.max(r.bestScore, Math.floor(score));
    r.bestDistance = Math.max(r.bestDistance, Math.floor(distance));
    r.bestOrbs = Math.max(r.bestOrbs, orbs);
    r.runs += 1;
    r.totalOrbs += orbs;
    r.totalDistance += Math.floor(distance);
    this.save();
    return result;
  }
}
