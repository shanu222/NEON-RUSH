import type { Action } from '../game/player';

export interface InputHandlers {
  /** Any user gesture (used to unlock audio). */
  gesture(): void;
  /** True while gameplay actions are accepted (playing state). */
  acceptsActions(): boolean;
  /** True while game keys should not scroll the page (playing / countdown). */
  capturesKeys(): boolean;
  action(action: Action): void;
  /** Escape / P. */
  pauseKey(key: 'escape' | 'p'): void;
  /** Enter / Space outside of focused controls. Returns true when handled. */
  primary(): boolean;
}

const KEY_ACTIONS: Record<string, Action> = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'jump',
  KeyW: 'jump',
  Space: 'jump',
  ArrowDown: 'slide',
  KeyS: 'slide',
};

const KEY_FALLBACK: Record<string, string> = {
  a: 'KeyA',
  A: 'KeyA',
  d: 'KeyD',
  D: 'KeyD',
  w: 'KeyW',
  W: 'KeyW',
  s: 'KeyS',
  S: 'KeyS',
  ' ': 'Space',
  p: 'KeyP',
  P: 'KeyP',
};

function keyCode(e: KeyboardEvent): string {
  if (e.code) return e.code;
  return KEY_FALLBACK[e.key] ?? e.key;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return type !== 'checkbox' && type !== 'button' && type !== 'submit';
  }
  return false;
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, a, input, select, textarea, summary, [role="button"]') !== null;
}

/**
 * Keyboard + pointer (mouse/touch/pen) input. A swipe gesture fires at most
 * one action: it triggers as soon as the finger travels past the threshold,
 * and the rest of that gesture is ignored.
 */
export class Input {
  private swipeId = -1;
  private startX = 0;
  private startY = 0;
  private startT = 0;
  private fired = false;
  private threshold = 30;
  private readonly abort = new AbortController();

  constructor(
    private readonly surface: HTMLElement,
    touchPad: HTMLElement,
    private readonly h: InputHandlers,
  ) {
    const opts = { signal: this.abort.signal };
    window.addEventListener('keydown', this.onKeyDown, opts);
    surface.addEventListener('pointerdown', this.onPointerDown, opts);
    surface.addEventListener('pointermove', this.onPointerMove, opts);
    surface.addEventListener('pointerup', this.onPointerEnd, opts);
    surface.addEventListener('pointercancel', this.onPointerEnd, opts);
    surface.addEventListener('lostpointercapture', this.onPointerEnd, opts);
    surface.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    touchPad.addEventListener('pointerdown', this.onPadDown, opts);
    // Gesture hooks for audio unlock on any interaction, including menus
    // (iOS only accepts some of these event types as activation).
    for (const type of ['pointerdown', 'touchend', 'click'] as const) {
      window.addEventListener(type, () => h.gesture(), { capture: true, passive: true, signal: this.abort.signal });
    }
  }

  destroy(): void {
    this.abort.abort();
  }

  /** Called on resize (no layout reads during gameplay). */
  setSurfaceSize(width: number, height: number): void {
    this.threshold = Math.max(22, Math.min(48, Math.min(width, height) * 0.06));
  }

  /** Cancel any in-progress gesture (state change, pause, etc). */
  reset(): void {
    this.swipeId = -1;
    this.fired = false;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.h.gesture();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target)) return;
    const code = keyCode(e);

    if (code === 'Escape' || code === 'KeyP') {
      if (!e.repeat) this.h.pauseKey(code === 'Escape' ? 'escape' : 'p');
      return;
    }

    const action = KEY_ACTIONS[code];
    if (action && this.h.acceptsActions()) {
      e.preventDefault();
      if (!e.repeat) this.h.action(action);
      return;
    }

    if ((code === 'Enter' || code === 'NumpadEnter' || code === 'Space') && !isControl(e.target)) {
      if (!e.repeat && this.h.primary()) e.preventDefault();
      return;
    }

    if (action && this.h.capturesKeys()) e.preventDefault();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.h.acceptsActions()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button, input, select, label, [data-no-swipe]')) return;
    if (this.swipeId !== -1) return; // ignore extra fingers
    this.swipeId = e.pointerId;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startT = e.timeStamp;
    this.fired = false;
    try {
      this.surface.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an optimisation only.
    }
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.swipeId || this.fired) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (dx * dx + dy * dy >= this.threshold * this.threshold) this.fire(dx, dy);
  };

  private onPointerEnd = (e: PointerEvent): void => {
    if (e.pointerId !== this.swipeId) return;
    if (!this.fired && e.type === 'pointerup') {
      // Short, fast flicks that ended before reaching the full threshold.
      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      const half = this.threshold * 0.5;
      if (dx * dx + dy * dy >= half * half && e.timeStamp - this.startT < 250) this.fire(dx, dy);
    }
    this.swipeId = -1;
    this.fired = false;
  };

  private fire(dx: number, dy: number): void {
    this.fired = true;
    if (!this.h.acceptsActions()) return;
    if (Math.abs(dx) > Math.abs(dy)) this.h.action(dx < 0 ? 'left' : 'right');
    else this.h.action(dy < 0 ? 'jump' : 'slide');
  }

  private onPadDown = (e: PointerEvent): void => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-action]') : null;
    if (!btn) return;
    e.preventDefault();
    if (this.h.acceptsActions()) this.h.action(btn.dataset.action as Action);
  };
}
