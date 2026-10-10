import { GRAVITY, LANE_COUNT, OBSTACLE, ORB, PLAYER, TRACK } from '../core/config';
import { Rng } from '../core/rng';
import { MAX_PATTERN_TIER, rowGapTime, speedAt, tierAt } from './difficulty';
import { isLaneBlocker, obstacleDepth, type ObstacleKind } from './entities';

type Cell = ObstacleKind | null;

interface PatternDef {
  cells: readonly [Cell, Cell, Cell];
  minTier: number;
  weight: number;
}

/**
 * Row templates. Lanes are shuffled per use, and every candidate row is
 * validated by `isRowFair` before it is accepted, so a template can never
 * produce an impossible situation even when combined with walls from
 * earlier rows.
 */
const PATTERNS: readonly PatternDef[] = [
  { cells: ['low', null, null], minTier: 0, weight: 3 },
  { cells: ['gate', null, null], minTier: 0, weight: 3 },
  { cells: ['block', null, null], minTier: 0, weight: 3 },

  { cells: ['block', 'block', null], minTier: 1, weight: 3 },
  { cells: ['low', 'low', null], minTier: 1, weight: 2 },
  { cells: ['gate', 'block', null], minTier: 1, weight: 2 },
  { cells: ['low', 'block', null], minTier: 1, weight: 2 },
  { cells: ['low', null, 'gate'], minTier: 1, weight: 2 },
  { cells: ['block', null, 'block'], minTier: 1, weight: 2 },

  { cells: ['low', 'low', 'low'], minTier: 2, weight: 2 },
  { cells: ['gate', 'gate', 'gate'], minTier: 2, weight: 2 },
  { cells: ['wall', null, null], minTier: 2, weight: 2.5 },
  { cells: ['wall', 'low', null], minTier: 2, weight: 2 },
  { cells: ['gate', 'gate', 'block'], minTier: 2, weight: 1.5 },

  { cells: ['low', 'gate', 'block'], minTier: 3, weight: 2 },
  { cells: ['gate', 'low', 'low'], minTier: 3, weight: 1.5 },
  { cells: ['block', 'gate', 'block'], minTier: 3, weight: 2 },
  { cells: ['wall', null, 'wall'], minTier: 3, weight: 1.5 },
  { cells: ['wall', 'gate', null], minTier: 3, weight: 1.5 },

  { cells: ['wall', 'low', 'wall'], minTier: 4, weight: 1.5 },
  { cells: ['block', 'low', 'block'], minTier: 4, weight: 1.5 },
  { cells: ['wall', 'block', null], minTier: 4, weight: 1.5 },
];

const PERMUTATIONS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

/** Reaction allowance (s) added to lane-change travel time when validating rows. */
export const FAIRNESS_REACTION_TIME = 0.4;
/** Lane changes must complete this many metres before the next row. */
const ARRIVAL_MARGIN = 1.0;
/** Clearance kept behind a wall before a lane counts as enterable again. */
const WALL_CLEARANCE = 0.5;
const MAX_ATTEMPTS = 12;
const NO_WALL = -1e9;

export interface GeneratorSink {
  spawnObstacle(kind: ObstacleKind, lane: number, z: number, depth: number, variant: number): void;
  spawnOrb(x: number, y: number, z: number): void;
}

export interface RowRecord {
  z: number;
  cells: Cell[];
  depths: number[];
  /** Lanes that can be survived at this row (bit mask). */
  passable: number;
}

const bit = (lane: number) => 1 << lane;

