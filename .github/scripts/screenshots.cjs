// Real screenshots for the chat (workflow "App screenshots",
// engine/src/github.js → github_screenshot), of any web page: Chromium opens
// URL (a public address) or the project served on 127.0.0.1:8765 (by
// shoot.sh), runs the optional steps and takes each picture. Inhouse Learn
// itself (TARGET miguelcoxcaballero/inhouselearn) opens with OpenRouter mocked
// like tests/web, so a conversation can be replayed through the real renderer.
//
//   SHOTS='[{"name":"menu","device":"phone","theme":"dark","steps":[{"click":"#plus-btn"}]}]' \
//   ID=shot-test TARGET=owner/repo node .github/scripts/screenshots.cjs
//
// A shot: { name, path (page to open, relative to the site, e.g. "about.html"
//   or "#/settings"), device: phone|tablet|desktop, theme: light|dark,
//   messages: [{ user, assistant }] (Inhouse Learn only), steps: [{ click |
//   fill: [sel, text] | press | wait | scroll | eval }], selector (photograph
//   one element), fullPage }. Writes $OUT/<ID>/<n>-<name>.png and manifest.json.
//
// Never hangs and never loses what it got: shots run 3 at a time, each has a
// hard limit (SHOT_MS), the whole script one more (DEADLINE_MS), a failing step
// still photographs the screen as it is (marked with its error), and the
// manifest is always written. Exit 3 only when the browser cannot start with
// $CHROMIUM (the runner's Chrome), so shoot.sh retries with Playwright's own.
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { ({ chromium } = require('playwright')); }

const LEARN = 'miguelcoxcaballero/inhouselearn';
const target = String(process.env.TARGET || '');
const pageUrl = String(process.env.URL || '');
const learn = !pageUrl && target.toLowerCase() === LEARN;
const SITE = pageUrl || 'http://127.0.0.1:8765/';
if (learn && !process.env.BASE_URL) process.env.BASE_URL = SITE + 'index.html';
const { openApp, idle } = learn ? require('../../tests/web/mock.cjs') : {};

const DEVICES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
};
const MAX_SHOTS = 6;
const PARALLEL = 3;
const STEP_TIMEOUT = 8000;
const SHOT_MS = Number(process.env.SHOT_MS) || 75000;
const DEADLINE_MS = Number(process.env.DEADLINE_MS) || 240000;

const id = String(process.env.ID || '');
if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) throw new Error('ID must be 1-60 letters, digits, . _ -');
let shots = [];
try { shots = JSON.parse(process.env.SHOTS || '[]'); } catch (error) { throw new Error('SHOTS is not valid JSON: ' + error.message); }
if (!Array.isArray(shots) || !shots.length) throw new Error('SHOTS must be a non-empty list');
shots = shots.slice(0, MAX_SHOTS);
const outDir = path.join(process.env.OUT || 'out', id);
fs.mkdirSync(outDir, { recursive: true });

const slug = (text) => String(text || 'captura').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'captura';
const firstLine = (error) => String(error && error.message || error).split('\n')[0].slice(0, 300);

function limit(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' took longer than ' + Math.round(ms / 1000) + ' s')), ms); })
  ]).finally(() => clearTimeout(timer));
}

const manifest = shots.map((shot, i) => {
  const device = DEVICES[shot && shot.device] ? shot.device : 'phone';
  const theme = shot && shot.theme === 'dark' ? 'dark' : 'light';
  const name = slug((shot && shot.name) || 'captura-' + (i + 1));
  return { name: String((shot && shot.name) || name).slice(0, 80), file: null, device, theme, error: 'not reached before the time limit', _file: (i + 1) + '-' + name + '.png' };
});
const started = Date.now();
let written = false;
function writeManifest() {
  if (written) return;
  written = true;
  const clean = manifest.map(({ _file, ...entry }) => entry);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ id, target: pageUrl || target, ref: process.env.REF || '', at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), shots: clean }, null, 2));
}
// Whatever happens, the manifest is written before the job's own limits.
const deadline = setTimeout(() => { console.log('::warning::Time limit: publishing what is done'); writeManifest(); process.exit(0); }, DEADLINE_MS);

function describeStep(step, n) {
  const what = step.click ? 'click ' + step.click : step.fill ? 'fill ' + step.fill[0] : step.press ? 'press ' + step.press : step.scroll ? 'scroll ' + step.scroll : step.eval ? 'eval' : 'wait';
  return 'step ' + n + ' (' + String(what).slice(0, 80) + ')';
}

async function runStep(page, step) {
  if (step.click) await page.click(String(step.click), { timeout: STEP_TIMEOUT });
  else if (step.fill) await page.fill(String(step.fill[0]), String(step.fill[1] || ''), { timeout: STEP_TIMEOUT });
  else if (step.press) await page.keyboard.press(String(step.press));
  else if (step.scroll) await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center' }); }, String(step.scroll));
  else if (step.eval) await limit(page.evaluate((code) => Promise.resolve((0, eval)(code)), String(step.eval)), STEP_TIMEOUT, 'eval');
  await page.waitForTimeout(step.wait ? Math.min(5000, Number(step.wait) || 0) : 150);
}

