/**
 * Difficulty progression. Everything is a pure function of distance so the
 * track layout never depends on frame rate or on what the player does.
 *
 * Speed eases from 15 m/s toward 33 m/s:
 *   speed(d) = 15 + 18 * (1 - e^(-d / 2400))
 * Reaches ~22 m/s at 1 km, ~28 m/s at 3 km and never exceeds 33 m/s.
 */
export const SPEED_START = 15;
export const SPEED_MAX = 33;
const SPEED_RANGE = 18;
const SPEED_CURVE = 2400;

/** Distance (m) at which each speed level begins. */
export const TIER_DISTANCES = [0, 400, 1000, 1800, 3000, 4500, 6500, 9000] as const;
export const MAX_TIER = TIER_DISTANCES.length - 1;
/** Highest tier that unlocks new obstacle patterns; later tiers only tighten spacing. */
export const MAX_PATTERN_TIER = 4;

export function speedAt(distance: number): number {
  const d = Math.max(0, distance);
  return Math.min(SPEED_MAX, SPEED_START + SPEED_RANGE * (1 - Math.exp(-d / SPEED_CURVE)));
}

export function tierAt(distance: number): number {
  let tier = 0;
  for (let i = 1; i < TIER_DISTANCES.length; i++) {
    if (distance >= TIER_DISTANCES[i]) tier = i;
  }
  return tier;
}

/**
 * Seconds of travel between obstacle rows at a tier (before random extra
 * spacing). The floor of 0.9 s stays above the 0.66 s jump / 0.72 s slide
 * plus a reaction margin, so any two consecutive actions remain possible.
 */
const ROW_GAP_TIME = [1.45, 1.25, 1.12, 1.02, 0.96, 0.93, 0.91, 0.9];
export const MIN_ROW_GAP_TIME = 0.9;

export function rowGapTime(tier: number): number {
  return ROW_GAP_TIME[Math.max(0, Math.min(ROW_GAP_TIME.length - 1, tier))];
}

/** Score multiplier applied to distance points: 1.0x, 1.25x, 1.5x ... */
export function tierMultiplier(tier: number): number {
  return 1 + 0.25 * tier;
}
