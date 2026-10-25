// A reload shows the right chats at once, also when the history no longer fits
// in localStorage (~5 MB): a failed write used to leave an old copy there, and
// the chats list showed those old chats until Drive arrived seconds later.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

// localStorage "full" for the chats: any write of the main key over 4 KB throws, like a quota error.
const QUOTA = `(() => {
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === 'inhouseGeminiStandaloneV1' && String(value).length > 4000 && sessionStorage.getItem('quota') === '1') {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    return set.call(this, key, value);
  };
})();`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 800 } }, { init: QUOTA });
  const titles = () => page.evaluate(() => [...document.querySelectorAll('.chat-item .t')].map((el) => el.textContent || el.closest('.chat-item').getAttribute('aria-label')));
  const firstPaint = async () => {
    // What the list holds as soon as the page has booted, before Drive could answer anything.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof appState !== 'undefined' && typeof runAssistantTurn === 'function' && (appState.stateLoaded || document.readyState === 'complete'), null, { timeout: 5000 });
    return page.evaluate(() => ({ chats: appState.chats.map((chat) => chat.id), active: appState.activeChatId, text: (document.getElementById('thread') || {}).innerText || '', answer: ((getActiveChat().messages.slice(-1)[0] || {}).content || '').length }));
  };

  // 1. Two chats that fit: a reload shows them.
  await page.evaluate(() => window.__replies.push({ text: 'Primera respuesta.' }));
  await send(page, 'Primer chat');
  await idle(page);
  const first = await page.evaluate(() => appState.activeChatId);
  await page.evaluate(() => newChat());
  await page.evaluate(() => window.__replies.push({ text: 'Segunda respuesta.' }));
  await send(page, 'Segundo chat');
  await idle(page);
  const second = await page.evaluate(() => appState.activeChatId);
  let shown = await firstPaint();
  check('a normal reload opens with the same chats at once', shown.chats.includes(first) && shown.chats.includes(second) && shown.active === second, shown);

  // 2. The history stops fitting in localStorage: a long answer in a new chat.
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.evaluate(() => sessionStorage.setItem('quota', '1'));
  await page.evaluate(() => newChat());
  await page.evaluate(() => window.__replies.push({ text: Array.from({ length: 2500 }, (_, i) => 'Frase ' + i + ' de una respuesta larga.').join(' '), chunk: 6000, delay: 1 }));
  await send(page, 'Tercer chat con mucho texto');
  await idle(page);
  const third = await page.evaluate(() => appState.activeChatId);
  const local = await page.evaluate(() => { const raw = localStorage.getItem('inhouseGeminiStandaloneV1'); return raw ? JSON.parse(raw).chats.length : 0; });
  shown = await firstPaint();
  check('localStorage could not hold it: the old copy is removed, not left behind', local === 0, local);
  check('…and the reload still opens at once with every chat, the newest included (from IndexedDB)', [first, second, third].every((id) => shown.chats.includes(id)) && shown.active === third && shown.answer > 50000, { shown: shown.chats, active: shown.active, third, answer: shown.answer });

  // 3. A chat deleted afterwards never comes back on reload.
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.evaluate((id) => { appState.chats = appState.chats.filter((chat) => chat.id !== id); saveState({ skipDrive: true }); }, first);
  await page.waitForTimeout(300);
  shown = await firstPaint();
  check('a chat removed before the reload does not reappear (no stale copy)', !shown.chats.includes(first) && shown.chats.includes(third), shown.chats);
  await page.waitForTimeout(800);
  const list = await titles();
  check('the chats list shows them', list.length >= 2, list);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
