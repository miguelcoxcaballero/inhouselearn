// APK 1.0.6: the page tells the Android shell when it is working (an answer
// running or messages queued) so the app keeps it alive in the background with
// a notification, and when an answer ends with the app out of sight it asks for
// «Respuesta lista» with the start of the text. A tap on that notification
// opens its chat (inhouseLearnOpenChat). Here the shell is a fake bridge.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, {
    init: () => {
      window.__shell = [];
      window.InhouseLearnApp = { postMessage: (data) => window.__shell.push(JSON.parse(data)) };
      window.__hidden = false;
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => window.__hidden });
    }
  });
  const shell = (type) => page.evaluate((t) => window.__shell.filter((m) => m.type === t), type);

  // 1. One answer: working on (with the chat), then off; the app is in front, so no notification.
  await page.evaluate(() => { window.__shell = []; window.__replies.push({ text: 'La fotosíntesis convierte la luz en energía química.', delay: 30 }); });
  await send(page, 'Explícame la fotosíntesis');
  await page.waitForFunction(() => window.__shell.some((m) => m.type === 'working' && m.on), null, { timeout: 10000 });
  const started = (await shell('working'))[0];
  await idle(page);
  const working = await shell('working');
  const chatId = await page.evaluate(() => getActiveChat().id);
  check('the page tells the app it is working (with its chat), and when it stops', started.on === true && started.chat === chatId && working.length === 2 && working[1].on === false, working);
  check('…with the app in front there is no «Respuesta lista»', (await shell('answered')).length === 0);

  // 2. Leave the app mid-answer: when it ends, «Respuesta lista» with the start of the text.
  await page.evaluate(() => { window.__shell = []; window.__replies.push({ text: '**Fase luminosa**: en los tilacoides. Después viene el ciclo de Calvin.', delay: 40 }); });
  await send(page, '¿Y sus fases?');
  await page.waitForFunction(() => window.__shell.some((m) => m.type === 'working' && m.on), null, { timeout: 10000 });
  await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await idle(page);
  const answered = await shell('answered');
  check('an answer that ends with the app out of sight asks for «Respuesta lista» with its text and chat', answered.length === 1 && answered[0].chat === chatId && /^Fase luminosa: en los tilacoides/.test(answered[0].text) && !/\*/.test(answered[0].text), answered);
  await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });

  // 3. Queued messages keep it «working» until the last one ends (one on, one off).
  await page.evaluate(() => { window.__shell = []; window.__replies.push({ text: 'Primera respuesta bastante larga para dar tiempo a la cola.', delay: 40 }, { text: 'Segunda.' }); });
  await send(page, 'Primera');
  await page.waitForFunction(() => appState.busy);
  await page.fill('#composer', 'Segunda');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => getActiveChat().messages.filter((m) => m.role === 'assistant').length >= 4 && !appState.busy && !messageQueue.items.length, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const queued = await shell('working');
  check('queued messages keep the app working until the last answer ends', queued.length === 2 && queued[0].on && !queued[1].on, queued);

  // 4. A tap on the notification opens its chat.
  await page.evaluate(() => { document.getElementById('new-chat-btn') ? document.getElementById('new-chat-btn').click() : null; });
  await page.evaluate(() => { if (getActiveChat().messages.length) { const fresh = normalizeStoredChat({}); appState.chats.unshift(fresh); appState.activeChatId = fresh.id; renderThread(); } });
  const other = await page.evaluate(() => appState.activeChatId);
  await page.evaluate((id) => window.inhouseLearnOpenChat(id), chatId);
  const opened = await page.evaluate(() => ({ active: appState.activeChatId, url: location.search }));
  check('inhouseLearnOpenChat opens the chat of the notification (and its URL)', other !== chatId && opened.active === chatId && opened.url.includes(chatId), opened);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
