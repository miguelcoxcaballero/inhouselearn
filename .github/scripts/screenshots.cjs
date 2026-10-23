// Real screenshots of the app for the chat (workflow "App screenshots",
// engine/src/github.js → github_screenshot). Chromium opens the page of the
// commit being photographed (served from ./app on 127.0.0.1:8765), with
// OpenRouter mocked like tests/web, replays an optional conversation through
// the real renderer, runs the optional steps and takes each picture.
//
//   SHOTS='[{"name":"menu","device":"phone","theme":"dark","steps":[{"click":"#plus-btn"}]}]' \
//   ID=shot-test node .github/scripts/screenshots.cjs
//
// A shot: { name, device: phone|tablet|desktop, theme: light|dark,
//   messages: [{ user, assistant }], steps: [{ click | fill: [sel, text] |
//   press | wait | scroll | eval }], selector (photograph one element),
//   fullPage }. Writes out/<ID>/<n>-<name>.png and out/<ID>/manifest.json.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { openApp, idle } = require('../../tests/web/mock.cjs');

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
const outDir = path.join('out', id);
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
      app = await openApp(browser, Object.assign({ colorScheme: theme }, DEVICES[device]));
      const page = app.page;
      // The app's own setting, so «Auto» and the stored choice agree.
      await page.evaluate((value) => { try { localStorage.setItem('inhouselearn.theme', value); } catch (_) {} }, theme);
      await page.reload({ waitUntil: 'load' });
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
      for (const step of (Array.isArray(shot.steps) ? shot.steps : []).slice(0, 20)) await runStep(page, step || {});
      await page.waitForTimeout(400);
      const target = shot.selector ? page.locator(String(shot.selector)).first() : null;
      if (target) await target.screenshot({ path: path.join(outDir, file), timeout: STEP_TIMEOUT });
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
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ id, ref: process.env.REF || '', at: new Date().toISOString(), shots: manifest }, null, 2));
  if (!manifest.some((entry) => entry.file)) { console.log('::error::No screenshot could be taken'); process.exit(1); }
})();
