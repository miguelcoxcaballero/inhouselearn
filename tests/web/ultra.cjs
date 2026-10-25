// Ultra code: a reasoning option in the model picker for every model; turning
// it on plays a rainbow burst with sparks and keeps a shimmering label; the
// model gets spawn_agents and the Ultra prompt; parallel agents run with the
// same tools (minus spawn_agents) and show, in a card, what each one is doing
// and spending, live; their cost goes into the answer's cost.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { SCRATCH } = require('./mock.cjs');
const models = path.join(SCRATCH, 'models-priced-ultra.json');
fs.writeFileSync(models, JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: V4.1 Flash', supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000003', completion: '0.000004' } }] }));
process.env.MODELS_JSON = models;
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 900 } });

  // 1. The option and its animation.
  await page.click('#model-menu-btn');
  await page.waitForSelector('[data-thinking-toggle]');
  const closed = await page.evaluate(() => ({ menu: document.querySelector('.thinking-menu').classList.contains('hidden'), rainbow: document.querySelectorAll('.thinking-segmented .ultra-text').length }));
  await page.click('[data-thinking-toggle]');
  const opened = await page.evaluate(() => ({ menu: !document.querySelector('.thinking-menu').classList.contains('hidden'), options: Array.from(document.querySelectorAll('.thinking-option .thinking-option-label')).map((el) => el.textContent), rainbow: document.querySelectorAll('.thinking-segmented .ultra-text').length }));
  check('reasoning is one dropdown, with Ultra code as an option, not in colours until it is chosen', closed.menu && !closed.rainbow && opened.menu && opened.options.includes('Ultra code') && opened.rainbow === 0, { closed, opened });
  await page.click('[data-thinking-level="ultra"]');
  const on = await page.evaluate(() => ({ flag: getActiveChat().ultraCode, sparks: document.querySelectorAll('.ultra-spark').length, burst: !!document.querySelector('.ultra-burst'), label: document.querySelector('.thinking-select-label').textContent, labelRainbow: document.querySelector('.thinking-select-label').classList.contains('ultra-text'), menuClosed: document.querySelector('.thinking-menu').classList.contains('hidden'), meta: elements.modelTriggerMeta.textContent, rainbow: elements.modelTriggerMeta.classList.contains('ultra-text') }));
  check('choosing «Ultra code»: a burst of sparks, then the rainbow label (in the dropdown and on the model button)', on.flag && on.sparks >= 6 && on.burst && on.label === 'Ultra code' && on.labelRainbow && on.menuClosed && on.meta === 'Ultra code' && on.rainbow, on);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { if (typeof closeModelMenu === 'function') closeModelMenu(); });

  // 2. Parallel agents.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'spawn_agents', args: { verify: false, agents: [{ name: 'Fuentes', task: 'Busca tres fuentes sobre la fotosíntesis y resume cada una con su enlace y lo más importante de cada una.' }, { name: 'Esquema', task: 'Escribe un esquema de la fotosíntesis en cinco puntos, con las fases y lo que entra y sale de cada una, para estudiar.' }] } }] },
    { text: 'Resultado de un agente, con todo lo que ha encontrado, escrito poco a poco.', chunk: 4, delay: 60 },
    { text: 'Resultado del otro agente, también escrito poco a poco para verlo en directo.', chunk: 4, delay: 60 },
    { text: 'He juntado lo de los dos agentes.' }));
  await send(page, 'Prepárame un dossier sobre la fotosíntesis');
  await page.waitForSelector('.ua-lane[data-status="running"]', { timeout: 15000 });
  const lane0 = await page.$('.ua-lane');
  await page.waitForTimeout(700);
  const during = await page.evaluate(() => { const card = document.querySelector('.ua-card'); return { title: card.querySelector('.ua-title').textContent, rows: Array.from(card.querySelectorAll('.ua-lane')).map((row) => row.dataset.status + ':' + row.querySelector('.ua-name').textContent + ':' + row.querySelector('.msg-cost').dataset.cost), live: getActiveChat().messages.slice(-1)[0].liveCost }; });
  check('while they work, the board shows each agent running and its live cost', /Trabajando/.test(during.title) && during.rows.length === 2 && during.rows.every((row) => /^running:/.test(row)) && during.rows.some((row) => Number(row.split(':')[2]) > 0), during);
  const sameNode = await page.evaluate((el) => el.isConnected, lane0);
  check('lanes are patched in place while agents work (the same DOM node survives)', sameNode);
  await idle(page, 40000);
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const m = getActiveChat().messages.slice(-1)[0];
    const card = document.querySelector('#thread .message:last-child .ua-card');
    const reqs = window.__requests.slice(-4);
    return {
      content: m.content, cost: m.cost,
      title: card && card.querySelector('.ua-title').textContent,
      done: card ? Array.from(card.querySelectorAll('.ua-lane')).map((row) => row.dataset.status) : [],
      mainTools: (reqs[0].tools || []).map((t) => t.function.name),
      subTools: (reqs[1].tools || []).map((t) => t.function.name),
      subSystem: String(reqs[1].messages[0].content).slice(0, 2000),
      mainSystem: String(reqs[0].messages[0].content),
      final: reqs[3].messages.filter((x) => x.role === 'tool').map((x) => String(x.content)).join('\n')
    };
  });
  check('when they finish the board says so, both done', /2 agentes/.test(after.title) && !/Trabajando/.test(after.title) && after.done.join() === 'done,done', after);
  check('the main model has spawn_agents and the Ultra prompt; the agents do not have spawn_agents', after.mainTools.includes('spawn_agents') && /Modo Ultra code/.test(after.mainSystem) && !after.subTools.includes('spawn_agents') && after.subTools.includes('web_search') && /varios agentes que trabajan a la vez/.test(after.subSystem), { main: after.mainTools, sub: after.subTools });
  check('the main model gets both results to integrate', /## Fuentes/.test(after.final) && /## Esquema/.test(after.final) && after.content === 'He juntado lo de los dos agentes.', after.final.slice(0, 300));
  check('the agents\' cost is part of the answer\'s cost (4 requests)', Math.abs(after.cost - 0.002) < 1e-9, after.cost);

  // 2b. An agent that searches the web: its row includes what the search cost.
  await page.evaluate(() => {
    const inner = window.fetch;
    window.fetch = async (input, init) => {
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      if (body && body.plugins) return new Response(JSON.stringify({ choices: [{ message: { content: 'ok', annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/a', title: 'A', content: 'x' } }] } }], usage: { cost: 0.007 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return inner(input, init);
    };
    window.__replies.push(
      { text: '', tools: [{ name: 'spawn_agents', args: { verify: false, agents: [{ name: 'Buscador', task: 'Busca información fiable sobre la fase luminosa de la fotosíntesis y resume lo esencial con sus fuentes.' }] } }] },
      { text: '', tools: [{ name: 'web_search', args: { query: 'fase luminosa' } }] },
      { text: 'Encontrado.' },
      { text: 'Hecho con la búsqueda.' });
  });
  await send(page, 'Busca con un agente');
  await idle(page, 40000);
  await page.waitForTimeout(800);
  const searched = await page.evaluate(() => { const card = document.querySelector('#thread .message:last-child .ua-card'); const row = card && card.querySelector('.ua-lane .msg-cost'); const m = getActiveChat().messages.slice(-1)[0]; return { agent: row ? Number(row.dataset.cost) : 0, answer: m.cost }; });
  check('an agent\'s row includes what its web searches cost (and so does the answer)', searched.agent >= 0.0075 && Math.abs(searched.answer - (0.0005 * 4 + 0.007)) < 1e-6, searched);

  // 3. Back to a normal level (here «Normal», the model has no levels) turns it off.
  await page.click('#model-menu-btn');
  await page.waitForSelector('[data-thinking-toggle]');
  await page.click('[data-thinking-toggle]');
  await page.click('[data-thinking-level="normal"]');
  const off = await page.evaluate(() => ({ flag: getActiveChat().ultraCode, prompt: ultraPromptText(getActiveChat()), meta: elements.modelTriggerMeta.textContent, label: document.querySelector('.thinking-select-label').textContent }));
  check('choosing another level turns Ultra code off', !off.flag && off.prompt === '' && off.meta !== 'Ultra code' && off.label === 'Normal', off);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
