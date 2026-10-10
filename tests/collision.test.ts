import { describe, expect, it } from 'vitest';
import { FIXED_DT, PLAYER } from '../src/core/config';
import { hitsObstacle, touchesOrb, createOrb } from '../src/game/entities';
import { applyAction, createPlayer, stepPlayer } from '../src/game/player';

describe('collision', () => {
  it('ground barrier hits a running player and misses a jumping one', () => {
    const p = createPlayer();
    expect(hitsObstacle(p, 'low', 1, 0, 0.5)).toBe(true);
    applyAction(p, 'jump');
    for (let i = 0; i < 30; i++) stepPlayer(p, FIXED_DT);
    expect(hitsObstacle(p, 'low', 1, 0, 0.5)).toBe(false);
  });

  it('sliding does not get under a ground barrier', () => {
    const p = createPlayer();
    applyAction(p, 'slide');
    expect(hitsObstacle(p, 'low', 1, 0, 0.5)).toBe(true);
  });

  it('gate hits standing and jumping players, not sliding ones', () => {
    const p = createPlayer();
    expect(hitsObstacle(p, 'gate', 1, 0, 0.5)).toBe(true);
    applyAction(p, 'slide');
    expect(hitsObstacle(p, 'gate', 1, 0, 0.5)).toBe(false);
    const j = createPlayer();
    applyAction(j, 'jump');
    for (let i = 0; i < 40; i++) {
      stepPlayer(j, FIXED_DT);
      expect(hitsObstacle(j, 'gate', 1, 0, 0.5)).toBe(true);
    }
  });

  it('blocks and walls cannot be jumped or slid past', () => {
    for (const kind of ['block', 'wall'] as const) {
      const p = createPlayer();
      applyAction(p, 'jump');
      for (let i = 0; i < 80; i++) {
        stepPlayer(p, FIXED_DT);
        expect(hitsObstacle(p, kind, 1, 0, 5)).toBe(true);
      }
      const s = createPlayer();
      applyAction(s, 'slide');
      expect(hitsObstacle(s, kind, 1, 0, 5)).toBe(true);
    }
  });

  it('adjacent lanes never collide; mid-transition does', () => {
    const p = createPlayer();
    expect(hitsObstacle(p, 'block', 0, 0, 1.6)).toBe(false);
    expect(hitsObstacle(p, 'block', 2, 0, 1.6)).toBe(false);
    applyAction(p, 'left');
    stepPlayer(p, PLAYER.laneChangeTime * 0.5);
    expect(hitsObstacle(p, 'block', 0, 0, 1.6)).toBe(true);
  });

  it('respects z extents', () => {
    const p = createPlayer();
    expect(hitsObstacle(p, 'block', 1, PLAYER.halfDepth + 0.01, 1.6)).toBe(false);
    expect(hitsObstacle(p, 'block', 1, -1.6 - PLAYER.halfDepth - 0.01, 1.6)).toBe(false);
    expect(hitsObstacle(p, 'block', 1, -1, 1.6)).toBe(true);
  });

  it('orb pickup uses lane and height', () => {
    const p = createPlayer();
    const orb = createOrb();
    orb.x = 1;
    orb.y = 0.9;
    expect(touchesOrb(p, orb, 0)).toBe(true);
    orb.x = 2;
    expect(touchesOrb(p, orb, 0)).toBe(false);
    orb.x = 1;
    orb.y = 2.6;
    expect(touchesOrb(p, orb, 0)).toBe(false);
  });
});
