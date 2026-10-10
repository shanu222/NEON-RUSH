import { describe, expect, it } from 'vitest';
import { SAVE_KEY, SaveStore, defaultSave, sanitize, type StorageLike } from '../src/storage/save';

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

class ThrowingStorage implements StorageLike {
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
  removeItem(): void {
    throw new Error('SecurityError');
  }
}

describe('save data', () => {
  it('round-trips records and settings across instances (refresh)', () => {
    const storage = new MemoryStorage();
    const a = new SaveStore(storage);
    expect(a.recordRun(1234.7, 456.2, 12)).toEqual({ score: true, distance: true });
    a.updateSettings({ sound: false, musicVolume: 0.25 });
    const b = new SaveStore(storage);
    expect(b.records.bestScore).toBe(1234);
    expect(b.records.bestDistance).toBe(456);
    expect(b.records.runs).toBe(1);
    expect(b.settings.sound).toBe(false);
    expect(b.settings.musicVolume).toBe(0.25);
    expect(b.recordRun(100, 50, 1)).toEqual({ score: false, distance: false });
    expect(new SaveStore(storage).records.bestScore).toBe(1234);
  });

  it('survives malformed JSON and invalid values', () => {
    const storage = new MemoryStorage();
    storage.setItem(SAVE_KEY, '{not json');
    expect(new SaveStore(storage).data).toEqual(defaultSave());
    const bad = sanitize({
      version: 1,
      records: { bestScore: -5, bestDistance: 'x', runs: NaN, totalOrbs: Infinity },
      settings: { sound: 'yes', musicVolume: 7, sfxVolume: -1, quality: 'ultra', reducedMotion: 'on' },
    });
    expect(bad.records.bestScore).toBe(0);
    expect(bad.records.bestDistance).toBe(0);
    expect(bad.records.runs).toBe(0);
    expect(bad.records.totalOrbs).toBe(0);
    expect(bad.settings.sound).toBe(true);
    expect(bad.settings.musicVolume).toBe(1);
    expect(bad.settings.sfxVolume).toBe(0);
    expect(bad.settings.quality).toBe('auto');
    expect(bad.settings.reducedMotion).toBe('on');
    expect(sanitize(null)).toEqual(defaultSave());
    expect(sanitize([1, 2])).toEqual(defaultSave());
  });

  it('migrates the legacy unversioned format', () => {
    const out = sanitize({ best: 900, sound: false });
    expect(out.version).toBe(1);
    expect(out.records.bestScore).toBe(900);
    expect(out.settings.sound).toBe(false);
  });

  it('keeps working when storage throws or is missing', () => {
    const s = new SaveStore(new ThrowingStorage());
    expect(s.data).toEqual(defaultSave());
    expect(() => s.recordRun(10, 10, 1)).not.toThrow();
    expect(s.records.bestScore).toBe(10);
    const none = new SaveStore(null);
    expect(none.available).toBe(false);
    expect(none.save()).toBe(false);
    none.updateSettings({ sound: false });
    expect(none.settings.sound).toBe(false);
  });
});
