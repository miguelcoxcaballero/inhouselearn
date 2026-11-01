// The model picker shows an intelligence dial for every model OpenRouter says anything about, and says
// so for the rest. OpenRouter publishes Artificial Analysis' number for only some models: the Claude
// model of the user's own key takes its OpenRouter twin's score, two entries of one model (a «:free»
// copy) share theirs, a model with only coding/agentic scores, or only Design Arena's, gets a marked
// estimate («~») worked out from the models that do have the number (never extended beyond their
// range), and a model with no benchmark at all gets a dotted dial and a dash (nothing is invented).
// Estimates also count for the order «Más inteligentes», and a list cached before the engine kept
// Design Arena is fetched again.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { SCRATCH } = require('./mock.cjs');

const arenaOf = (mean) => ['3d', 'svg', 'website', 'uicomponent'].map((category, i) => ({ arena: 'models', category, elo: mean + (i - 1.5) * 10, win_rate: 50, rank: 10 + i }));
const bench = (iq, coding, agentic, arena) => Object.assign({ artificial_analysis: { intelligence_index: iq, coding_index: coding, agentic_index: agentic } }, arena ? { design_arena: arenaOf(arena) } : {});
const listed = (id, name, benchmarks, extra) => Object.assign({ id, name, supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000003', completion: '0.000004' }, benchmarks }, extra);
// 14 models where intelligence ≈ 0.7 · agentic + 1 and Design Arena's mean Elo grows with them (1050 … 1310).
const known = Array.from({ length: 14 }, (_, i) => { const agentic = 5 + i * 4; return listed('acme/m-' + i, 'Acme: Modelo ' + i, bench(Math.round((0.7 * agentic + 1) * 10) / 10, Math.round(agentic * 0.9 + 30), agentic, 1050 + i * 20), { canonical_slug: 'acme/m-' + i + '-20260101' }); });
const data = known.concat([
  listed('acme/m-3:free', 'Acme: Modelo 3 (gratis)', undefined, { canonical_slug: 'acme/m-3-20260101' }),
  listed('acme/estimado', 'Acme: Estimado', bench(null, 66, 40)),
  listed('acme/solo-arena', 'Acme: Solo Arena', { design_arena: arenaOf(1150) }),
  listed('acme/arena-lejos', 'Acme: Arena Lejos', { design_arena: arenaOf(600) }),
  listed('acme/sin-datos', 'Acme: Sin datos', undefined),
  listed('anthropic/claude-opus-5.5', 'Anthropic: Claude Opus 5.5', bench(58.4, null, null)),
  listed('anthropic/claude-haiku-5.5', 'Anthropic: Claude Haiku 5.5', bench(36.2, null, null)),
  listed('anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', bench(null, 71.5, 43.6)),
  listed('deepseek/deepseek-v4.1-flash', 'DeepSeek: V4.1 Flash', undefined)
]);
const models = path.join(SCRATCH, 'models-scores.json');
fs.writeFileSync(models, JSON.stringify({ data }));
process.env.MODELS_JSON = models;
const { openApp } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 600) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 1100 } });
  await page.waitForFunction(() => modelCatalog.entries.length > 15, null, { timeout: 20000 });
  const rows = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('.model-card')).map((card) => {
    const gauge = card.querySelector('.model-gauge');
    return [card.dataset.modelId, { gauge: !!gauge, num: gauge ? card.querySelector('.model-gauge-num').textContent : '', est: !!(gauge && gauge.classList.contains('est')), none: !!(gauge && gauge.classList.contains('none')), icon: card.querySelector('.model-card-icon img') ? 'logo' : 'letter', title: gauge ? gauge.title : '' }];
  })));
  await page.click('#model-menu-btn');
  await page.waitForSelector('.model-card');

  // 1. OpenRouter's own list.
  const plain = await rows();
  check('a model with its number shows it (as before, no «~»)', plain['acme/m-3'] && plain['acme/m-3'].num === String(Math.round(0.7 * 17 + 1)) && !plain['acme/m-3'].est && plain['anthropic/claude-opus-5.5'].num === '58' && !plain['anthropic/claude-opus-5.5'].est, [plain['acme/m-3'], plain['anthropic/claude-opus-5.5']]);
  const estimated = plain['acme/estimado'];
  check('a model with only coding/agentic scores gets an estimate: «~29», drawn fainter, its tooltip says why', estimated && estimated.est && /^~[0-9]+$/.test(estimated.num) && Math.abs(Number(estimated.num.slice(1)) - 29) <= 2 && /estimado/.test(estimated.title) && /agentes/.test(estimated.title), estimated);
  const arena = plain['acme/solo-arena'];
  check('a model with only Design Arena (the other benchmark OpenRouter publishes) gets an estimate too, and its tooltip names it and its typical error', arena && arena.est && /^~[0-9]+$/.test(arena.num) && Math.abs(Number(arena.num.slice(1)) - 18.5) <= 3 && /Design Arena/.test(arena.title) && /±/.test(arena.title), arena);
  check('a model outside the range the estimate was made on gets none: a dotted dial and a dash, not a made-up number', plain['acme/arena-lejos'] && plain['acme/arena-lejos'].none && plain['acme/arena-lejos'].num === '—' && !plain['acme/arena-lejos'].est && /todavía no publica/.test(plain['acme/arena-lejos'].title), plain['acme/arena-lejos']);
  check('a model with no benchmark at all is marked the same way («sin benchmark»), e.g. DeepSeek V4.1 Flash', plain['acme/sin-datos'].none && plain['acme/sin-datos'].num === '—' && plain['deepseek/deepseek-v4.1-flash'].none && plain['deepseek/deepseek-v4.1-flash'].num === '—', [plain['acme/sin-datos'], plain['deepseek/deepseek-v4.1-flash']]);
  check('the «:free» copy of a model takes the exact number of the entry that has it (no «~»)', plain['acme/m-3:free'] && plain['acme/m-3:free'].num === plain['acme/m-3'].num && !plain['acme/m-3:free'].est && !plain['acme/m-3:free'].none, plain['acme/m-3:free']);
  check('every row has its dial or its marker: nothing is left blank by accident', Object.values(plain).length > 20 && Object.values(plain).every((row) => row.gauge), Object.entries(plain).filter(([, row]) => !row.gauge).map(([id]) => id));
  check('every row keeps its icon (a logo, or the company\'s letter)', Object.values(plain).every((row) => row.icon === 'logo' || row.icon === 'letter') && plain['acme/m-3'].icon === 'letter' && plain['anthropic/claude-opus-5.5'].icon === 'logo', plain['acme/m-3']);

  // 2. With the user's own Claude key the copies built by the app get their twin's scores.
  await page.evaluate(() => { saveApiSettings({ apiKey: 'sk-or-test', anthropicKey: 'sk-ant-api03-test' }); applyClaudeModels(); });
  await page.waitForSelector('.model-card[data-model-id="claude-api/claude-opus-5-5"]');
  const claude = await rows();
  check('the Claude models of your own key show their number again (their OpenRouter twin\'s)', claude['claude-api/claude-opus-5-5'] && claude['claude-api/claude-opus-5-5'].num === '58' && !claude['claude-api/claude-opus-5-5'].est && claude['claude-api/claude-haiku-5-5'].num === '36' && claude['claude-api/claude-opus-5-5'].icon === 'logo', [claude['claude-api/claude-opus-5-5'], claude['claude-api/claude-haiku-5-5']]);
  check('…and one whose twin only has coding/agentic gets the estimate (~32)', claude['claude-api/claude-sonnet-5-5'] && claude['claude-api/claude-sonnet-5-5'].est && Math.abs(Number(claude['claude-api/claude-sonnet-5-5'].num.slice(1)) - 32) <= 2, claude['claude-api/claude-sonnet-5-5']);

  // 3. The estimate counts for the order and the filter, and the cached list is not changed by it.
  await page.evaluate(() => { modelPicker.sort = 'smart'; renderModelControls(); });
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('.model-card')).map((card) => card.dataset.modelId));
  check('«Más inteligentes» puts the estimated model among the numbered ones, above the ones without a benchmark', order.indexOf('acme/estimado') > -1 && order.indexOf('acme/estimado') < order.indexOf('acme/sin-datos') && order.indexOf('acme/solo-arena') < order.indexOf('acme/arena-lejos') && order.indexOf('claude-api/claude-opus-5-5') < order.indexOf('acme/estimado'), order.slice(0, 14));
  const cached = await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || 'null'); const entry = saved && saved.entries.find((item) => item.id === 'acme/estimado'); const solo = saved && saved.entries.find((item) => item.id === 'acme/solo-arena'); return { cached: !!entry, intelligence: entry ? entry.intelligence : 'none', flag: entry ? !!entry.iqEstimated : null, arena: solo ? solo.arena : 'none', soloIntelligence: solo ? solo.intelligence : 'none' }; });
  check('the saved copy of OpenRouter\'s list stays as OpenRouter gave it (no estimate written into it), with Design Arena\'s mean kept', cached.cached && cached.intelligence === null && cached.flag === false && cached.arena === 1150 && cached.soloIntelligence === null, cached);
  await page.screenshot({ path: SCRATCH + '/model-list.png' });

  // 4. A list cached before the engine kept Design Arena is not used (it is fetched again).
  const stale = await page.evaluate(() => {
    const entry = (extra) => Object.assign({ id: 'old/model', name: 'Old', company: 'Old', companyId: 'old', audio: false, images: false, video: false, files: false, tools: true, reasoning: null, price: { input: 0, output: 0 }, pricing: {}, context: 0, maxOutput: 0, rank: 0, created: 0, intelligence: null, coding: null, agentic: null }, extra);
    setModelCatalog([], 0);
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), entries: [entry({})] }));
    loadModelCatalogFromCache();
    const staleLoaded = modelCatalog.byId.has('old/model');
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), entries: [entry({ arena: null, canonical: '' })] }));
    loadModelCatalogFromCache();
    return { staleLoaded, freshLoaded: modelCatalog.byId.has('old/model') };
  });
  check('a list cached before the engine kept Design Arena is fetched again; a current one is used', !stale.staleLoaded && stale.freshLoaded, stale);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
