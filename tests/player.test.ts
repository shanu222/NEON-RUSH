import { describe, expect, it } from 'vitest';
import { FIXED_DT, OBSTACLE, PLAYER } from '../src/core/config';
import { applyAction, createPlayer, isSliding, playerTop, stepPlayer } from '../src/game/player';

function run(p: ReturnType<typeof createPlayer>, seconds: number) {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) stepPlayer(p, FIXED_DT);
}

describe('lanes', () => {
  it('starts in the centre lane and cannot leave the three lanes', () => {
    const p = createPlayer();
    expect(p.lane).toBe(1);
    expect(applyAction(p, 'left')).toBe('lane');
    expect(applyAction(p, 'left')).toBe('edge');
    expect(p.lane).toBe(0);
    run(p, 1);
    expect(p.x).toBe(0);
    applyAction(p, 'right');
    applyAction(p, 'right');
    expect(applyAction(p, 'right')).toBe('edge');
    run(p, 1);
    expect(p.lane).toBe(2);
    expect(p.x).toBe(2);
  });

  it('completes one lane change in the configured time', () => {
    const p = createPlayer();
    applyAction(p, 'right');
    run(p, PLAYER.laneChangeTime - 0.02);
    expect(p.x).toBeLessThan(2);
    run(p, 0.03);
    expect(p.x).toBe(2);
  });
});

describe('jump', () => {
  it('lasts about jumpDuration and reaches jumpHeight', () => {
    const p = createPlayer();
    applyAction(p, 'jump');
    let maxY = 0;
    let t = 0;
    while (p.airborne && t < 2) {
      stepPlayer(p, FIXED_DT);
      t += FIXED_DT;
      maxY = Math.max(maxY, p.y);
    }
    expect(t).toBeGreaterThan(PLAYER.jumpDuration - 0.03);
    expect(t).toBeLessThan(PLAYER.jumpDuration + 0.03);
    expect(maxY).toBeGreaterThan(PLAYER.jumpHeight - 0.05);
    expect(maxY).toBeLessThan(PLAYER.jumpHeight + 0.05);
    // Can clear a ground barrier but never a wall.
    expect(maxY).toBeGreaterThan(OBSTACLE.lowHeight);
    expect(maxY).toBeLessThan(OBSTACLE.wallHeight);
  });

  it('cannot double jump, but a press just before landing is buffered', () => {
    const p = createPlayer();
    applyAction(p, 'jump');
    run(p, 0.2);
    expect(applyAction(p, 'jump')).toBe('buffered');
    run(p, 0.2);
    expect(p.jumpBuffered).toBe(0);
    // Buffered press close to landing triggers a new jump on touchdown.
    run(p, PLAYER.jumpDuration - 0.4 - 0.08);
    expect(p.airborne).toBe(true);
    applyAction(p, 'jump');
    run(p, 0.12);
    expect(p.airborne).toBe(true);
    expect(p.vy).toBeGreaterThan(0);
  });
});

describe('slide', () => {
  it('lasts slideDuration and fits under a gate', () => {
    const p = createPlayer();
    expect(applyAction(p, 'slide')).toBe('slide');
    expect(isSliding(p)).toBe(true);
    expect(playerTop(p)).toBeLessThan(OBSTACLE.gateBottom);
    run(p, PLAYER.slideDuration - 0.02);
    expect(isSliding(p)).toBe(true);
    run(p, 0.03);
    expect(isSliding(p)).toBe(false);
    expect(playerTop(p)).toBeGreaterThan(OBSTACLE.gateBottom);
  });

  it('slide in the air fast-falls then slides on landing', () => {
    const p = createPlayer();
    applyAction(p, 'jump');
    run(p, 0.25);
    expect(applyAction(p, 'slide')).toBe('fastfall');
    run(p, 0.15);
    expect(p.airborne).toBe(false);
    expect(isSliding(p)).toBe(true);
  });

  it('jumping cancels a slide (no being low and high at once)', () => {
    const p = createPlayer();
    applyAction(p, 'slide');
    run(p, 0.1);
    applyAction(p, 'jump');
    expect(isSliding(p)).toBe(false);
    expect(p.airborne).toBe(true);
  });
});
