import type { Records, Settings } from '../storage/save';

export type ScreenId = 'loading' | 'menu' | 'pause' | 'over' | null;
export type PanelId = 'howto' | 'settings';

export interface UiCallbacks {
  play(): void;
  resume(): void;
  restart(): void;
  menu(): void;
  pause(): void;
  toggleMute(): void;
  toggleFullscreen(): void;
  settingsChanged(patch: Partial<Settings>): void;
  resetRecords(): void;
  click(): void;
  panelClosed(): void;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

const nf = new Intl.NumberFormat('en-US');
export const formatNumber = (n: number) => nf.format(Math.floor(n));
export const formatDistance = (m: number) => `${nf.format(Math.floor(m))} m`;

/**
 * Owns every DOM element of the interface. HUD writes are cached so text is
 * only touched when a displayed value actually changes.
 */
export class UI {
  readonly root = $('game');
  private readonly screens: Record<Exclude<ScreenId, null>, HTMLElement> = {
    loading: $('screen-loading'),
    menu: $('screen-menu'),
    pause: $('screen-pause'),
    over: $('screen-over'),
  };
  private readonly panels: Record<PanelId, HTMLElement> = {
    howto: $('panel-howto'),
    settings: $('panel-settings'),
  };
  private readonly hud = $('hud');
  private readonly hudScore = $('hud-score');
  private readonly hudDistance = $('hud-distance');
  private readonly hudOrbs = $('hud-orbs');
  private readonly hudLevel = $('hud-level');
  private readonly muteBtn = $('btn-mute');
  private readonly countdownEl = $('countdown');
  private readonly toasts = $('toasts');
  private readonly hint = $('hint');
  private readonly touchpad = $('touchpad');
  private readonly fullscreenBtn = $('btn-fullscreen');
  private readonly resetBtn = $('btn-reset-records');

  private readonly setSound = $('set-sound') as HTMLInputElement;
  private readonly setMusic = $('set-music') as HTMLInputElement;
  private readonly setSfx = $('set-sfx') as HTMLInputElement;
  private readonly setMotion = $('set-motion') as HTMLSelectElement;
  private readonly setQuality = $('set-quality') as HTMLSelectElement;
  private readonly setTouch = $('set-touch') as HTMLInputElement;

  private current: ScreenId = 'loading';
  private openPanel: PanelId | null = null;
  private panelReturnFocus: HTMLElement | null = null;
  private last = { score: -1, distance: -1, orbs: -1, level: -1 };
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private resetArmed: ReturnType<typeof setTimeout> | null = null;
  private touchpadWanted = false;
  private hudVisible = false;

