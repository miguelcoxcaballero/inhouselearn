// The model picker keeps showing every model's speedometer and intelligence number
// even though OpenRouter now publishes that number for only some of them: the Claude
// model of the user's own key takes its OpenRouter twin's score, a model with only
// coding/agentic scores gets a marked estimate («~»), and a model with no scores at
// all shows no speedometer (nothing is invented). Estimates also count for the
// order «Más inteligentes».
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { SCRATCH } = require('./mock.cjs');

const bench = (iq, coding, agentic) => ({ artificial_analysis: { intelligence_index: iq, coding_index: coding, agentic_index: agentic } });
const listed = (id, name, benchmarks) => ({ id, name, supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000003', completion: '0.000004' }, benchmarks });
// 14 models where intelligence ≈ 0.7 · agentic + 1 (what OpenRouter gives for the best known ones).
const known = Array.from({ length: 14 }, (_, i) => { const agentic = 5 + i * 4; return listed('acme/m-' + i, 'Acme: Modelo ' + i, bench(Math.round((0.7 * agentic + 1) * 10) / 10, Math.round(agentic * 0.9 + 30), agentic)); });
const data = known.concat([
  listed('acme/estimado', 'Acme: Estimado', bench(null, 66, 40)),
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
    return [card.dataset.modelId, { num: gauge ? card.querySelector('.model-gauge-num').textContent : '', est: !!(gauge && gauge.classList.contains('est')), icon: card.querySelector('.model-card-icon img') ? 'logo' : 'letter', title: gauge ? gauge.title : '' }];
  })));
  await page.click('#model-menu-btn');
  await page.waitForSelector('.model-card');

  // 1. OpenRouter's own list.
  const plain = await rows();
  check('a model with its number shows it (as before, no «~»)', plain['acme/m-3'] && plain['acme/m-3'].num === String(Math.round(0.7 * 17 + 1)) && !plain['acme/m-3'].est && plain['anthropic/claude-opus-5.5'].num === '58' && !plain['anthropic/claude-opus-5.5'].est, [plain['acme/m-3'], plain['anthropic/claude-opus-5.5']]);
  const estimated = plain['acme/estimado'];
  check('a model with only coding/agentic scores gets an estimate: «~29», drawn fainter, its tooltip says why', estimated && estimated.est && /^~\d+$/.test(estimated.num) && Math.abs(Number(estimated.num.slice(1)) - 29) <= 2 && /estimado/.test(estimated.title), estimated);
  check('a model with no scores at all shows no speedometer (nothing invented)', plain['acme/sin-datos'] && plain['acme/sin-datos'].num === '' && !plain['acme/sin-datos'].est, plain['acme/sin-datos']);
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
  check('«Más inteligentes» puts the estimated model among the numbered ones, above the one without data', order.indexOf('acme/estimado') > -1 && order.indexOf('acme/estimado') < order.indexOf('acme/sin-datos') && order.indexOf('claude-api/claude-opus-5-5') < order.indexOf('acme/estimado'), order.slice(0, 12));
  const cached = await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || 'null'); const entry = saved && saved.entries.find((item) => item.id === 'acme/estimado'); return { cached: !!entry, intelligence: entry ? entry.intelligence : 'none', flag: entry ? !!entry.iqEstimated : null }; });
  check('the saved copy of OpenRouter\'s list stays as OpenRouter gave it (no estimate written into it)', cached.cached && cached.intelligence === null && cached.flag === false, cached);
  await page.screenshot({ path: SCRATCH + '/model-list.png' });

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
