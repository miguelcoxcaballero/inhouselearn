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
//
// Failing fast and saying why: a page that does not exist fails at once with
// the path, the HTTP status and the .html pages that do exist (checked against
// SERVE_DIR, the served folder, before Chromium even starts); a page that
// loads but is not the app fails in seconds saying so (final URL, title, first
// page error, whether #composer / runAssistantTurn are there); later shots of
// the same failed page are not waited for again. Every reason goes to
// manifest.json (entry.error), to a ::error:: annotation with the shot's name
// and to the summary at the end.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LEARN = 'miguelcoxcaballero/inhouselearn';
const target = String(process.env.TARGET || '');
const pageUrl = String(process.env.URL || '');
const learn = !pageUrl && target.toLowerCase() === LEARN;
const SITE = pageUrl || 'http://127.0.0.1:8765/';
if (learn && !process.env.BASE_URL) process.env.BASE_URL = SITE + 'index.html';
const { openApp, prepareApp, idle } = learn ? require('../../tests/web/mock.cjs') : {};
// The folder the workflow serves on :8765 (empty for a URL or a project's own server).
const SERVE_DIR = String(process.env.SERVE_DIR || '');
const READY_TIMEOUT = 12000;

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

// Errors with a kind: 'missing' (no such page) or 'notapp' (loaded, not the app).
function failure(kind, message) {
  return Object.assign(new Error(message), { kind });
}

const shotUrl = (where) => new URL(String(where || ''), learn ? process.env.BASE_URL : SITE).href;
const pathOf = (where) => String(where || '').split(/[?#]/)[0].replace(/^\/+/, '');

function htmlPagesServed() {
  if (!SERVE_DIR) return [];
  try { return fs.readdirSync(SERVE_DIR).filter((name) => /\.html?$/i.test(name)).sort(); } catch (_) { return []; }
}

function existingPagesNote() {
  const pages = htmlPagesServed();
  return pages.length ? ' Páginas .html que sí existen en la raíz servida: ' + pages.join(', ') + '.' : '';
}

// Before Chromium: a .html path that is not in the served folder.
function missingFile(where) {
  if (!SERVE_DIR) return '';
  const file = pathOf(where) || (learn ? 'index.html' : '');
  if (!/\.html?$/i.test(file)) return '';
  const full = path.resolve(SERVE_DIR, file);
  if (!full.startsWith(path.resolve(SERVE_DIR))) return file;
  return fs.existsSync(full) ? '' : file;
}

// The answer to page.goto: anything but 2xx is a page that does not exist.
function checkResponse(response, where, url) {
  if (!response) return; // a #hash change: no new document
  if (!response.ok()) {
    throw failure('missing', 'La página «' + (pathOf(where) || '/') + '» no existe: HTTP ' + response.status() + ' en ' + url + '.' + existingPagesNote());
  }
}

// Instead of waiting 30 s for the app: a short wait, and if it is not there,
// what was loaded instead.
async function waitForApp(page, errors) {
  try {
    await page.waitForFunction(() => window.InhousePi && typeof runAssistantTurn === 'function', null, { timeout: READY_TIMEOUT });
  } catch (_) {
    const info = await page.evaluate(() => ({ url: location.href, title: document.title, composer: !!document.querySelector('#composer'), app: typeof runAssistantTurn === 'function' })).catch(() => ({ url: page.url(), title: '', composer: false, app: false }));
    const what = !info.composer && !info.app ? 'el documento no tiene #composer ni el global runAssistantTurn: no es la app'
      : !info.app ? 'tiene #composer pero no el global runAssistantTurn (la app no arrancó)'
        : 'falta window.InhousePi (el motor no cargó)';
    const firstError = errors.find((e) => !/initScript/.test(e));
    throw failure('notapp', 'La página cargó pero ' + what + ' (' + (READY_TIMEOUT / 1000) + ' s). URL final ' + info.url + ', título «' + (info.title || '') + '»' + (firstError ? ', primer error: ' + String(firstError).split('\n')[0].slice(0, 200) : ', sin errores de la página') + '.');
  }
}

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
  const url = shotUrl(where);
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  } catch (error) {
    await context.close().catch(() => {});
    throw failure('missing', 'No se pudo abrir ' + url + ': ' + String(error && error.message || error).split('\n')[0]);
  }
  try { checkResponse(response, where, url); } catch (error) { await context.close().catch(() => {}); throw error; }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { page, errors, context };
}

