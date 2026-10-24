// Leaving the Android app pauses the page and the stream dies with a network
// error: no error is shown; the answer is asked again as soon as the app is
// back in front. A turn that changed something is not repeated by itself, and
// a network error with the app in front stays an error.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  await page.evaluate(() => {
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
    window.leaveApp = () => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); };
    window.backToApp = () => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); };
  });
  const last = () => page.evaluate(() => { const m = getActiveChat().messages.slice(-1)[0]; return { content: m.content, retry: !!m.retryOnReturn, alts: (m.alternatives || []).length, status: (document.getElementById('composer-status') || {}).textContent || '' }; });

  // 1. Cut while away: no error, a note, and asked again on return.
  await page.evaluate(() => window.__replies.push({ text: 'La fotosíntesis convierte la luz en energía química dentro de los cloroplastos de las plantas.', chunk: 8, delay: 40, networkError: 40 }));
  await send(page, '¿Qué es la fotosíntesis?');
  await page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content.length > 10);
  await page.evaluate(() => leaveApp());
  await idle(page, 20000);
  const away = await last();
  check('cut while the app is in the background: no error, a short note instead', !/Error/.test(away.content) && /Se cortó al salir de la app/.test(away.content) && away.retry, away);
  await page.evaluate(() => window.__replies.push({ text: 'La fotosíntesis es cómo las plantas fabrican su alimento con luz.' }));
  await page.evaluate(() => backToApp());
  await page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content === 'La fotosíntesis es cómo las plantas fabrican su alimento con luz.', null, { timeout: 15000 });
  await idle(page, 20000);
  const back = await last();
  check('…back in the app, the answer is asked again by itself (no extra version left behind)', !back.retry && back.alts === 0, back);

  // 2. A turn that changed something is not repeated by itself.
  await page.evaluate(() => { getActiveChat().approvalMode = 'full'; window.__replies.push({ text: '', tools: [{ name: 'write_file', args: { path: 'notas.md', content: 'hola' } }] }, { text: 'Guardado el archivo y ahora sigo explicando con más detalle.', chunk: 6, delay: 40, networkError: 20 }); });
  await send(page, 'Guarda una nota');
  await page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content.length > 5, null, { timeout: 15000 });
  await page.evaluate(() => leaveApp());
  await idle(page, 20000);
  await page.evaluate(() => backToApp());
  await page.waitForTimeout(1500);
  const wrote = await last();
  check('a cut turn that changed something keeps its error and is not repeated by itself', /^Error:/.test(wrote.content) && !wrote.retry, wrote);

  // 3. A network error with the app in front stays an error.
  await page.evaluate(() => window.__replies.push({ text: 'Una respuesta que se corta sin salir de la app.', chunk: 6, delay: 30, networkError: 12 }));
  await send(page, 'Otra pregunta');
  await idle(page, 20000);
  const front = await last();
  check('a network error with the app in front is still shown as an error', /^Error:/.test(front.content) && !front.retry, front);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
