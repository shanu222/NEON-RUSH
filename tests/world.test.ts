import { describe, expect, it } from 'vitest';
import { FIXED_DT, POOL_SIZE } from '../src/core/config';
import { SPEED_MAX, SPEED_START, speedAt, tierAt } from '../src/game/difficulty';
import { addCloseCall, addDistance, addOrb, createScore, totalScore } from '../src/game/scoring';
import { World } from '../src/game/world';

describe('difficulty', () => {
  it('speed rises smoothly and is capped', () => {
    expect(speedAt(0)).toBe(SPEED_START);
    let prev = speedAt(0);
    for (let d = 10; d < 30000; d += 10) {
      const s = speedAt(d);
      expect(s).toBeGreaterThanOrEqual(prev);
      // No sudden spikes: < 0.1 m/s change per 10 m travelled.
      expect(s - prev).toBeLessThan(0.1);
      expect(s).toBeLessThanOrEqual(SPEED_MAX);
      prev = s;
    }
  });

  it('tiers increase one at a time', () => {
    let prev = 0;
    for (let d = 0; d < 20000; d += 5) {
      const t = tierAt(d);
      expect(t - prev === 0 || t - prev === 1).toBe(true);
      prev = t;
    }
  });
});

describe('scoring', () => {
  it('follows the documented formula', () => {
    const s = createScore();
    addDistance(s, 100, 0); // 100 * 1.0
    addDistance(s, 100, 2); // 100 * 1.5
    addOrb(s);
    addOrb(s); // 2 * 10
    addCloseCall(s); // 50
    expect(totalScore(s)).toBe(100 + 150 + 20 + 50);
  });
});

describe('world', () => {
  it('collects orbs and updates score while running', () => {
    // Find a seed where standing still in the centre collects at least one orb.
    let collected = 0;
    for (let seed = 1; seed < 40 && collected === 0; seed++) {
      const w = new World(seed);
      while (w.alive && w.distance < 600) w.update(FIXED_DT);
      collected = w.score.orbs;
      if (collected > 0) {
        expect(w.totalScore).toBeGreaterThanOrEqual(Math.floor(w.score.distancePoints) + collected * 10);
      }
    }
    expect(collected).toBeGreaterThan(0);
  });

  it('crashes exactly once and stops advancing', () => {
    const w = new World(3);
    let crashes = 0;
    w.events.onCrash = () => crashes++;
    for (let i = 0; i < 120 * 120 && w.alive; i++) w.update(FIXED_DT);
    expect(w.alive).toBe(false);
    const d = w.distance;
    const score = w.totalScore;
    for (let i = 0; i < 500; i++) w.update(FIXED_DT);
    expect(crashes).toBe(1);
    expect(w.distance).toBe(d);
    expect(w.totalScore).toBe(score);
    expect(w.act('jump')).toBeNull();
  });

  it('reset produces a clean, identical round for the same seed', () => {
    const w = new World(77);
    for (let i = 0; i < 2000 && w.alive; i++) w.update(FIXED_DT);
    w.act('left');
    w.reset(77);
    expect(w.distance).toBe(0);
    expect(w.totalScore).toBe(0);
    expect(w.score.orbs).toBe(0);
    expect(w.player.lane).toBe(1);
    expect(w.alive).toBe(true);
    const fresh = new World(77);
    const pick = (x: World) => x.obstacles.filter((o) => o.active).map((o) => [o.kind, o.lane, o.z]);
    expect(pick(w)).toEqual(pick(fresh));
  });

  it('object pools never overflow over a very long run', () => {
    const w = new World(9);
    w.invulnerable = true;
    let maxActive = 0;
    while (w.distance < 15000) {
      w.update(FIXED_DT);
      const active = w.obstacles.filter((o) => o.active).length;
      if (active > maxActive) maxActive = active;
    }
    expect(w.poolOverflow).toBe(false);
    expect(maxActive).toBeLessThan(POOL_SIZE.obstacles);
  });
});
