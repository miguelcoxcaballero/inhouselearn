// Every cent counts in the conversation's total: costs survive a reload (they
// used to be dropped when the chat was saved), an answer that fails or is
// stopped keeps what it cost, and a regenerated answer keeps its old versions
// (with their cost) behind the ‹ 1/2 › arrows, also after a reload and on a phone.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { SCRATCH } = require('./mock.cjs');
const models = path.join(SCRATCH, 'models-priced-history.json');
fs.writeFileSync(models, JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: V4.1 Flash', supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000003', completion: '0.000004' } }] }));
process.env.MODELS_JSON = models;
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const total = () => page.evaluate(() => ({ total: Number(chatTotalCost(getActiveChat()).toFixed(6)), shown: (document.getElementById('chat-cost') || {}).textContent }));

  // 1. Two normal answers.
  for (const q of ['Hola', '¿Qué tal?']) {
    await page.evaluate(() => window.__replies.push({ text: 'Respuesta corta.' }));
    await send(page, q);
    await idle(page);
  }
  const two = await total();
  check('two answers count in the total', two.total === 0.001, two);

  // 2. Regenerate: the old version stays behind the arrows and its cost still counts.
  await page.evaluate(() => window.__replies.push({ text: 'Otra versión de la respuesta.' }));
  await page.evaluate(() => regenerateMessage(getActiveChat().messages.slice(-1)[0].id));
  await idle(page);
  await page.waitForTimeout(1200);
  const regen = await page.evaluate(() => ({ label: (document.querySelector('#thread .message:last-child .msg-nav-label') || {}).textContent, visible: (() => { const el = document.querySelector('#thread .message:last-child .msg-nav'); return !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el.parentElement).opacity !== '0'; })(), total: Number(chatTotalCost(getActiveChat()).toFixed(6)) }));
  check('after regenerating, ‹ 2/2 › arrows show the old version too (on a phone)', regen.label === '2/2' && regen.visible, regen);
  check('…and the old version\'s cost still counts in the total', regen.total === 0.0015, regen);
  await page.click('#thread .message:last-child [data-nav-dir="-1"]');
  const old = await page.evaluate(() => ({ text: document.querySelector('#thread .message:last-child .md-root').innerText, cost: document.querySelector('#thread .message:last-child .msg-cost').textContent }));
  check('the arrow goes back to the old version, with its own cost', /Respuesta corta/.test(old.text) && old.cost === '$0.0005', old);
  await page.click('#thread .message:last-child [data-nav-dir="1"]');

  // 3. A failed answer keeps what it cost (a tool round finished, then the connection died).
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'list_files', args: {} }] }, { text: 'Esta respuesta se va a cortar a mitad de camino sin remedio.', chunk: 5, delay: 30, networkError: 25 }));
  await send(page, 'Mira mis archivos');
  await idle(page, 20000);
  const failed = await page.evaluate(() => { const m = getActiveChat().messages.slice(-1)[0]; return { content: m.content.slice(0, 30), cost: m.cost }; });
  check('an answer that fails keeps what it cost (the finished request at least)', /^Error/.test(failed.content) && failed.cost >= 0.0005, failed);

  // 4. A reload keeps every cost (they used to be dropped when saving).
  const before = await total();
  await page.evaluate(() => saveState({ skipDrive: true }));
  await page.reload();
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(1500);
  const after = await total();
  const nav = await page.evaluate(() => { const m = getActiveChat().messages.find((x) => (x.alternatives || []).length); return m ? (document.querySelector('[data-msg-id="' + m.id + '"] .msg-nav-label') || {}).textContent : ''; });
  check('after a reload the total is the same (costs are saved now)', after.total === before.total && after.total > 0.0015 && after.shown === '$' + after.total.toFixed(4), { before, after });
  check('…and the regenerated answer still shows its versions', nav === '2/2', nav);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
