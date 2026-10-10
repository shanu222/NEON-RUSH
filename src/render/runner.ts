/**
 * The NEON RUSH runner: an original geometric courier in a dark suit with a
 * cyan rim light, a glowing spine strip, a reactor backpack and a visor band,
 * seen from behind. Drawn procedurally in metre units (y up).
 */

export interface RunnerPose {
  /** Stride phase in radians. */
  phase: number;
  /** Lean from lane changes, radians. */
  tilt: number;
  /** 0 = running, 1 = fully tucked jump. */
  air: number;
  /** 0..1 slide amount. */
  slide: number;
  /** 0..1 crash progress (tumble + fade). */
  crash: number;
}

const SUIT = '#120d2b';
const SUIT_LIGHT = '#241a52';
const RIM = '#39f3ff';
const SPINE = '#ff3fd8';
const CORE = '#ffd05a';

function limb(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, w: number): void {
  ctx.lineWidth = w + 0.05;
  ctx.strokeStyle = RIM;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  ctx.lineWidth = w;
  ctx.strokeStyle = SUIT;
  ctx.stroke();
}

export function drawRunner(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, pose: RunnerPose): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, -scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pose.crash > 0) {
    ctx.globalAlpha = Math.max(0, 1 - pose.crash * 1.1);
    ctx.translate(0, pose.crash * 0.3);
    ctx.rotate(pose.crash * 1.2 * (pose.tilt >= 0 ? 1 : -1) + 0.2);
  } else {
    ctx.rotate(pose.tilt);
  }

  const s = Math.sin(pose.phase);
  const c = Math.cos(pose.phase);
  const run = (1 - pose.air) * (1 - pose.slide);

  // Body key points (metres), blended between running, jumping and sliding.
  const hipY = 0.95 - pose.slide * 0.62 + pose.air * 0.05;
  const shoulderY = hipY + 0.52 - pose.slide * 0.22;
  const headY = shoulderY + 0.2;
  const lean = pose.slide * 0.12;

  // Legs: seen from behind, stride shows as alternating foot lift.
  const footLift = (v: number) => Math.max(0, v) * 0.32 * run + pose.air * 0.36;
  const legSpread = 0.13 + pose.air * 0.06 + pose.slide * 0.04;
  const kneeOut = 0.06 + pose.air * 0.1;
  const leftFootY = footLift(s) + pose.slide * 0.08;
  const rightFootY = footLift(-s) + pose.slide * 0.08;
  const legW = 0.12;
  limb(ctx, -0.09, hipY, -legSpread - kneeOut, (hipY + leftFootY) * 0.5 + 0.06, -legSpread, leftFootY, legW);
  limb(ctx, 0.09, hipY, legSpread + kneeOut, (hipY + rightFootY) * 0.5 + 0.06, legSpread, rightFootY, legW);

  // Shoes with magenta glow strips.
  ctx.fillStyle = SPINE;
  ctx.fillRect(-legSpread - 0.08, leftFootY - 0.04, 0.16, 0.06);
  ctx.fillRect(legSpread - 0.08, rightFootY - 0.04, 0.16, 0.06);

  // Arms swing opposite to legs; raised for balance in the air.
  const armSwing = c * 0.14 * run;
  const handLY = shoulderY - 0.42 + armSwing + pose.air * 0.38 + pose.slide * 0.2;
  const handRY = shoulderY - 0.42 - armSwing + pose.air * 0.38 + pose.slide * 0.2;
  const handX = 0.36 + pose.air * 0.14 + pose.slide * 0.1;
  limb(ctx, -0.2, shoulderY - 0.04, -0.33 - pose.air * 0.06, shoulderY - 0.24 + pose.air * 0.2, -handX, handLY, 0.09);
  limb(ctx, 0.2, shoulderY - 0.04, 0.33 + pose.air * 0.06, shoulderY - 0.24 + pose.air * 0.2, handX, handRY, 0.09);

  // Torso.
  ctx.beginPath();
  ctx.moveTo(-0.23, shoulderY);
  ctx.lineTo(0.23, shoulderY);
  ctx.lineTo(0.16 + lean, hipY - 0.04);
  ctx.lineTo(-0.16 + lean, hipY - 0.04);
  ctx.closePath();
  ctx.fillStyle = SUIT_LIGHT;
  ctx.fill();
  ctx.lineWidth = 0.035;
  ctx.strokeStyle = RIM;
  ctx.stroke();

  // Reactor backpack.
  ctx.fillStyle = SUIT;
  ctx.fillRect(-0.14, shoulderY - 0.34, 0.28, 0.3);
  ctx.strokeStyle = RIM;
  ctx.lineWidth = 0.025;
  ctx.strokeRect(-0.14, shoulderY - 0.34, 0.28, 0.3);
  ctx.fillStyle = CORE;
  ctx.fillRect(-0.05, shoulderY - 0.26, 0.1, 0.14);

  // Spine light strip.
  ctx.fillStyle = SPINE;
  ctx.fillRect(-0.018, hipY, 0.036, shoulderY - 0.36 - hipY);

  // Helmet with visor band.
  ctx.beginPath();
  ctx.arc(lean * 0.5, headY + 0.04, 0.14, 0, Math.PI * 2);
  ctx.fillStyle = SUIT_LIGHT;
  ctx.fill();
  ctx.lineWidth = 0.03;
  ctx.strokeStyle = RIM;
  ctx.stroke();
  ctx.fillStyle = SPINE;
  ctx.fillRect(lean * 0.5 - 0.15, headY + 0.04, 0.3, 0.045);

  ctx.restore();
}
