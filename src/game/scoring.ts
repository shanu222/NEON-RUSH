import { ORB } from '../core/config';
import { tierMultiplier } from './difficulty';

/**
 * Scoring formula (transparent and additive):
 *
 *   score = distance points + orb points + close-call points
 *
 *   distance points = sum over every metre run of (1 + 0.25 * speedLevel)
 *                     i.e. 1 pt/m at level 0, 1.25 pt/m at level 1, ...
 *   orb points      = 10 per energy orb
 *   close calls     = 50 each: leaving a block's or wall's lane less than
 *                     0.5 s before reaching it, and surviving.
 */
export const SCORE = {
  orb: ORB.points,
  closeCall: 50,
  closeCallWindow: 0.5,
} as const;

export interface ScoreState {
  distancePoints: number;
  orbPoints: number;
  bonusPoints: number;
  orbs: number;
  closeCalls: number;
}

export function createScore(): ScoreState {
  return { distancePoints: 0, orbPoints: 0, bonusPoints: 0, orbs: 0, closeCalls: 0 };
}

export function resetScore(s: ScoreState): void {
  s.distancePoints = 0;
  s.orbPoints = 0;
  s.bonusPoints = 0;
  s.orbs = 0;
  s.closeCalls = 0;
}

export function addDistance(s: ScoreState, metres: number, tier: number): void {
  s.distancePoints += metres * tierMultiplier(tier);
}

export function addOrb(s: ScoreState): void {
  s.orbs++;
  s.orbPoints += SCORE.orb;
}

export function addCloseCall(s: ScoreState): void {
  s.closeCalls++;
  s.bonusPoints += SCORE.closeCall;
}

export function totalScore(s: ScoreState): number {
  return Math.floor(s.distancePoints + s.orbPoints + s.bonusPoints);
}
