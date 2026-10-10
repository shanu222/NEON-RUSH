import { HIT_TOLERANCE, OBSTACLE, ORB, PLAYER } from '../core/config';
import { laneToX, playerTop, type PlayerState } from './player';

/**
 * low   - ground barrier: jump over it
 * gate  - overhead beam: slide under it
 * block - short barricade: change lane
 * wall  - long freight pod spanning many metres: change lane
 */
export type ObstacleKind = 'low' | 'gate' | 'block' | 'wall';

export interface Obstacle {
  active: boolean;
  kind: ObstacleKind;
  lane: number;
  /** Absolute track position of the near face (metres from the start line). */
  z: number;
  depth: number;
  /** Set once the obstacle has fully passed the player. */
  passed: boolean;
  /** Visual seed for small per-instance variations. */
  variant: number;
}

export interface Orb {
  active: boolean;
  /** Lane position, may be fractional for curved sequences. */
  x: number;
  y: number;
  z: number;
  collected: boolean;
  /** Passed the player without being collected (breaks the streak). */
  missed: boolean;
}

export function createObstacle(): Obstacle {
  return { active: false, kind: 'low', lane: 0, z: 0, depth: 0, passed: false, variant: 0 };
}

export function createOrb(): Orb {
  return { active: false, x: 0, y: 0, z: 0, collected: false, missed: false };
}

export function obstacleDepth(kind: ObstacleKind): number {
  switch (kind) {
    case 'low':
      return OBSTACLE.lowDepth;
    case 'gate':
      return OBSTACLE.gateDepth;
    case 'block':
      return OBSTACLE.blockDepth;
    case 'wall':
      return OBSTACLE.wallMinDepth;
  }
}

export function isLaneBlocker(kind: ObstacleKind): boolean {
  return kind === 'block' || kind === 'wall';
}

/**
 * Exact gameplay collision test between the player and an obstacle whose near
 * face is `relZ` metres ahead of the player. Uses the real movement state
 * (lane position, feet height, slide), never visual interpolation.
 */
export function hitsObstacle(p: PlayerState, kind: ObstacleKind, lane: number, relZ: number, depth: number): boolean {
  if (relZ > PLAYER.halfDepth || relZ + depth < -PLAYER.halfDepth) return false;

  const dx = Math.abs(laneToX(p.x) - laneToX(lane));
  if (dx >= PLAYER.halfWidth + OBSTACLE.halfWidth - HIT_TOLERANCE.horizontal) return false;

  const bottom = p.y;
  switch (kind) {
    case 'low':
      return bottom < OBSTACLE.lowHeight - HIT_TOLERANCE.vertical;
    case 'gate':
      return playerTop(p) > OBSTACLE.gateBottom + HIT_TOLERANCE.vertical && bottom < OBSTACLE.gateTop;
    case 'block':
    case 'wall':
      return bottom < OBSTACLE.wallHeight;
  }
}

export function touchesOrb(p: PlayerState, orb: Orb, relZ: number): boolean {
  if (Math.abs(relZ) > PLAYER.halfDepth + ORB.radius) return false;
  if (Math.abs(laneToX(p.x) - laneToX(orb.x)) > PLAYER.halfWidth + ORB.radius + 0.2) return false;
  return orb.y + ORB.radius > p.y && orb.y - ORB.radius < playerTop(p);
}