  constructor(private readonly cb: UiCallbacks) {
    const on = (id: string, fn: () => void) =>
      $(id).addEventListener('click', () => {
        cb.click();
        fn();
      });
    on('btn-play', () => cb.play());
    on('btn-howto', () => this.showPanel('howto'));
    on('btn-settings', () => this.showPanel('settings'));
    on('btn-settings-pause', () => this.showPanel('settings'));
    on('btn-fullscreen', () => cb.toggleFullscreen());
    on('btn-resume', () => cb.resume());
    on('btn-restart-pause', () => cb.restart());
    on('btn-menu-pause', () => cb.menu());
    on('btn-restart', () => cb.restart());
    on('btn-menu-over', () => cb.menu());
    $('btn-pause').addEventListener('click', () => cb.pause());
    this.muteBtn.addEventListener('click', () => cb.toggleMute());
    this.resetBtn.addEventListener('click', () => this.onReset());

    for (const panel of Object.values(this.panels)) {
      panel.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target === panel || target.closest('[data-close]')) {
          cb.click();
          this.closePanel();
        }
      });
    }

    $('settings-form').addEventListener('submit', (e) => e.preventDefault());
    this.setSound.addEventListener('change', () => cb.settingsChanged({ sound: this.setSound.checked }));
    this.setMusic.addEventListener('input', () => cb.settingsChanged({ musicVolume: Number(this.setMusic.value) / 100 }));
    this.setSfx.addEventListener('input', () => cb.settingsChanged({ sfxVolume: Number(this.setSfx.value) / 100 }));
    this.setSfx.addEventListener('change', () => cb.click());
    this.setMotion.addEventListener('change', () => cb.settingsChanged({ reducedMotion: this.setMotion.value as Settings['reducedMotion'] }));
    this.setQuality.addEventListener('change', () => cb.settingsChanged({ quality: this.setQuality.value as Settings['quality'] }));
    this.setTouch.addEventListener('change', () => cb.settingsChanged({ touchButtons: this.setTouch.checked }));
  }

  get screen(): ScreenId {
    return this.current;
  }

  get panel(): PanelId | null {
    return this.openPanel;
  }

  showScreen(id: ScreenId, focus = true): void {
    this.current = id;
    for (const [key, el] of Object.entries(this.screens)) el.hidden = key !== id;
    this.root.dataset.screen = id ?? 'none';
    if (id && focus) {
      const primary = this.screens[id].querySelector<HTMLElement>('.btn-primary');
      primary?.focus({ preventScroll: true });
    } else if (!id && document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) {
      // Drop focus from hidden buttons so Space/Enter go to the game.
      document.activeElement.blur();
    }
  }

  setState(state: string): void {
    this.root.dataset.state = state;
  }

  showPanel(id: PanelId): void {
    if (this.openPanel) this.closePanel(false);
    this.panelReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.openPanel = id;
    this.panels[id].hidden = false;
    const first = this.panels[id].querySelector<HTMLElement>('input, select, button');
    first?.focus({ preventScroll: true });
  }

  closePanel(notify = true): void {
    if (!this.openPanel) return;
    this.panels[this.openPanel].hidden = true;
    this.openPanel = null;
    this.disarmReset();
    if (this.panelReturnFocus && document.contains(this.panelReturnFocus) && this.panelReturnFocus.offsetParent !== null) {
      this.panelReturnFocus.focus({ preventScroll: true });
    }
    this.panelReturnFocus = null;
    if (notify) this.cb.panelClosed();
  }

  setHudVisible(visible: boolean): void {
    this.hudVisible = visible;
    this.hud.hidden = !visible;
    this.touchpad.hidden = !(visible && this.touchpadWanted);
  }

  updateHud(score: number, distance: number, orbs: number, level: number): void {
    const s = Math.floor(score);
    const d = Math.floor(distance);
    if (s !== this.last.score) {
      this.last.score = s;
      this.hudScore.textContent = formatNumber(s);
    }
    if (d !== this.last.distance) {
      this.last.distance = d;
      this.hudDistance.textContent = formatDistance(d);
    }
    if (orbs !== this.last.orbs) {
      this.last.orbs = orbs;
      this.hudOrbs.textContent = String(orbs);
    }
    if (level !== this.last.level) {
      this.last.level = level;
      this.hudLevel.textContent = String(level);
    }
  }

  resetHud(): void {
    this.last = { score: -1, distance: -1, orbs: -1, level: -1 };
    this.updateHud(0, 0, 0, 1);
  }

  showCountdown(text: string | null): void {
    if (text === null) {
      this.countdownEl.hidden = true;
      this.countdownEl.textContent = '';
      return;
    }
    this.countdownEl.hidden = false;
    const span = document.createElement('span');
    span.textContent = text;
    this.countdownEl.replaceChildren(span);
  }

  toast(text: string, tone: 'amber' | 'magenta' | 'cyan' = 'cyan', ms = 1300): void {
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = text;
    while (this.toasts.childElementCount >= 3) this.toasts.firstElementChild?.remove();
    this.toasts.append(el);
    const reduced = this.root.classList.contains('reduced-motion');
    if (typeof el.animate === 'function' && !reduced) {
      el.animate(
        [
          { opacity: 0, transform: 'translateY(8px) scale(0.9)' },
          { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.15 },
          { opacity: 1, offset: 0.8 },
          { opacity: 0, transform: 'translateY(-6px)' },
        ],
        { duration: ms, easing: 'ease-out', fill: 'forwards' },
      );
    }
    setTimeout(() => el.remove(), ms);
  }

  clearToasts(): void {
    this.toasts.replaceChildren();
  }

  showHint(ms = 5000): void {
    this.hideHint();
    this.hint.hidden = false;
    this.hintTimer = setTimeout(() => this.hideHint(), ms);
  }

  hideHint(): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = null;
    this.hint.hidden = true;
  }

  setStats(r: Records): void {
    $('stat-best').textContent = formatNumber(r.bestScore);
    $('stat-distance').textContent = formatDistance(r.bestDistance);
    $('stat-runs').textContent = formatNumber(r.runs);
  }

  setGameOver(score: number, distance: number, orbs: number, best: number, newBest: boolean): void {
    $('over-score').textContent = formatNumber(score);
    $('over-distance').textContent = formatDistance(distance);
    $('over-orbs').textContent = formatNumber(orbs);
    $('over-best').textContent = formatNumber(best);
    $('over-title').textContent = newBest ? 'New best!' : 'Run over';
    $('over-badge').hidden = !newBest;
  }

  applySettings(s: Settings, storageAvailable: boolean): void {
    this.setSound.checked = s.sound;
    this.setMusic.value = String(Math.round(s.musicVolume * 100));
    this.setSfx.value = String(Math.round(s.sfxVolume * 100));
    this.setMusic.disabled = this.setSfx.disabled = !s.sound;
    this.setMotion.value = s.reducedMotion;
    this.setQuality.value = s.quality;
    this.setTouch.checked = s.touchButtons;
    this.muteBtn.setAttribute('aria-pressed', String(!s.sound));
    this.muteBtn.setAttribute('aria-label', s.sound ? 'Mute sound' : 'Unmute sound');
    this.touchpadWanted = s.touchButtons;
    this.touchpad.hidden = !(this.hudVisible && s.touchButtons);
    $('storage-note').hidden = storageAvailable;
  }

  setReducedMotion(on: boolean): void {
    this.root.classList.toggle('reduced-motion', on);
  }

  setFullscreenAvailable(available: boolean): void {
    this.fullscreenBtn.hidden = !available;
  }

  setFullscreenActive(active: boolean): void {
    this.fullscreenBtn.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  }

  private onReset(): void {
    this.cb.click();
    if (!this.resetArmed) {
      this.resetBtn.classList.add('confirm');
      this.resetBtn.textContent = 'Tap again to confirm';
      this.resetArmed = setTimeout(() => this.disarmReset(), 3000);
      return;
    }
    this.disarmReset();
    this.cb.resetRecords();
    this.toast('Records reset', 'magenta');
  }

  private disarmReset(): void {
    if (this.resetArmed) clearTimeout(this.resetArmed);
    this.resetArmed = null;
    this.resetBtn.classList.remove('confirm');
    this.resetBtn.textContent = 'Reset records';
  }
}
