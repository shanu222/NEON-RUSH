import { GRAVITY, JUMP_VELOCITY, LANE_COUNT, LANE_WIDTH, PLAYER } from '../core/config';

export type Action = 'left' | 'right' | 'jump' | 'slide';

/** Result of an action, used for audio/visual feedback. */
export type ActionResult = 'lane' | 'edge' | 'jump' | 'buffered' | 'fastfall' | 'slide' | null;

/**
 * Plain-data player state. Kept free of methods so the simulation can be
 * cloned cheaply by tests that search every possible input sequence.
 */
export interface PlayerState {
  /** Target lane, 0 (left) .. 2 (right). */
  lane: number;
  /** Continuous lane position; moves toward `lane` at constant speed. */
  x: number;
  /** Feet height above the track. */
  y: number;
  vy: number;
  airborne: boolean;
  /** Remaining slide time; > 0 while sliding on the ground. */
  slideTime: number;
  /** Slide requested mid-air (fast fall); starts on touchdown. */
  slideQueued: boolean;
  jumpBuffered: number;
  /** Seconds since the last successful lane change. */
  sinceLaneChange: number;
}

export function createPlayer(): PlayerState {
  return {
    lane: 1,
    x: 1,
    y: 0,
    vy: 0,
    airborne: false,
    slideTime: 0,
    slideQueued: false,
    jumpBuffered: 0,
    sinceLaneChange: 99,
  };
}

export function resetPlayer(p: PlayerState): void {
  Object.assign(p, createPlayer());
}

export function copyPlayer(from: PlayerState, to: PlayerState): PlayerState {
  to.lane = from.lane;
  to.x = from.x;
  to.y = from.y;
  to.vy = from.vy;
  to.airborne = from.airborne;
  to.slideTime = from.slideTime;
  to.slideQueued = from.slideQueued;
  to.jumpBuffered = from.jumpBuffered;
  to.sinceLaneChange = from.sinceLaneChange;
  return to;
}

function startJump(p: PlayerState): void {
  p.airborne = true;
  p.vy = JUMP_VELOCITY;
  p.slideTime = 0;
  p.slideQueued = false;
  p.jumpBuffered = 0;
}

export function applyAction(p: PlayerState, action: Action): ActionResult {
  switch (action) {
    case 'left':
    case 'right': {
      const next = p.lane + (action === 'left' ? -1 : 1);
      if (next < 0 || next >= LANE_COUNT) return 'edge';
      p.lane = next;
      p.sinceLaneChange = 0;
      return 'lane';
    }
    case 'jump':
      if (!p.airborne) {
        startJump(p);
        return 'jump';
      }
      p.jumpBuffered = PLAYER.jumpBuffer;
      return 'buffered';
    case 'slide':
      if (p.airborne) {
        p.vy = Math.min(p.vy, -PLAYER.fastFallSpeed);
        p.slideQueued = true;
        p.jumpBuffered = 0;
        return 'fastfall';
      }
      p.slideTime = PLAYER.slideDuration;
      return 'slide';
  }
}

/** Advance player physics by a fixed step. Returns true on the step it lands. */
export function stepPlayer(p: PlayerState, dt: number): boolean {
  const step = dt / PLAYER.laneChangeTime;
  const dx = p.lane - p.x;
  if (Math.abs(dx) <= step) p.x = p.lane;
  else p.x += dx > 0 ? step : -step;

  p.sinceLaneChange += dt;
  let landed = false;

  if (p.airborne) {
    p.vy -= GRAVITY * dt;
    p.y += p.vy * dt;
    if (p.jumpBuffered > 0) p.jumpBuffered = Math.max(0, p.jumpBuffered - dt);
    if (p.y <= 0) {
      p.y = 0;
      p.vy = 0;
      p.airborne = false;
      landed = true;
      if (p.slideQueued) {
        p.slideQueued = false;
        p.slideTime = PLAYER.slideDuration;
      } else if (p.jumpBuffered > 0) {
        startJump(p);
      }
    }
  } else if (p.slideTime > 0) {
    p.slideTime = Math.max(0, p.slideTime - dt);
  }
  return landed;
}

export function isSliding(p: PlayerState): boolean {
  return !p.airborne && p.slideTime > 0;
}

export function playerTop(p: PlayerState): number {
  return p.y + (isSliding(p) ? PLAYER.slideHeight : PLAYER.height);
}

/** World-space x of a (possibly fractional) lane index. */
export function laneToX(lane: number): number {
  return (lane - (LANE_COUNT - 1) / 2) * LANE_WIDTH;
}
