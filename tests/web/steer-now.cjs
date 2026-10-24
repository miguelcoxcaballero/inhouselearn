// «Ahora» always does something: while the model writes its final answer the
// message enters the same run right after it (pi's steer); during «Regenerar»,
// the automatic retry or «Corregir texto» (no steerable turn) it goes out as
// soon as they end (it used to stay in the queue for ever).
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));
const long = Array.from({ length: 80 }, (_, i) => 'Frase ' + i + ' de una respuesta larga.').join(' ');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  const msgs = () => page.evaluate(() => getActiveChat().messages.map((m) => m.role[0] + ':' + m.content.slice(0, 40) + (m.pending ? '…' : '')));

  // 1. Writing the final answer: the message enters the same run right after it.
  await page.evaluate((text) => window.__replies.push({ text, chunk: 6, delay: 20 }, { text: 'Respuesta al mensaje de «Ahora».' }), long);
  await send(page, 'Cuéntame algo largo');
  await page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content.length > 60);
  await page.fill('#composer', 'Y luego dime esto');
  await page.press('#composer', 'Enter');
  await page.waitForSelector('[data-dock="steer"]');
  await page.click('[data-dock="steer"]');
  const waiting = await page.evaluate(() => document.querySelector('.dock-queue-head') ? document.querySelector('.dock-queue-head').innerText : '');
  await idle(page, 30000);
  await page.waitForTimeout(300);
  const after = await msgs();
  check('while the model writes, «Ahora» says it goes right after, and it does (same run)', /acabe el paso en curso/.test(waiting) && after[2] === 'u:Y luego dime esto' && after[3] === 'a:Respuesta al mensaje de «Ahora».' && !(await page.evaluate(() => messageQueue.items.length)), { waiting, after });

  // 2. During «Regenerar»: the message goes out when it ends (it used to stay in the queue).
  await page.evaluate(() => window.__replies.push({ text: 'Versión regenerada con bastante texto para que dure un rato.', chunk: 4, delay: 40 }, { text: 'Respuesta tras regenerar.' }));
  await page.evaluate(() => { regenerateMessage(getActiveChat().messages.slice(-1)[0].id); });
  await page.waitForFunction(() => appState.busy);
  await page.fill('#composer', 'Y ahora esto');
  await page.press('#composer', 'Enter');
  await page.waitForSelector('[data-dock="steer"]');
  await page.click('[data-dock="steer"]');
  await page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content === 'Respuesta tras regenerar.', null, { timeout: 20000 }).catch(() => {});
  await idle(page, 20000);
  const regen = await msgs();
  check('during «Regenerar», «Ahora» sends the message as soon as it ends', regen.slice(-2).join(' | ') === 'u:Y ahora esto | a:Respuesta tras regenerar.' && !(await page.evaluate(() => messageQueue.items.length)), regen.slice(-3));

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
