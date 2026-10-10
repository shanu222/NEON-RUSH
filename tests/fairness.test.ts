import { describe, expect, it } from 'vitest';
import { FIXED_DT, TRACK } from '../src/core/config';
import { MIN_ROW_GAP_TIME, speedAt } from '../src/game/difficulty';
import { hitsObstacle, type ObstacleKind } from '../src/game/entities';
import { TrackGenerator, type RowRecord } from '../src/game/generator';
import { applyAction, copyPlayer, createPlayer, stepPlayer, type Action, type PlayerState } from '../src/game/player';

interface Ob {
  kind: ObstacleKind;
  lane: number;
  z: number;
  depth: number;
}

function generate(seed: number, until: number) {
  const gen = new TrackGenerator(seed);
  const obstacles: Ob[] = [];
  const rows: RowRecord[] = [];
  gen.onRow = (r) => rows.push(r);
  gen.fill(until + TRACK.spawnAhead, {
    spawnObstacle: (kind, lane, z, depth) => obstacles.push({ kind, lane, z, depth }),
    spawnOrb: () => {},
  });
  obstacles.sort((a, b) => a.z - b.z);
  return { obstacles, rows };
}

/**
 * Exhaustive search over player inputs using the REAL player physics and
 * collision code. The player may press one of {nothing, left, right, jump,
 * slide} at 30 Hz (a human-achievable rate, coarser than the 120 Hz sim).
 * Near-identical states are merged into coarse buckets; every kept state is
 * still reached by a real input sequence, so a "survived" result is sound
 * (pruning can only make the search more pessimistic, never optimistic).
 * Returns the furthest distance any input sequence survives to.
 */
function solve(seed: number, goal: number): number {
  return solveCourse(generate(seed, goal).obstacles, goal);
}

function solveCourse(obstacles: Ob[], goal: number): number {
  const ACTIONS: (Action | null)[] = [null, 'left', 'right', 'jump', 'slide'];
  const STEPS_PER_DECISION = 4;
  const MAX_STATES = 800;

  let states: PlayerState[] = [createPlayer()];
  let distance = 0;
  let first = 0;
  const scratch = createPlayer();

  const collides = (p: PlayerState, d: number) => {
    for (let i = first; i < obstacles.length; i++) {
      const o = obstacles[i];
      const rel = o.z - d;
      if (rel > 1) break;
      if (hitsObstacle(p, o.kind, o.lane, rel, o.depth)) return true;
    }
    return false;
  };

  while (distance < goal) {
    const seen = new Set<number>();
    const next: PlayerState[] = [];
    // Advance the shared distance for this decision window.
    const ds: number[] = [];
    let d = distance;
    for (let s = 0; s < STEPS_PER_DECISION; s++) {
      d += speedAt(d) * FIXED_DT;
      ds.push(d);
    }
    while (first < obstacles.length && obstacles[first].z + obstacles[first].depth < distance - 30) first++;

    for (const st of states) {
      for (const action of ACTIONS) {
        const p = copyPlayer(st, scratch);
        if (action) {
          if (action === 'jump' && p.airborne) continue;
          if (action === 'slide' && p.slideTime > 0.3) continue;
          const r = applyAction(p, action);
          if (r === 'edge') continue;
        }
        let dead = false;
        for (let s = 0; s < STEPS_PER_DECISION && !dead; s++) {
          stepPlayer(p, FIXED_DT);
          dead = collides(p, ds[s]);
        }
        if (dead) continue;
        const key =
          p.lane * 1e7 +
          Math.round(p.x * 4) * 1e6 +
          (p.airborne ? Math.round(p.y * 5) + 1 : 0) * 1e4 +
          (p.vy > 0 ? 1 : 0) * 1e3 +
          Math.round(p.slideTime * 10) * 10 +
          (p.slideQueued ? 1 : 0);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(copyPlayer(p, createPlayer()));
        if (next.length >= MAX_STATES) break;
      }
      if (next.length >= MAX_STATES) break;
    }
    distance = ds[ds.length - 1];
    if (next.length === 0) return distance;
    states = next;
  }
  return distance;
}

