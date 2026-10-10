import './styles.css';
import { Game } from './game/game';

function parseOptions() {
  const params = new URLSearchParams(window.location.search);
  const seedParam = params.get('seed');
  const seed = seedParam && /^\d{1,10}$/.test(seedParam) ? Number(seedParam) >>> 0 : null;
  return { seed, debug: params.get('debug') === '1' };
}

function boot(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  try {
    if (!canvas) throw new Error('missing canvas');
    const game = new Game(canvas, parseOptions());
    game.init();
  } catch (err) {
    console.error(err);
    const loading = document.getElementById('screen-loading');
    if (loading) {
      loading.replaceChildren();
      const p = document.createElement('p');
      p.textContent = 'Sorry, NEON RUSH could not start in this browser. Please try a current version of Chrome, Edge, Firefox or Safari.';
      loading.append(p);
    }
  }
}

boot();