function annotate(name, reason) {
  console.log('::error title=' + String(name).replace(/[\r\n:,]/g, ' ') + '::' + String(reason).replace(/\r?\n/g, ' '));
}

function finish(manifest) {
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ id, target: pageUrl || target, ref: process.env.REF || '', at: new Date().toISOString(), shots: manifest }, null, 2));
  const failed = manifest.filter((entry) => !entry.file);
  const lines = [manifest.length - failed.length + ' de ' + manifest.length + ' capturas hechas.'].concat(failed.map((entry) => '· ' + entry.name + ': ' + entry.error));
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Capturas\n\n' + lines.map((line) => line.replace(/^· /, '- ')).join('\n') + '\n'); } catch (_) {}
  }
  if (failed.length === manifest.length) {
    console.log('::error::No screenshot could be taken: ' + failed.map((entry) => entry.name + ' (' + entry.error.slice(0, 120) + ')').join('; '));
    process.exit(1);
  }
}

(async () => {
  const entries = shots.map((shot, i) => {
    const name = slug(shot && shot.name || 'captura-' + (i + 1));
    return { shot: shot || {}, name, entry: { name: String(shot && shot.name || name).slice(0, 80), file: (i + 1) + '-' + name + '.png', device: DEVICES[shot && shot.device] ? shot.device : 'phone', theme: shot && shot.theme === 'dark' ? 'dark' : 'light' } };
  });
  // 1. Pages that are not in the served folder fail before Chromium starts.
  entries.forEach((item) => {
    const file = missingFile(item.shot.path);
    if (file) item.entry.error = 'La página «' + file + '» no existe en la carpeta servida (' + (path.relative(process.cwd(), SERVE_DIR) || SERVE_DIR) + ').' + existingPagesNote();
  });
  if (entries.every((item) => item.entry.error)) {
    entries.forEach((item) => { item.entry.file = null; annotate(item.entry.name, item.entry.error); });
    finish(entries.map((item) => item.entry));
    return;
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  // A page that already failed is not waited for again: same reason, at once.
  const failedPages = new Map();
  for (const item of entries) {
    const { shot, name, entry } = item;
    const { device, theme, file } = entry;
    let app = null;
    try {
      if (entry.error) throw failure('missing', entry.error);
      const url = shotUrl(shot.path);
      if (failedPages.has(url)) throw failure('missing', failedPages.get(url) + ' (no se vuelve a esperar)');
      try {
        if (learn) {
          app = await openApp(browser, Object.assign({ colorScheme: theme }, DEVICES[device]), { url, waitReady: false });
          const page = app.page;
          checkResponse(app.response, shot.path || 'index.html', url);
          // The app's own setting, so «Auto» and the stored choice agree.
          await page.evaluate((value) => { try { localStorage.setItem('inhouselearn.theme', value); } catch (_) {} }, theme);
          checkResponse(await page.reload({ waitUntil: 'load' }), shot.path || 'index.html', url);
          await waitForApp(page, app.errors);
          await prepareApp(page);
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
      } catch (error) {
        if (error && (error.kind === 'missing' || error.kind === 'notapp')) failedPages.set(url, error.message);
        throw error;
      }
      const page = app.page;
      for (const step of (Array.isArray(shot.steps) ? shot.steps : []).slice(0, 20)) await runStep(page, step || {});
      await page.waitForTimeout(400);
      const element = shot.selector ? page.locator(String(shot.selector)).first() : null;
      if (element) await element.screenshot({ path: path.join(outDir, file), timeout: STEP_TIMEOUT });
      else await page.screenshot({ path: path.join(outDir, file), fullPage: !!shot.fullPage });
      const errors = app.errors.filter((e) => !/initScript/.test(e));
      if (errors.length) entry.pageErrors = errors.slice(0, 3);
      delete entry.error;
      console.log('shot', file);
    } catch (error) {
      entry.error = String(error && error.message || error).split('\n')[0].slice(0, 500);
      entry.file = null;
      annotate(entry.name, entry.error);
    } finally {
      if (app) await app.context.close().catch(() => {});
    }
  }
  await browser.close();
  finish(entries.map((item) => item.entry));
})();
