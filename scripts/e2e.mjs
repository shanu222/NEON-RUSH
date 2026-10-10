// End-to-end browser checks for the production build.
//
//   npm run build && node scripts/e2e.mjs
//
// Serves dist/ under a sub-path on one origin and a parent page that embeds
// it in an iframe on a different origin, then drives a locally installed
// Chromium-based browser (Edge or Chrome) through playwright-core.
// Set BROWSER_PATH to use a specific executable. Screenshots go to test-results/.

import { createServer } from 'node:http';
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'test-results');
const GAME_PORT = 4173;
const PARENT_PORT = 4174;
const GAME_PATH = '/games/neon-rush/';
const GAME_ORIGIN = `http://127.0.0.1:${GAME_PORT}`;
const PARENT_ORIGIN = `http://localhost:${PARENT_PORT}`;
const GAME_URL = `${GAME_ORIGIN}${GAME_PATH}`;
const AD_PATTERN = /googlesyndication|adsbygoogle|doubleclick|googletagservices|adservice|imasdk|h5.?games.?ads|adBreak|adConfig|pagead/i;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function serveGame() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, GAME_ORIGIN);
    if (!url.pathname.startsWith(GAME_PATH)) {
      res.writeHead(404).end('not found');
      return;
    }
    let rel = url.pathname.slice(GAME_PATH.length) || 'index.html';
    const file = normalize(join(DIST, rel));
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  }).listen(GAME_PORT);
}

