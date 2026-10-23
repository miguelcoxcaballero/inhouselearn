// Real screenshots for the chat (workflow "App screenshots",
// engine/src/github.js → github_screenshot), of any web page: Chromium opens
// URL (a public address) or the project served on 127.0.0.1:8765 (by the
// workflow), runs the optional steps and takes each picture. Inhouse Learn
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
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

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
const STEP_TIMEOUT = 8000;

const id = String(process.env.ID || '');
if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) throw new Error('ID must be 1-60 letters, digits, . _ -');
let shots = [];
try { shots = JSON.parse(process.env.SHOTS || '[]'); } catch (error) { throw new Error('SHOTS is not valid JSON: ' + error.message); }
if (!Array.isArray(shots) || !shots.length) throw new Error('SHOTS must be a non-empty list');
shots = shots.slice(0, MAX_SHOTS);
const outDir = path.join(process.env.OUT || 'out', id);
fs.mkdirSync(outDir, { recursive: true });

const slug = (text) => String(text || 'captura').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'captura';

async function runStep(page, step) {
  if (step.click) await page.click(String(step.click), { timeout: STEP_TIMEOUT });
  else if (step.fill) await page.fill(String(step.fill[0]), String(step.fill[1] || ''), { timeout: STEP_TIMEOUT });
  else if (step.press) await page.keyboard.press(String(step.press));
  else if (step.scroll) await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center' }); }, String(step.scroll));
  else if (step.eval) await page.evaluate((code) => Promise.resolve((0, eval)(code)), String(step.eval));
  if (step.wait) await page.waitForTimeout(Math.min(5000, Number(step.wait) || 0));
  else await page.waitForTimeout(250);
}

// Any other page: the device, the colour scheme, and the page fully loaded.
async function openPage(browser, theme, device, where) {
  const context = await browser.newContext(Object.assign({ colorScheme: theme }, DEVICES[device]));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(new URL(String(where || ''), SITE).href, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { page, errors, context };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const manifest = [];
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i] || {};
    const name = slug(shot.name || 'captura-' + (i + 1));
    const device = DEVICES[shot.device] ? shot.device : 'phone';
    const theme = shot.theme === 'dark' ? 'dark' : 'light';
    const file = (i + 1) + '-' + name + '.png';
    const entry = { name: String(shot.name || name).slice(0, 80), file, device, theme };
    let app = null;
    try {
      if (learn) {
        app = await openApp(browser, Object.assign({ colorScheme: theme }, DEVICES[device]));
        const page = app.page;
        // The app's own setting, so «Auto» and the stored choice agree.
        await page.evaluate((value) => { try { localStorage.setItem('inhouselearn.theme', value); } catch (_) {} }, theme);
        if (shot.path) await page.goto(new URL(String(shot.path), process.env.BASE_URL).href, { waitUntil: 'load' });
        else await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => typeof runAssistantTurn === 'function');
        await page.waitForTimeout(600);
        // A conversation drawn by the real renderer (the model's answers are mocked).
        for (const turn of (Array.isArray(shot.messages) ? shot.messages : []).slice(0, 6)) {
          if (!turn || !turn.user) continue;
          await page.evaluate((text) => window.__replies.push({ text, chunk: 400, delay: 0 }), String(turn.assistant || 'Vale.'));
          await page.fill('#composer', String(turn.user));
          await page.click('#send-btn');
          await idle(page, 20000);
        }
      } else {
        app = await openPage(browser, theme, device, shot.path);
      }
      const page = app.page;
      for (const step of (Array.isArray(shot.steps) ? shot.steps : []).slice(0, 20)) await runStep(page, step || {});
      await page.waitForTimeout(400);
      const element = shot.selector ? page.locator(String(shot.selector)).first() : null;
      if (element) await element.screenshot({ path: path.join(outDir, file), timeout: STEP_TIMEOUT });
      else await page.screenshot({ path: path.join(outDir, file), fullPage: !!shot.fullPage });
      const errors = app.errors.filter((e) => !/initScript/.test(e));
      if (errors.length) entry.pageErrors = errors.slice(0, 3);
      console.log('shot', file);
    } catch (error) {
      entry.error = String(error && error.message || error).split('\n')[0].slice(0, 300);
      entry.file = null;
      console.log('::warning::' + name + ': ' + entry.error);
    } finally {
      if (app) await app.context.close().catch(() => {});
    }
    manifest.push(entry);
  }
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ id, target: pageUrl || target, ref: process.env.REF || '', at: new Date().toISOString(), shots: manifest }, null, 2));
  if (!manifest.some((entry) => entry.file)) { console.log('::error::No screenshot could be taken'); process.exit(1); }
})();
