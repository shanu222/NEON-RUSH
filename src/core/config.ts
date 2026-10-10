/**
 * Gameplay constants. All world units are metres and seconds.
 * The world uses a right-handed layout where +z points down the track
 * (away from the camera) and the player always sits at z = 0.
 */

export const FIXED_DT = 1 / 120;
export const MAX_FRAME_DT = 0.1;
export const MAX_STEPS_PER_FRAME = 12;

export const LANE_COUNT = 3;
export const LANE_WIDTH = 2.4;
export const ROAD_HALF_WIDTH = LANE_WIDTH * 1.5 + 0.25;

export const PLAYER = {
  halfWidth: 0.42,
  halfDepth: 0.35,
  height: 1.75,
  slideHeight: 0.72,
  /** Seconds to travel exactly one lane. */
  laneChangeTime: 0.14,
  jumpHeight: 1.35,
  jumpDuration: 0.66,
  slideDuration: 0.72,
  /** Downward speed applied when slide is pressed in the air. */
  fastFallSpeed: 16,
  /** Jump presses this close to landing are remembered and fire on touchdown. */
  jumpBuffer: 0.14,
} as const;

export const GRAVITY = (8 * PLAYER.jumpHeight) / (PLAYER.jumpDuration * PLAYER.jumpDuration);
export const JUMP_VELOCITY = (4 * PLAYER.jumpHeight) / PLAYER.jumpDuration;

export const OBSTACLE = {
  halfWidth: 1.0,
  /** Top of a ground barrier; must be jumped. */
  lowHeight: 0.72,
  /** Underside of an overhead gate beam; must be slid under. */
  gateBottom: 1.05,
  gateTop: 2.7,
  /** Height of blocks/walls: higher than any jump, so a lane change is required. */
  wallHeight: 2.5,
  lowDepth: 0.5,
  gateDepth: 0.5,
  blockDepth: 1.6,
  wallMinDepth: 10,
  wallMaxDepth: 22,
} as const;

/** Small forgiveness so grazing contacts do not feel unfair. */
export const HIT_TOLERANCE = { horizontal: 0.08, vertical: 0.04 } as const;

export const ORB = {
  radius: 0.45,
  height: 0.9,
  spacing: 3,
  points: 10,
} as const;

export const TRACK = {
  /** Obstacles are generated this far ahead of the player. */
  spawnAhead: 150,
  /** Distance at which hazards are fully visible. */
  viewDistance: 135,
  /** First obstacle row is placed this far from the start line. */
  introDistance: 90,
  /** Objects further behind than this are recycled. */
  recycleBehind: 8,
} as const;

export const POOL_SIZE = { obstacles: 64, orbs: 128 } as const;
