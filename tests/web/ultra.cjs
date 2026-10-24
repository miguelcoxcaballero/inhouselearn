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
  check('choosing «Ultra code»: a burst of sparks, then the rainbow label (in the dropdown and on the model button)', on.flag && on.sparks >= 10 && on.burst && on.label === 'Ultra code' && on.labelRainbow && on.menuClosed && on.meta === 'Ultra code' && on.rainbow, on);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { if (typeof closeModelMenu === 'function') closeModelMenu(); });

  // 2. Parallel agents.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'spawn_agents', args: { agents: [{ name: 'Fuentes', task: 'Busca tres fuentes sobre la fotosíntesis y resume cada una.' }, { name: 'Esquema', task: 'Escribe un esquema de la fotosíntesis en cinco puntos.' }] } }] },
    { text: 'Resultado de un agente, con todo lo que ha encontrado, escrito poco a poco.', chunk: 4, delay: 60 },
    { text: 'Resultado del otro agente, también escrito poco a poco para verlo en directo.', chunk: 4, delay: 60 },
    { text: 'He juntado lo de los dos agentes.' }));
  await send(page, 'Prepárame un dossier sobre la fotosíntesis');
  await page.waitForSelector('.agents-card.running', { timeout: 15000 });
  await page.waitForTimeout(700);
  const during = await page.evaluate(() => { const card = document.querySelector('.agents-card'); return { title: card.querySelector('.agents-title').textContent, rows: Array.from(card.querySelectorAll('.agent-row')).map((row) => row.dataset.status + ':' + row.querySelector('b').textContent + ':' + row.querySelector('.msg-cost').dataset.cost), live: getActiveChat().messages.slice(-1)[0].liveCost }; });
  check('while they work, a card shows each agent running and its live cost', /Agentes trabajando · 2 de 2/.test(during.title) && during.rows.length === 2 && during.rows.every((row) => /^running:/.test(row)) && during.rows.some((row) => Number(row.split(':')[2]) > 0), during);
  await idle(page, 40000);
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const m = getActiveChat().messages.slice(-1)[0];
    const card = document.querySelector('#thread .message:last-child .agents-card');
    const reqs = window.__requests.slice(-4);
    return {
      content: m.content, cost: m.cost,
      title: card && card.querySelector('.agents-title').textContent,
      done: card ? Array.from(card.querySelectorAll('.agent-row')).map((row) => row.dataset.status) : [],
      mainTools: (reqs[0].tools || []).map((t) => t.function.name),
      subTools: (reqs[1].tools || []).map((t) => t.function.name),
      subSystem: String(reqs[1].messages[0].content).slice(0, 2000),
      mainSystem: String(reqs[0].messages[0].content),
      final: reqs[3].messages.filter((x) => x.role === 'tool').map((x) => String(x.content)).join('\n')
    };
  });
  check('when they finish the card says so, both ✓', /2 agentes en paralelo/.test(after.title) && after.done.join() === 'done,done', after);
  check('the main model has spawn_agents and the Ultra prompt; the agents do not have spawn_agents', after.mainTools.includes('spawn_agents') && /Modo Ultra code/.test(after.mainSystem) && !after.subTools.includes('spawn_agents') && after.subTools.includes('web_search') && /one of several agents/.test(after.subSystem), { main: after.mainTools, sub: after.subTools });
  check('the main model gets both results to integrate', /## Fuentes/.test(after.final) && /## Esquema/.test(after.final) && after.content === 'He juntado lo de los dos agentes.', after.final.slice(0, 300));
  check('the agents\' cost is part of the answer\'s cost (4 requests)', Math.abs(after.cost - 0.002) < 1e-9, after.cost);

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
