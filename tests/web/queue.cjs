// Writing while the model works: messages wait in a queue above the composer
// and go out one per finished turn; «Ahora» / Ctrl+Enter steers the running
// turn (pi's steer: the message enters after the current tool, no restart);
// Stop pauses the queue; the thread shows what the tool is doing right now.
const { chromium } = require('playwright');
const { openApp, idle, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

async function type(page, text, mod) {
  await page.fill('#composer', text);
  await page.press('#composer', mod ? 'Control+Enter' : 'Enter');
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  const slow = (text) => ({ text, chunk: 3, delay: 70 });

  // 1. Queue: two messages written during the first answer go out after it, in order.
  await page.evaluate((r) => window.__replies.push(r[0], r[1], r[2]), [slow('Primera respuesta, que tarda un poco en escribirse entera.'), { text: 'Segunda respuesta.' }, { text: 'Tercera respuesta.' }]);
  await type(page, 'Primero');
  await page.waitForFunction(() => appState.busy);
  await page.fill('#composer', 'Segundo');
  const label = await page.evaluate(() => { updateSendUi(); return document.getElementById('send-label').textContent; });
  await page.press('#composer', 'Enter');
  await type(page, 'Tercero');
  const queued = await page.evaluate(() => ({ items: document.querySelectorAll('.dock-queue-item').length, busy: appState.busy, composer: document.getElementById('composer').value }));
  await page.screenshot({ path: SCRATCH + '/queue-dock.png' });
  check('while busy, Enter queues (button says «A la cola», composer clears)', label === 'A la cola' && queued.items === 2 && queued.busy && queued.composer === '', { label, queued });
  await page.waitForFunction(() => !appState.busy && !document.querySelector('.dock-queue-item') && getActiveChat().messages.length === 6, null, { timeout: 30000 });
  const order = await page.evaluate(() => getActiveChat().messages.map((m) => m.role[0] + ':' + m.content.slice(0, 9)));
  check('queued messages go out one per finished turn, in order', JSON.stringify(order) === JSON.stringify(['u:Primero', 'a:Primera r', 'u:Segundo', 'a:Segunda r', 'u:Tercero', 'a:Tercera r']), order);

  // 2. Steer: Ctrl+Enter during a run that uses a tool → it enters after the tool, same run.
  await page.click('#hamburger-btn'); await page.click('#new-chat-btn');
  const reqBefore = await page.evaluate(() => window.__requests.length);
  await page.evaluate((r) => window.__replies.push(r[0], r[1]), [
    { text: 'Empiezo a revisar los archivos con calma, uno a uno, para hacerlo bien.', chunk: 3, delay: 60, tools: [{ name: 'run_js', args: { code: 'const t = Date.now(); while (Date.now() - t < 1500) {} return 1;' } }] },
    { text: 'Vale, lo hago corto.' }
  ]);
  await type(page, 'Haz una tarea larga');
  await page.waitForFunction(() => appState.busy && getActiveChat().messages.slice(-1)[0].content.length > 5);
  await type(page, 'Mejor hazlo corto', true);
  await page.waitForSelector('.live-now', { timeout: 15000 });
  const live = await page.evaluate(() => document.querySelector('.live-now').innerText);
  await page.screenshot({ path: SCRATCH + '/queue-live.png' });
  check('the thread shows the running tool with a timer', /Ejecutando código/.test(live) && /\d+ s/.test(live), live);
  await idle(page, 30000);
  const steer = await page.evaluate((from) => ({
    messages: getActiveChat().messages.map((m) => m.role[0] + ':' + m.content.slice(0, 16) + (m.toolSteps && m.toolSteps.length ? '[' + m.toolSteps.length + ' paso]' : '')),
    requests: window.__requests.length - from,
    second: window.__requests.slice(-1)[0].messages.map((m) => m.role + ':' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 40)),
    dom: Array.from(document.querySelectorAll('#thread .message')).map((el) => el.classList.contains('user-msg') ? 'u' : 'a').join('')
  }), reqBefore);
  check('steer enters the same run after the tool: answer so far, the message, then the rest', JSON.stringify(steer.messages) === JSON.stringify(['u:Haz una tarea la', 'a:Empiezo a revisa[1 paso]', 'u:Mejor hazlo cort', 'a:Vale, lo hago co']) && steer.requests === 2 && steer.dom === 'uaua', steer);
  check('the model gets the steer after the tool result, in the same conversation', /tool:/.test(steer.second.slice(-2)[0]) && /^user:.*Mejor hazlo cort/.test(steer.second.slice(-1)[0]), steer.second.slice(-3));

  // 3. Stop pauses the queue; «Seguir» sends it.
  await page.evaluate((r) => window.__replies.push(r[0], r[1]), [{ text: 'Una respuesta muy larga que voy a parar enseguida porque sí.', chunk: 2, delay: 120 }, { text: 'Respuesta a lo de la cola.' }]);
  await type(page, 'Algo largo');
  await page.waitForFunction(() => appState.busy);
  await type(page, 'Para después');
  await page.click('#send-btn');
  await page.waitForFunction(() => !appState.busy);
  await page.waitForTimeout(400);
  const paused = await page.evaluate(() => ({ head: (document.querySelector('.dock-queue-head') || {}).innerText || '', last: getActiveChat().messages.slice(-1)[0].content }));
  check('Stop keeps the partial answer and pauses the queue', /En pausa/.test(paused.head) && /\(Detenido\)/.test(paused.last), paused);
  await page.click('[data-dock="resume"]');
  await idle(page, 20000);
  const resumed = await page.evaluate(() => getActiveChat().messages.slice(-2).map((m) => m.content));
  check('«Seguir» sends what was waiting', resumed[0] === 'Para después' && resumed[1] === 'Respuesta a lo de la cola.', resumed);

  // 4. «Ahora» on a queued item when nothing runs sends it at once; × removes.
  await page.evaluate(() => window.__replies.push({ text: 'Lenta, lenta, lenta, lenta, lenta, lenta.', chunk: 2, delay: 80 }));
  await type(page, 'Uno');
  await page.waitForFunction(() => appState.busy);
  await type(page, 'Quitar este');
  await page.click('.dock-queue-item [data-dock="remove"]');
  const removed = await page.evaluate(() => document.querySelectorAll('.dock-queue-item').length);
  check('× removes a queued message', removed === 0, removed);
  await idle(page, 20000);
  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
