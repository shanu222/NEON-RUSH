import { POOL_SIZE, TRACK } from '../core/config';
import { speedAt, tierAt } from './difficulty';
import {
  createObstacle,
  createOrb,
  hitsObstacle,
  isLaneBlocker,
  touchesOrb,
  type Obstacle,
  type ObstacleKind,
  type Orb,
} from './entities';
import { TrackGenerator, type GeneratorSink } from './generator';
import { applyAction, createPlayer, resetPlayer, stepPlayer, type Action, type ActionResult, type PlayerState } from './player';
import { SCORE, addCloseCall, addDistance, addOrb, createScore, resetScore, totalScore, type ScoreState } from './scoring';

export interface WorldEvents {
  onAction?(result: ActionResult): void;
  onLand?(): void;
  onOrb?(orb: Orb, streak: number): void;
  onCrash?(obstacle: Obstacle): void;
  onCloseCall?(obstacle: Obstacle): void;
  onTier?(tier: number): void;
}

/**
 * Complete, DOM-free simulation of one run. Deterministic for a given seed
 * and sequence of (action, fixed-step) calls, which is what the automated
 * fairness tests rely on.
 */
export class World implements GeneratorSink {
  readonly player: PlayerState = createPlayer();
  readonly score: ScoreState = createScore();
  readonly obstacles: Obstacle[] = [];
  readonly orbs: Orb[] = [];
  readonly generator: TrackGenerator;

  seed = 0;
  distance = 0;
  time = 0;
  speed = speedAt(0);
  tier = 0;
  alive = true;
  orbStreak = 0;
  /** Lane the player left with their most recent lane change. */
  dodgeFromLane = -1;
  crashedInto: Obstacle | null = null;
  /** Test/debug only: collisions are ignored. Never enabled in normal play. */
  invulnerable = false;
  /** Set when the obstacle pool overflowed (should never happen; checked by tests). */
  poolOverflow = false;
  events: WorldEvents = {};

  constructor(seed = 1) {
    for (let i = 0; i < POOL_SIZE.obstacles; i++) this.obstacles.push(createObstacle());
    for (let i = 0; i < POOL_SIZE.orbs; i++) this.orbs.push(createOrb());
    this.generator = new TrackGenerator(seed);
    this.reset(seed);
  }

  reset(seed: number): void {
    this.seed = seed;
    resetPlayer(this.player);
    resetScore(this.score);
    for (const o of this.obstacles) o.active = false;
    for (const o of this.orbs) o.active = false;
    this.distance = 0;
    this.time = 0;
    this.speed = speedAt(0);
    this.tier = 0;
    this.alive = true;
    this.orbStreak = 0;
    this.dodgeFromLane = -1;
    this.crashedInto = null;
    this.poolOverflow = false;
    this.generator.reset(seed);
    this.generator.fill(TRACK.spawnAhead, this);
  }

  get totalScore(): number {
    return totalScore(this.score);
  }

  act(action: Action): ActionResult {
    if (!this.alive) return null;
    const fromLane = this.player.lane;
    const result = applyAction(this.player, action);
    if (result === 'lane') this.dodgeFromLane = fromLane;
    this.events.onAction?.(result);
    return result;
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.speed = speedAt(this.distance);
    const dz = this.speed * dt;
    this.distance += dz;
    this.time += dt;
    addDistance(this.score, dz, this.tier);

    const tier = tierAt(this.distance);
    if (tier !== this.tier) {
      this.tier = tier;
      this.events.onTier?.(tier);
    }

    if (stepPlayer(this.player, dt)) this.events.onLand?.();
    this.generator.fill(this.distance + TRACK.spawnAhead, this);
    this.resolveObstacles();
    if (this.alive) this.resolveOrbs();
  }

  /** Menu "attract mode": scenery scrolls and the runner jogs, no hazards. */
  attract(dt: number, speed: number): void {
    this.distance += speed * dt;
    this.time += dt;
    stepPlayer(this.player, dt);
  }

  clearHazards(): void {
    for (const o of this.obstacles) o.active = false;
    for (const o of this.orbs) o.active = false;
  }

  private resolveObstacles(): void {
    const p = this.player;
    for (const o of this.obstacles) {
      if (!o.active) continue;
      const relZ = o.z - this.distance;
      if (relZ + o.depth < -TRACK.recycleBehind) {
        o.active = false;
        continue;
      }
      if (!this.invulnerable && hitsObstacle(p, o.kind, o.lane, relZ, o.depth)) {
        this.alive = false;
        this.crashedInto = o;
        this.events.onCrash?.(o);
        return;
      }
      if (!o.passed && relZ + o.depth < -0.4) {
        o.passed = true;
        if (
          isLaneBlocker(o.kind) &&
          o.lane === this.dodgeFromLane &&
          p.sinceLaneChange < SCORE.closeCallWindow + o.depth / this.speed
        ) {
          addCloseCall(this.score);
          this.events.onCloseCall?.(o);
        }
      }
    }
  }

  private resolveOrbs(): void {
    for (const orb of this.orbs) {
      if (!orb.active || orb.collected) continue;
      const relZ = orb.z - this.distance;
      if (relZ < -TRACK.recycleBehind) {
        orb.active = false;
        continue;
      }
      if (relZ < -1.2) {
        if (!orb.missed) {
          orb.missed = true;
          this.orbStreak = 0;
        }
        continue;
      }
      if (touchesOrb(this.player, orb, relZ)) {
        orb.collected = true;
        orb.active = false;
        addOrb(this.score);
        this.orbStreak++;
        this.events.onOrb?.(orb, this.orbStreak);
      }
    }
  }

  // ---- GeneratorSink --------------------------------------------------------

  spawnObstacle(kind: ObstacleKind, lane: number, z: number, depth: number, variant: number): void {
    const o = this.obstacles.find((item) => !item.active);
    if (!o) {
      this.poolOverflow = true;
      return;
    }
    o.active = true;
    o.kind = kind;
    o.lane = lane;
    o.z = z;
    o.depth = depth;
    o.passed = false;
    o.variant = variant;
  }

  spawnOrb(x: number, y: number, z: number): void {
    const orb = this.orbs.find((item) => !item.active);
    if (!orb) return;
    orb.active = true;
    orb.collected = false;
    orb.missed = false;
    orb.x = x;
    orb.y = y;
    orb.z = z;
  }
}