function serveParent() {
  const html = `<!doctype html><html><head><title>FreeArcadeHub test parent</title>
  <style>body{margin:0;background:#111;color:#ccc;font:14px sans-serif}iframe{display:block;margin:20px auto;width:900px;height:560px;border:0}</style></head>
  <body><p id="parent-marker">Parent page</p>
  <iframe id="game" src="${GAME_URL}?debug=1&seed=42" title="NEON RUSH" allow="fullscreen; autoplay" allowfullscreen></iframe></body></html>`;
  return createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  }).listen(PARENT_PORT);
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
    console.log(`  FAIL  ${name}\n        ${String(err?.message ?? err).split('\n')[0]}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = (target) => target.evaluate(() => window.__NEON_RUSH__.snapshot());

async function waitState(target, state, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await snap(target);
    if (s.state === state) return s;
    await sleep(40);
  }
  throw new Error(`timed out waiting for state ${state} (last: ${(await snap(target)).state})`);
}

async function waitFor(target, pred, label, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await snap(target);
    if (pred(s)) return s;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function launch(extraArgs = []) {
  const opts = { headless: true, args: ['--autoplay-policy=user-gesture-required', ...extraArgs] };
  if (process.env.BROWSER_PATH) return chromium.launch({ ...opts, executablePath: process.env.BROWSER_PATH });
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ ...opts, channel });
    } catch {
      // try next
    }
  }
  throw new Error('No Chromium-based browser found. Set BROWSER_PATH.');
}

function trackRequests(page, list) {
  page.on('request', (r) => list.push(r.url()));
}

function trackErrors(page, list) {
  page.on('pageerror', (e) => list.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && list.push(m.text()));
}

async function rafRateProbe(page) {
  // Counts requestAnimationFrame callbacks per second to detect duplicate loops.
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const orig = window.__rafCount ?? 0;
        setTimeout(() => resolve({ rafPerSec: ((window.__rafCount ?? 0) - orig) / ((performance.now() - t0) / 1000), n }), 1000);
      }),
  );
}

const RAF_COUNTER = () => {
  const orig = window.requestAnimationFrame.bind(window);
  window.__rafCount = 0;
  window.requestAnimationFrame = (cb) =>
    orig((t) => {
      window.__rafCount++;
      cb(t);
    });
};

async function main() {
  assert(existsSync(join(DIST, 'index.html')), 'dist/ missing: run npm run build first');
  await mkdir(OUT, { recursive: true });
  const gameServer = serveGame();
  const parentServer = serveParent();
  const browser = await launch();
  console.log(`Browser: ${browser.version()}\n`);

  const requests = [];
  const errors = [];

  // ---------------- desktop ----------------
  const desk = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await desk.addInitScript(RAF_COUNTER);
  const page = await desk.newPage();
  trackRequests(page, requests);
  trackErrors(page, errors);
  await page.goto(`${GAME_URL}?debug=1&seed=42`);

  await check('1. main menu loads', async () => {
    await page.waitForSelector('#screen-menu:not([hidden])', { timeout: 5000 });
    const s = await snap(page);
    assert(s.state === 'menu', `state ${s.state}`);
    assert(await page.isVisible('#btn-play'), 'play button not visible');
    await sleep(600);
    await page.screenshot({ path: join(OUT, 'desktop-menu.png') });
  });

  await check('how-to and settings panels open/close (keyboard Escape)', async () => {
    await page.click('#btn-howto');
    assert(await page.isVisible('#panel-howto'), 'howto not visible');
    await sleep(450);
    await page.screenshot({ path: join(OUT, 'desktop-howto.png') });
    await page.keyboard.press('Escape');
    assert(!(await page.isVisible('#panel-howto')), 'howto did not close');
    await page.click('#btn-settings');
    assert(await page.isVisible('#panel-settings'), 'settings not visible');
    await sleep(450);
    await page.screenshot({ path: join(OUT, 'desktop-settings.png') });
    await page.click('#panel-settings [data-close]');
    assert(!(await page.isVisible('#panel-settings')), 'settings did not close');
  });

  await check('2. player can start a run (Enter key on menu)', async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Enter');
    await waitState(page, 'ready', 2000);
    await page.evaluate(() => window.__NEON_RUSH__.setInvulnerable(true));
    await waitState(page, 'playing', 3000);
  });

  await check('3/5. keyboard controls work and lanes are clamped', async () => {
    await page.keyboard.press('ArrowLeft');
    let s = await waitFor(page, (x) => x.x === 0, 'x=0');
    assert(s.lane === 0, `lane ${s.lane}`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('KeyA');
    await sleep(200);
    s = await snap(page);
    assert(s.lane === 0 && s.x === 0, `moved past left edge: ${s.lane}/${s.x}`);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('KeyD');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    s = await waitFor(page, (x) => x.x === 2, 'x=2');
    assert(s.lane === 2, `lane ${s.lane}`);
    await page.keyboard.press('ArrowLeft');
    await waitFor(page, (x) => x.x === 1, 'back to centre');
    const scrollY = await page.evaluate(() => window.scrollY + document.documentElement.scrollTop);
    assert(scrollY === 0, 'page scrolled');
  });

  await check('6. jump and slide timing', async () => {
    await page.keyboard.press('ArrowUp');
    const t0 = Date.now();
    await waitFor(page, (x) => x.airborne, 'airborne', 500);
    await waitFor(page, (x) => !x.airborne, 'landed', 2000);
    const jumpMs = Date.now() - t0;
    assert(jumpMs > 450 && jumpMs < 950, `jump lasted ${jumpMs}ms`);
    await sleep(100);
    await page.keyboard.press('KeyS');
    const t1 = Date.now();
    await waitFor(page, (x) => x.sliding, 'sliding', 500);
    await waitFor(page, (x) => !x.sliding, 'slide ended', 2000);
    const slideMs = Date.now() - t1;
    assert(slideMs > 500 && slideMs < 1000, `slide lasted ${slideMs}ms`);
    await page.keyboard.press('Space');
    await waitFor(page, (x) => x.airborne, 'space jump', 500);
    await page.keyboard.press('KeyW');
    await waitFor(page, (x) => !x.airborne, 'landed', 2000);
  });

  await check('9/10. score, orbs and speed increase while running', async () => {
    const a = await snap(page);
    await sleep(2500);
    const b = await snap(page);
    assert(b.score > a.score, 'score did not increase');
    assert(b.distance > a.distance + 20, 'distance did not increase');
    assert(b.speed >= a.speed, 'speed decreased');
    await page.screenshot({ path: join(OUT, 'desktop-gameplay.png') });
  });

  await check('later-game hazards render (debug fast-forward)', async () => {
    for (const secs of [40, 30, 50]) {
      await page.evaluate((s) => window.__NEON_RUSH__.fastForward(s), secs);
      await sleep(350);
      const s = await snap(page);
      await page.screenshot({ path: join(OUT, `desktop-gameplay-${Math.round(s.distance)}m.png`) });
    }
    const s = await snap(page);
    assert(s.tier >= 2 && s.speed > 20, `tier ${s.tier} speed ${s.speed}`);
  });

  await check('11. pause and resume preserve state (Escape)', async () => {
    await page.keyboard.press('Escape');
    const p1 = await waitState(page, 'paused', 1000);
    assert(await page.isVisible('#screen-pause'), 'pause screen not visible');
    await sleep(1200);
    const p2 = await snap(page);
    assert(p2.distance === p1.distance && p2.score === p1.score && p2.lane === p1.lane, 'state advanced while paused');
    await page.screenshot({ path: join(OUT, 'desktop-paused.png') });
    await page.keyboard.press('Escape');
    await waitState(page, 'ready', 1000);
    const r = await snap(page);
    assert(r.distance === p1.distance, 'distance changed during countdown');
    await waitState(page, 'playing', 3000);
    await sleep(300);
    const r2 = await snap(page);
    assert(r2.distance > p1.distance && r2.distance < p1.distance + 40, `resume jumped: ${p1.distance} -> ${r2.distance}`);
  });

  await check('18. hidden tab pauses the game', async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitState(page, 'paused', 1000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(300);
    assert((await snap(page)).state === 'paused', 'should stay paused until the player resumes');
    await page.click('#btn-resume');
    await waitState(page, 'playing', 3000);
  });

  await check('19. canvas resizes without restarting', async () => {
    const before = await snap(page);
    await page.setViewportSize({ width: 820, height: 600 });
    await sleep(250);
    const s = await snap(page);
    assert(s.canvas.cssWidth === 820 && s.canvas.cssHeight === 600, `css ${s.canvas.cssWidth}x${s.canvas.cssHeight}`);
    const ratio = s.canvas.width / s.canvas.cssWidth;
    assert(Math.abs(s.canvas.height / s.canvas.cssHeight - ratio) < 0.01, 'aspect distorted');
    assert(s.state === 'playing' && s.distance >= before.distance && s.runsStarted === before.runsStarted, 'run restarted on resize');
    await page.setViewportSize({ width: 1280, height: 720 });
    await sleep(200);
  });

  let finalScore = 0;
  await check('7/12. collision ends the run and game over appears exactly once', async () => {
    await page.evaluate(() => window.__NEON_RUSH__.setInvulnerable(false));
    const s = await waitState(page, 'gameover', 60000);
    finalScore = s.score;
    await page.waitForSelector('#screen-over:not([hidden])', { timeout: 3000 });
    await sleep(1500);
    const s2 = await snap(page);
    assert(s2.gameOverCount === 1, `gameOverCount ${s2.gameOverCount}`);
    assert(s2.distance === s.distance, 'world advanced after crash');
    const shown = await page.textContent('#over-score');
    assert(Number(shown.replace(/,/g, '')) === finalScore, `summary ${shown} vs ${finalScore}`);
    await page.screenshot({ path: join(OUT, 'desktop-gameover.png') });
  });

  await check('13. restart creates a clean round with a single loop', async () => {
    const before = await rafRateProbe(page);
    for (let i = 0; i < 3; i++) {
      await page.click('#btn-restart').catch(async () => page.click('#btn-restart-pause'));
      await waitState(page, 'ready', 2000);
      const s = await snap(page);
      assert(s.distance === 0 && s.score === 0 && s.orbs === 0 && s.lane === 1 && s.alive, 'round not reset');
      await waitState(page, 'playing', 3000);
      await page.keyboard.press('Escape');
      await waitState(page, 'paused', 1000);
    }
    const after = await rafRateProbe(page);
    assert(after.rafPerSec < before.rafPerSec * 1.5 + 5, `rAF rate grew ${before.rafPerSec.toFixed(0)} -> ${after.rafPerSec.toFixed(0)}`);
    const s = await snap(page);
    assert(s.gameOverCount === 1, 'unexpected extra game over');
    await page.click('#btn-menu-pause');
    await waitState(page, 'menu', 1000);
    const menu = await rafRateProbe(page);
    assert(menu.rafPerSec < before.rafPerSec * 1.5 + 5, 'loop duplicated after returning to menu');
  });

  await check('14. best score persists after refresh', async () => {
    await page.reload();
    await page.waitForSelector('#screen-menu:not([hidden])');
    const best = Number((await page.textContent('#stat-best')).replace(/,/g, ''));
    assert(best === finalScore, `best ${best} vs ${finalScore}`);
    const runs = Number(await page.textContent('#stat-runs'));
    assert(runs === 1, `runs ${runs}`);
  });

  await check('15. sound preferences persist', async () => {
    await page.click('#btn-settings');
    await page.fill('#set-music', '30');
    await page.click('#panel-settings label.switch:has(#set-sound)');
    assert(await page.isDisabled('#set-music'), 'volume should be disabled while muted');
    await page.click('#panel-settings [data-close]');
    await page.reload();
    await page.waitForSelector('#screen-menu:not([hidden])');
    const sound = await page.isChecked('#set-sound');
    const music = await page.inputValue('#set-music');
    assert(sound === false, 'sound toggle not persisted');
    assert(music === '30', `music ${music}`);
    const raw = await page.evaluate(() => JSON.parse(localStorage.getItem('neon-rush:save')));
    assert(raw.version === 1 && raw.settings.sound === false, 'save format');
    // restore
    await page.click('#btn-settings');
    await page.click('#panel-settings label.switch:has(#set-sound)');
    await page.keyboard.press('Escape');
  });

  await check('17. audio unlocks only after a gesture and failures never break play', async () => {
    await page.reload();
    await page.waitForSelector('#screen-menu:not([hidden])');
    const pre = await snap(page);
    assert(!pre.audioUnlocked, 'audio running before any gesture');
    await page.click('#btn-play');
    await waitState(page, 'playing', 4000);
    const post = await snap(page);
    console.log(`        (audio unlocked after click: ${post.audioUnlocked})`);
    await page.keyboard.press('Escape');
  });

  await desk.close();

  // ---------------- mobile portrait, touch ----------------
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const mpage = await mob.newPage();
  trackRequests(mpage, requests);
  trackErrors(mpage, errors);
  await mpage.goto(`${GAME_URL}?debug=1&seed=7`);
  const cdp = await mob.newCDPSession(mpage);
  const swipe = async (x0, y0, x1, y1, steps = 8) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  await check('mobile portrait menu renders', async () => {
    await mpage.waitForSelector('#screen-menu:not([hidden])');
    await sleep(500);
    await mpage.screenshot({ path: join(OUT, 'mobile-menu.png') });
    const s = await snap(mpage);
    assert(s.canvas.width <= 390 * 2 + 1, `DPR not capped: ${s.canvas.width}`);
  });

  await check('4. touch swipes work (one action per gesture)', async () => {
    await mpage.tap('#btn-play');
    await waitState(mpage, 'playing', 4000);
    await mpage.evaluate(() => window.__NEON_RUSH__.setInvulnerable(true));
    await swipe(200, 600, 40, 600, 12); // long swipe left: exactly one lane
    let s = await waitFor(mpage, (x) => x.x === 0, 'swipe left');
    await sleep(150);
    s = await snap(mpage);
    assert(s.lane === 0, `lane ${s.lane}`);
    await swipe(100, 600, 380, 600, 12);
    s = await waitFor(mpage, (x) => x.x === 1, 'swipe right');
    await sleep(150);
    assert((await snap(mpage)).lane === 1, 'long swipe moved more than one lane');
    await swipe(200, 650, 200, 450);
    await waitFor(mpage, (x) => x.airborne, 'swipe up jump', 800);
    await waitFor(mpage, (x) => !x.airborne, 'land', 2000);
    await swipe(200, 450, 200, 650);
    await waitFor(mpage, (x) => x.sliding, 'swipe down slide', 800);
    const scroll = await mpage.evaluate(() => window.scrollY);
    assert(scroll === 0, 'page scrolled during swipes');
    await sleep(400);
    await mpage.screenshot({ path: join(OUT, 'mobile-gameplay.png') });
  });

  await check('touch: on-screen buttons option', async () => {
    await mpage.tap('#btn-pause');
    await waitState(mpage, 'paused', 1000);
    await mpage.tap('#btn-settings-pause');
    await mpage.tap('#panel-settings label.switch:has(#set-touch)');
    await mpage.tap('#panel-settings [data-close]');
    await mpage.tap('#btn-resume');
    await waitState(mpage, 'playing', 3000);
    assert(await mpage.isVisible('#touchpad'), 'touchpad hidden');
    const lane0 = (await snap(mpage)).lane;
    await mpage.tap('[data-action="right"]');
    await waitFor(mpage, (x) => x.lane === Math.min(2, lane0 + 1), 'pad right', 800);
    await mpage.screenshot({ path: join(OUT, 'mobile-touchpad.png') });
  });

  await check('mobile landscape layout keeps all lanes and HUD', async () => {
    await mpage.setViewportSize({ width: 844, height: 390 });
    await sleep(300);
    const s = await snap(mpage);
    assert(s.canvas.cssWidth === 844 && s.state === 'playing', 'landscape resize');
    await mpage.screenshot({ path: join(OUT, 'mobile-landscape.png') });
    await mpage.evaluate(() => window.__NEON_RUSH__.setInvulnerable(false));
    await waitState(mpage, 'gameover', 60000);
    await mpage.waitForSelector('#screen-over:not([hidden])');
    await mpage.screenshot({ path: join(OUT, 'mobile-landscape-gameover.png') });
    await mpage.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    await mpage.screenshot({ path: join(OUT, 'mobile-gameover.png') });
  });
  await mob.close();

  // ---------------- storage unavailable ----------------
  await check('16. game works when localStorage is unavailable (+ reduced motion)', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    });
    const p = await ctx.newPage();
    const errs = [];
    trackErrors(p, errs);
    trackRequests(p, requests);
    await p.goto(`${GAME_URL}?debug=1&seed=3`);
    await p.waitForSelector('#screen-menu:not([hidden])');
    const s = await snap(p);
    assert(!s.storageAvailable, 'storage reported available');
    assert(s.reducedMotion, 'system reduced-motion preference not applied');
    await p.click('#btn-settings');
    assert(await p.isVisible('#storage-note'), 'storage note hidden');
    await p.keyboard.press('Escape');
    await p.click('#btn-play');
    await waitState(p, 'playing', 4000);
    await waitState(p, 'gameover', 60000);
    await p.waitForSelector('#screen-over:not([hidden])');
    await p.click('#btn-menu-over');
    await waitState(p, 'menu');
    const best = await p.textContent('#stat-best');
    assert(best !== '0', 'session best not kept in memory');
    assert(errs.length === 0, `errors: ${errs.join('; ')}`);
    await ctx.close();
  });

  // ---------------- cross-origin iframe ----------------
  await check('20. playable inside a cross-origin iframe', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 } });
    const p = await ctx.newPage();
    trackRequests(p, requests);
    const errs = [];
    trackErrors(p, errs);
    await p.goto(PARENT_ORIGIN + '/');
    const handle = await p.waitForSelector('#game');
    const frame = await handle.contentFrame();
    await frame.waitForSelector('#screen-menu:not([hidden])');
    const blocked = await p.evaluate(() => {
      try {
        return document.getElementById('game').contentWindow.document && 'accessible';
      } catch {
        return 'blocked';
      }
    });
    assert(blocked === 'blocked', 'frame is not cross-origin');
    await frame.click('#btn-play');
    await waitState(frame, 'playing', 4000);
    await frame.evaluate(() => window.__NEON_RUSH__.setInvulnerable(true));
    await p.keyboard.press('ArrowLeft');
    await waitFor(frame, (x) => x.lane === 0, 'iframe keyboard', 1000);
    const s = await snap(frame);
    assert(s.canvas.cssWidth === 900 && s.canvas.cssHeight === 560, `iframe size ${s.canvas.cssWidth}x${s.canvas.cssHeight}`);
    await sleep(300);
    await p.screenshot({ path: join(OUT, 'iframe-gameplay.png') });
    await frame.click('#btn-pause');
    await waitState(frame, 'paused');
    await frame.click('#btn-menu-pause');
    await waitState(frame, 'menu');
    assert(p.url() === PARENT_ORIGIN + '/', 'parent navigated');
    assert(await p.isVisible('#parent-marker'), 'parent page replaced');
    const fsVisible = await frame.isVisible('#btn-fullscreen');
    console.log(`        (fullscreen button inside iframe with allow="fullscreen": ${fsVisible})`);
    assert(errs.length === 0, `errors: ${errs.join('; ')}`);
    await ctx.close();
  });

  // ---------------- network / ads ----------------
  await check('21. no advertising scripts or third-party requests', async () => {
    const external = requests.filter((u) => !u.startsWith(GAME_ORIGIN) && !u.startsWith(PARENT_ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:'));
    assert(external.length === 0, `external requests: ${external.join(', ')}`);
    const ads = requests.filter((u) => AD_PATTERN.test(u));
    assert(ads.length === 0, `ad requests: ${ads.join(', ')}`);
    const files = [];
    const walk = async (dir) => {
      for (const name of await readdir(dir)) {
        const full = join(dir, name);
        if ((await stat(full)).isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(DIST);
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      assert(!AD_PATTERN.test(text), `ad-related code found in ${f}`);
      assert(!/localhost|127\.0\.0\.1/.test(text), `hardcoded local URL in ${f}`);
    }
    console.log(`        (${requests.length} requests, all same-origin; ${files.length} dist files scanned)`);
  });

  await check('no uncaught page errors', async () => {
    assert(errors.length === 0, errors.join('\n'));
  });

  await browser.close();
  gameServer.close();
  parentServer.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed. Screenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