// Any other page: the device, the colour scheme, and the page loaded (not
// waiting for every last request: some pages never go quiet).
async function openPage(browser, theme, device, where) {
  const context = await browser.newContext(Object.assign({ colorScheme: theme }, DEVICES[device]));
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const errors = [];
  const app = { page, errors, context };
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(new URL(String(where || ''), SITE).href, { waitUntil: 'load', timeout: 30000 }).catch(async (error) => {
    // A slow third-party resource: what has loaded is usually enough to see.
    if (!/Timeout/i.test(String(error && error.message))) throw error;
    app.note = 'the page did not finish loading in 30 s';
  });
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  return app;
}

// Inhouse Learn: the stored theme set before the first paint (no reload).
async function openLearn(browser, theme, device, where) {
  const init = 'try { localStorage.setItem("inhouselearn.theme", ' + JSON.stringify(theme) + '); } catch (_) {}';
  const app = await openApp(browser, Object.assign({ colorScheme: theme }, DEVICES[device]), { init });
  app.context.setDefaultTimeout(15000);
  if (where) {
    await app.page.goto(new URL(String(where), process.env.BASE_URL).href, { waitUntil: 'load', timeout: 30000 });
    await app.page.waitForFunction(() => typeof runAssistantTurn === 'function', null, { timeout: 20000 });
    await app.page.waitForTimeout(400);
  }
  return app;
}

async function takeShot(browser, shot, i) {
  const entry = manifest[i];
  const file = entry._file;
  const holder = {};
  const problems = [];
  const work = (async () => {
    holder.app = learn ? await openLearn(browser, entry.theme, entry.device, shot.path) : await openPage(browser, entry.theme, entry.device, shot.path);
    if (holder.app.note) problems.push(holder.app.note);
    const page = holder.app.page;
    // A conversation drawn by the real renderer (the model's answers are mocked).
    if (learn) {
      for (const turn of (Array.isArray(shot.messages) ? shot.messages : []).slice(0, 6)) {
        if (!turn || !turn.user) continue;
        await page.evaluate((text) => window.__replies.push({ text, chunk: 400, delay: 0 }), String(turn.assistant || 'Vale.'));
        await page.fill('#composer', String(turn.user));
        await page.click('#send-btn');
        await idle(page, 15000);
      }
    }
    const steps = (Array.isArray(shot.steps) ? shot.steps : []).slice(0, 20);
    for (let n = 0; n < steps.length; n++) {
      try { await runStep(page, steps[n] || {}); } catch (error) {
        problems.push(describeStep(steps[n] || {}, n + 1) + ': ' + firstLine(error));
        break;
      }
    }
    await page.waitForTimeout(250);
  })();
  work.catch(() => {});
  try { await limit(work, SHOT_MS, 'this picture'); } catch (error) { problems.push(firstLine(error)); }
  const app = holder.app;
  try {
    if (!app) throw new Error(problems[0] || 'the page did not open');
    const out = path.join(outDir, file);
    const element = shot.selector ? app.page.locator(String(shot.selector)).first() : null;
    if (element && await element.count().catch(() => 0)) await limit(element.screenshot({ path: out, timeout: 10000 }), 15000, 'the picture');
    else {
      if (element) problems.push('selector ' + String(shot.selector).slice(0, 80) + ' not found: whole screen instead');
      await limit(app.page.screenshot({ path: out, fullPage: !!shot.fullPage, timeout: 10000 }), 15000, 'the picture');
    }
    entry.file = file;
    console.log('shot', file, problems.length ? '(with problems)' : '');
  } catch (error) {
    entry.file = null;
    if (!problems.length) problems.push(firstLine(error));
    console.log('::warning::' + entry.name + ': ' + problems.join(' | '));
  }
  if (problems.length) entry.error = problems.join(' | ').slice(0, 400); else delete entry.error;
  const errors = app ? app.errors.filter((e) => !/initScript/.test(e)) : [];
  if (errors.length) entry.pageErrors = errors.slice(0, 3).map((e) => String(e).slice(0, 300));
  if (app) await limit(app.context.close(), 5000, 'closing').catch(() => {});
}

(async () => {
  let browser;
  try {
    browser = await limit(chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--disable-dev-shm-usage'] }), 30000, 'starting the browser');
  } catch (error) {
    console.log('::warning::The browser did not start: ' + firstLine(error));
    if (process.env.CHROMIUM) process.exit(3);
    manifest.forEach((entry) => { entry.error = 'the browser did not start: ' + firstLine(error); });
    writeManifest();
    process.exit(0);
  }
  console.log('browser ready in', Date.now() - started, 'ms');
  let next = 0;
  const worker = async () => { while (next < shots.length) { const i = next++; await takeShot(browser, shots[i] || {}, i); } };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, shots.length) }, worker));
  clearTimeout(deadline);
  writeManifest();
  await limit(browser.close(), 5000, 'closing the browser').catch(() => {});
  console.log('done in', Date.now() - started, 'ms:', manifest.filter((entry) => entry.file).length, 'of', manifest.length);
  process.exit(0);
})().catch((error) => {
  console.log('::error::' + firstLine(error));
  manifest.forEach((entry) => { if (!entry.file) entry.error = firstLine(error); });
  writeManifest();
  process.exit(0);
});
