// The sandboxes (run_js and doc_edit) have no network at all: not even through
// the prototype of the worker's global scope, where the real fetch lives. And
// a stalled download of the maths libraries never holds run_js: it answers
// without them after a few seconds, and Stop ends it at once.
const { chromium } = require('playwright');
const { openApp } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

const PROBE = "let o = self, found = []; while (o) { for (const n of ['fetch', 'importScripts', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker']) { const d = Object.getOwnPropertyDescriptor(o, n); if (d && typeof (d.value || d.get) === 'function') found.push(n); } o = Object.getPrototypeOf(o); } return found;";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 900, height: 700 } });
  // The maths libraries never answer (a stalled mobile link or captive portal).
  await page.context().route(/cdn\.jsdelivr\.net\/npm\/(mathjs|algebrite)/, () => {});

  const t0 = Date.now();
  const stalled = await page.evaluate(async () => { const out = await InhousePi.runInSandbox('return 1 + 1', {}); return out.result; });
  const waited = Date.now() - t0;
  check('a stalled library download does not hold run_js (answers without it in a few seconds)', stalled === '2' && waited < 7000, { stalled, waited });

  const stopped = await page.evaluate(async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = InhousePi.runInSandbox('return 3', {}, controller.signal);
    setTimeout(() => controller.abort(), 300);
    const out = await pending;
    return { error: out.error, ms: Date.now() - started };
  });
  check('Stop ends a run_js that is still waiting for the libraries', /Cancelado/.test(stopped.error || '') && stopped.ms < 2000, stopped);

  const reachable = await page.evaluate(async (probe) => JSON.parse((await InhousePi.runInSandbox(probe, {})).result), PROBE);
  check('run_js: no network function is reachable, not even on the prototype chain', Array.isArray(reachable) && reachable.length === 0, reachable);

  const docs = await page.evaluate(async (probe) => { const out = await window.InhouseDocs.run(probe, { list: async () => [], open: async () => null }); return out.result ? JSON.parse(out.result) : out; }, PROBE);
  check('doc_edit: no network function is reachable either', Array.isArray(docs) && docs.length === 0, docs);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