describe('track generator', () => {
  it('is deterministic for a seed', () => {
    const a = generate(1234, 3000);
    const b = generate(1234, 3000);
    expect(a.obstacles).toEqual(b.obstacles);
    const c = generate(1235, 3000);
    expect(c.obstacles).not.toEqual(a.obstacles);
  });

  it('keeps a forgiving empty intro', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { obstacles } = generate(seed, 500);
      expect(obstacles[0].z).toBeGreaterThanOrEqual(TRACK.introDistance);
    }
  });

  it('every row leaves a survivable lane and respects minimum spacing', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { rows } = generate(seed, 9000);
      for (let i = 0; i < rows.length; i++) {
        expect(rows[i].passable).not.toBe(0);
        if (i > 0) {
          const gap = rows[i].z - rows[i - 1].z;
          expect(gap).toBeGreaterThanOrEqual(MIN_ROW_GAP_TIME * speedAt(rows[i - 1].z) - 1e-6);
        }
      }
    }
  });

  it('introduces obstacle variety gradually', () => {
    const kindsBefore400 = new Set<string>();
    const multiBefore400: number[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const { rows } = generate(seed, 6000);
      for (const r of rows) {
        const count = r.cells.filter(Boolean).length;
        if (r.z < 400) {
          multiBefore400.push(count);
          r.cells.forEach((c) => c && kindsBefore400.add(c));
        }
      }
    }
    // Opening section: single obstacles only, no long walls.
    expect(Math.max(...multiBefore400)).toBeLessThanOrEqual(1);
    expect(kindsBefore400.has('wall')).toBe(false);
  });
});

describe('solver sanity (negative controls)', () => {
  const ob = (kind: ObstacleKind, lane: number, z: number, depth = kind === 'wall' ? 15 : kind === 'block' ? 1.6 : 0.5) => ({
    kind,
    lane,
    z,
    depth,
  });

  it('rejects a row blocked in all three lanes', () => {
    const course = [ob('block', 0, 120), ob('block', 1, 120), ob('block', 2, 120)];
    expect(solveCourse(course, 300)).toBeLessThan(125);
  });

  it('rejects a gate immediately followed by a barrier with no time to recover', () => {
    const course = [0, 1, 2].flatMap((l) => [ob('gate', l, 120), ob('low', l, 120.6)]);
    expect(solveCourse(course, 300)).toBeLessThan(125);
  });

  it('rejects a two-lane dodge with too little warning behind a wall', () => {
    const course = [ob('wall', 1, 100, 30), ob('wall', 2, 100, 30), ob('block', 0, 131), ob('block', 1, 131)];
    expect(solveCourse(course, 300)).toBeLessThan(135);
  });

  it('accepts the same patterns when spacing is fair', () => {
    const course = [
      ob('block', 0, 120),
      ob('block', 1, 120),
      ...[0, 1, 2].flatMap((l) => [ob('gate', l, 150), ob('low', l, 170)]),
    ];
    expect(solveCourse(course, 300)).toBeGreaterThanOrEqual(300);
  });
});

describe('no impossible patterns (exhaustive input search)', () => {
  const seeds = [1, 2, 3, 7, 42, 99, 1234, 2026];
  for (const seed of seeds) {
    it(`seed ${seed} is survivable for 2500 m`, () => {
      expect(solve(seed, 2500)).toBeGreaterThanOrEqual(2500);
    }, 60_000);
  }

  it('high-speed sections (seed 5) are survivable to 5000 m', () => {
    expect(solve(5, 5000)).toBeGreaterThanOrEqual(5000);
  }, 120_000);

  it('top speed tiers (seed 11) are survivable to 9500 m', () => {
    expect(solve(11, 9500)).toBeGreaterThanOrEqual(9500);
  }, 180_000);
});