export class TrackGenerator {
  private rng: Rng;
  private nextRowZ = 0;
  private prevRowZ = 0;
  private prevPassable = 0b111;
  /** End of the most recent block/wall in each lane (absolute z). */
  private readonly wallEnd = [NO_WALL, NO_WALL, NO_WALL];
  private readonly cells: Cell[] = [null, null, null];
  private readonly depths = [0, 0, 0];
  rowsGenerated = 0;
  /** Optional hook for tests: receives a copy of every accepted row. */
  onRow: ((row: RowRecord) => void) | null = null;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.reset(seed);
  }

  reset(seed: number): void {
    this.rng = new Rng(seed);
    this.nextRowZ = TRACK.introDistance;
    this.prevRowZ = 0;
    this.prevPassable = 0b111;
    this.wallEnd.fill(NO_WALL);
    this.rowsGenerated = 0;
  }

  /** Generate every row whose position is below `upToZ`. */
  fill(upToZ: number, sink: GeneratorSink): void {
    while (this.nextRowZ < upToZ) this.generateRow(sink);
  }

  private generateRow(sink: GeneratorSink): void {
    const z = this.nextRowZ;
    const speed = speedAt(z);
    const tier = tierAt(z);
    const covered = this.coveredMask(z);

    let accepted = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !accepted; attempt++) {
      this.buildCandidate(Math.min(tier, MAX_PATTERN_TIER), covered);
      accepted = this.isRowFair(z, speed, covered);
    }
    if (!accepted) {
      // An empty row is always fair: every lane passable at the previous row
      // is still open (walls only ever begin at rows).
      this.cells.fill(null);
    }

    const passable = this.passableMask(covered);
    this.placeOrbs(z, speed, covered, passable);

    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const kind = this.cells[lane];
      if (!kind) continue;
      sink.spawnObstacle(kind, lane, z, this.depths[lane], this.rng.int(0, 7));
      if (isLaneBlocker(kind)) this.wallEnd[lane] = z + this.depths[lane];
    }
    this.flushOrbs(sink);

    if (this.onRow) {
      this.onRow({ z, cells: this.cells.slice(), depths: this.depths.slice(), passable });
    }

    this.prevPassable = passable;
    this.prevRowZ = z;
    this.rowsGenerated++;

    let gapTime = rowGapTime(tier) + this.rng.range(0, 0.45);
    if (this.rng.chance(0.08)) gapTime += 0.6;
    this.nextRowZ = z + speed * gapTime;
  }

  private coveredMask(z: number): number {
    let mask = 0;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      if (this.wallEnd[lane] > z - PLAYER.halfDepth - WALL_CLEARANCE) mask |= bit(lane);
    }
    return mask;
  }

  private buildCandidate(tier: number, covered: number): void {
    let total = 0;
    for (const p of PATTERNS) total += this.patternWeight(p, tier);
    let roll = this.rng.next() * total;
    let chosen = PATTERNS[0];
    for (const p of PATTERNS) {
      roll -= this.patternWeight(p, tier);
      if (roll <= 0) {
        chosen = p;
        break;
      }
    }
    const perm = PERMUTATIONS[this.rng.int(0, PERMUTATIONS.length - 1)];
    for (let i = 0; i < LANE_COUNT; i++) {
      const lane = perm[i];
      const kind = covered & bit(lane) ? null : chosen.cells[i];
      this.cells[lane] = kind;
      this.depths[lane] = !kind
        ? 0
        : kind === 'wall'
          ? this.rng.range(OBSTACLE.wallMinDepth, OBSTACLE.wallMaxDepth)
          : obstacleDepth(kind);
    }
  }

  private patternWeight(p: PatternDef, tier: number): number {
    if (p.minTier > tier) return 0;
    const age = tier - p.minTier;
    // Freshly unlocked patterns appear more often; very old ones fade a little.
    return p.weight * (age === 0 && tier > 0 ? 1.4 : 1) * (age >= 2 ? 0.6 : 1);
  }

  private passableMask(covered: number): number {
    let mask = 0;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const kind = this.cells[lane];
      if (!(covered & bit(lane)) && !(kind && isLaneBlocker(kind))) mask |= bit(lane);
    }
    return mask;
  }

  /**
   * Fairness rule: from EVERY lane that was survivable at the previous row,
   * the player must be able to reach some survivable lane of this row in
   * time, without passing through a block or wall. Lane travel time,
   * reaction time and wall lengths are all accounted for, so the invariant
   * holds no matter which survivable lane the player picked earlier.
   */
  private isRowFair(z: number, speed: number, covered: number): boolean {
    const next = this.passableMask(covered);
    if (next === 0) return false;
    for (let from = 0; from < LANE_COUNT; from++) {
      if (!(this.prevPassable & bit(from))) continue;
      let reachable = false;
      for (let to = 0; to < LANE_COUNT && !reachable; to++) {
        if (next & bit(to)) reachable = this.canTransit(from, to, z, speed);
      }
      if (!reachable) return false;
    }
    return true;
  }

  private canTransit(from: number, to: number, z: number, speed: number): boolean {
    if (from === to) return true;
    const dir = to > from ? 1 : -1;
    let earliestStart = this.prevRowZ;
    for (let lane = from + dir; lane !== to + dir; lane += dir) {
      const end = this.wallEnd[lane];
      if (end > this.prevRowZ - PLAYER.halfDepth) {
        if (end >= z - ARRIVAL_MARGIN) return false;
        earliestStart = Math.max(earliestStart, end + WALL_CLEARANCE + PLAYER.halfDepth);
      }
    }
    const needed = speed * (Math.abs(to - from) * PLAYER.laneChangeTime + FAIRNESS_REACTION_TIME);
    return z - ARRIVAL_MARGIN - earliestStart >= needed;
  }

  // ---- collectibles -------------------------------------------------------

  private orbBuffer: number[] = [];

  private queueOrb(x: number, y: number, z: number): void {
    this.orbBuffer.push(x, y, z);
  }

  private flushOrbs(sink: GeneratorSink): void {
    const b = this.orbBuffer;
    for (let i = 0; i < b.length; i += 3) sink.spawnOrb(b[i], b[i + 1], b[i + 2]);
    b.length = 0;
  }

  /**
   * Orbs only go in lanes that are free of blocks/walls for the whole gap
   * leading to this row, and they finish with a reachable flourish: an arc
   * over a ground barrier, a low line under a gate, or they stop early in
   * front of a blocker so they never lure the player into a crash.
   */
  private placeOrbs(z: number, speed: number, covered: number, passable: number): void {
    const gapStart = this.prevRowZ + 4;
    const gapEnd = z - 4;
    if (this.rowsGenerated === 0 || gapEnd - gapStart < 6 || !this.rng.chance(0.62)) return;

    let freeMask = 0;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      if (this.wallEnd[lane] < gapStart - 1 && !(covered & bit(lane))) freeMask |= bit(lane);
    }
    if (freeMask === 0) return;

    // Curved sequence across lanes: rewards well-timed lane changes.
    const target = this.pickLane(freeMask & passable) ?? this.pickLane(freeMask);
    if (target === null) return;
    if (freeMask === 0b111 && gapEnd - gapStart > 22 && this.rng.chance(0.2)) {
      let startLane = this.rng.int(0, 2);
      if (startLane === target) startLane = (target + 1 + this.rng.int(0, 1)) % 3;
      for (let oz = gapStart; oz <= gapEnd; oz += ORB.spacing) {
        const t = (oz - gapStart) / (gapEnd - gapStart);
        const x = startLane + (target - startLane) * (1 - Math.cos(Math.PI * t)) * 0.5;
        this.queueOrb(x, ORB.height, oz);
      }
    } else {
      const kind = this.cells[target];
      const blocked = (covered & bit(target)) !== 0 || (kind !== null && isLaneBlocker(kind));
      const end = blocked ? z - 9 : gapEnd;
      for (let oz = gapStart; oz <= end; oz += ORB.spacing) this.queueOrb(target, ORB.height, oz);
    }

    const kind = this.cells[target];
    if (kind === 'low') {
      // Follow the jump arc of a player whose apex is over the barrier.
      for (const offset of [-2.6, 0.25, 3.1]) {
        const t = offset / speed;
        const feet = Math.max(0, PLAYER.jumpHeight - 0.5 * GRAVITY * t * t);
        this.queueOrb(target, feet + ORB.height, z + offset);
      }
    } else if (kind === 'gate') {
      for (const offset of [-1.4, 0.25, 1.9]) this.queueOrb(target, 0.42, z + offset);
    }
  }

  private pickLane(mask: number): number | null {
    if (mask === 0) return null;
    const preferred = mask & this.prevPassable ? mask & this.prevPassable : mask;
    let count = 0;
    for (let lane = 0; lane < LANE_COUNT; lane++) if (preferred & bit(lane)) count++;
    let pick = this.rng.int(0, count - 1);
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      if (preferred & bit(lane) && pick-- === 0) return lane;
    }
    return null;
  }
}
