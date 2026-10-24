// Chat names: three words, very descriptive, only the first letter in capitals,
// made by the chat's model after the first answer; every three messages it
// checks whether the topic changed a lot and only then renames; the change is
// typed out (old name deleted letter by letter, new one typed); a name the user
// wrote is never touched.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1100, height: 820 } });
  const title = () => page.evaluate(() => ({ title: getActiveChat().title, list: (document.querySelector('[data-title-chat-id="' + appState.activeChatId + '"]') || {}).textContent, top: elements.topTitleMain.textContent, requests: (window.__titleRequests || []).length }));

  const norm = await page.evaluate(() => [normalizeChatTitle('"Física: TIRO parabólico, ejemplos"'), normalizeChatTitle('Dos palabras'), normalizeChatTitle('ÉPOCA DEL renacimiento')]);
  check('names are three words with only the first letter in capitals', norm[0] === 'Física tiro parabólico' && norm[1] === '' && norm[2] === 'Época del renacimiento', norm);

  const provisional = await page.evaluate(() => [deriveTitle([{ role: 'user', content: '¿Me EXPLICAS el tiro parabólico con ejemplos?' }], {}), deriveTitle([{ role: 'user', content: 'Hola' }], {})]);
  check('the first name, before the model answers, follows the same rules (three words, first capital)', provisional[0] === 'Tiro parabólico ejemplos' && provisional[1] === 'Hola', provisional);

  await page.evaluate(() => { window.__titleReply = { title: 'Movimiento parabólico física', changed: true }; window.__replies.push({ text: 'El tiro parabólico combina dos movimientos.' }); });
  await send(page, 'Explícame el tiro parabólico');
  await idle(page);
  // The name is typed out: some frame shows a partial name with the caret.
  const frames = [];
  for (let i = 0; i < 60; i++) {
    frames.push(await page.evaluate(() => { const el = document.querySelector('[data-title-chat-id="' + appState.activeChatId + '"]'); return el ? (el.classList.contains('title-typing') ? '|' : '') + el.textContent : ''; }));
    if (frames[frames.length - 1] === 'Movimiento parabólico física') break;
    await page.waitForTimeout(80);
  }
  await page.waitForFunction(() => getActiveChat().title === 'Movimiento parabólico física' && !document.querySelector('.title-typing'), null, { timeout: 10000 });
  const first = await title();
  const partial = frames.filter((f) => f.startsWith('|'));
  check('after the first answer the chat gets a three-word name from the model', first.title === 'Movimiento parabólico física' && first.list === first.title && first.top === first.title && first.requests === 1, first);
  check('…typed out like someone at a keyboard (old name deleted, new one written)', partial.length >= 3 && partial.some((f) => f.length > 1 && f.length < 15) && partial.some((f) => /^\|Movimiento p/.test(f) || /^\|Mov/.test(f)), partial.slice(0, 12));
  const request = await page.evaluate(() => window.__titleRequests[0]);
  check('…with the chat\'s own model, asking for exactly three words', request.model === 'deepseek/deepseek-v4.1-flash' && /EXACTLY three words/.test(request.messages[0].content) && /tiro parabólico/.test(request.messages[1].content), request.messages[0].content.slice(0, 200));

  // Same topic: no new request until three more messages, then «not changed» keeps it.
  for (const text of ['¿Y el alcance máximo?', '¿Y con rozamiento?']) {
    await page.evaluate(() => window.__replies.push({ text: 'Vale.' }));
    await send(page, text);
    await idle(page);
  }
  const quiet = await title();
  check('no new check before three more messages', quiet.requests === 1, quiet);
  await page.evaluate(() => { window.__titleReply = { title: 'Movimiento parabólico física', changed: false }; window.__replies.push({ text: 'Vale.' }); });
  await send(page, '¿Y la altura máxima?');
  await idle(page);
  await page.waitForTimeout(500);
  const kept = await title();
  check('the topic did not change: it asks, and keeps the name', kept.requests === 2 && kept.title === 'Movimiento parabólico física', kept);

  // The topic changes a lot: renamed, typed out again.
  for (const text of ['Ahora hablemos de cocina', 'Una receta de paella']) {
    await page.evaluate(() => window.__replies.push({ text: 'Vale.' }));
    await send(page, text);
    await idle(page);
  }
  await page.evaluate(() => { window.__titleReply = { title: 'Receta de paella', changed: true }; window.__replies.push({ text: 'Vale.' }); });
  await send(page, '¿Cuánto arroz por persona?');
  await idle(page);
  await page.waitForFunction(() => getActiveChat().title === 'Receta de paella' && !document.querySelector('.title-typing'), null, { timeout: 10000 });
  const renamed = await title();
  const sent = await page.evaluate(() => window.__titleRequests.slice(-1)[0].messages[0].content);
  check('the topic changed a lot: renamed (the model is told the current name)', renamed.title === 'Receta de paella' && renamed.top === 'Receta de paella' && /Movimiento parabólico física/.test(sent), renamed);

  // A name the user wrote is never touched.
  await page.evaluate(() => { const chat = getActiveChat(); chat.customTitle = 'Mi chat'; chat.title = deriveTitle(chat.messages, chat); chat.autoTitleAt = 0; });
  const before = (await title()).requests;
  await page.evaluate(() => window.__replies.push({ text: 'Vale.' }));
  await send(page, 'Otra cosa');
  await idle(page);
  await page.waitForTimeout(500);
  const custom = await title();
  check('a name the user wrote is never touched (and costs nothing)', custom.title === 'Mi chat' && custom.requests === before, custom);

  // The chat's name sits in the exact centre of the top bar: the two side
  // columns (Chats + brand, and the app download button) have the same width, so
  // the name is centred with or without that button, on a phone and on a desktop.
  const geometry = async (width, height, withDownload) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    return page.evaluate((show) => {
      document.body.classList.toggle('has-app-download', show);
      const link = document.getElementById('app-download');
      if (link) link.classList.toggle('hidden', !show);
      const bar = document.querySelector('.topbar').getBoundingClientRect();
      const name = document.getElementById('top-title-main').getBoundingClientRect();
      const start = document.querySelector('.topbar-start').getBoundingClientRect();
      const end = show && link ? link.getBoundingClientRect() : null;
      const round = (value) => Math.round(value * 10) / 10;
      return {
        offset: round((name.left + name.right) / 2 - (bar.left + bar.right) / 2),
        leftGap: round(name.left - start.right),
        rightGap: round((end ? end.left : bar.right) - name.right),
        nameWidth: Math.round(name.width)
      };
    }, withDownload);
  };
  for (const [w, h] of [[360, 780], [414, 896], [768, 1024], [1100, 820]]) {
    for (const withDownload of [false, true]) {
      const g = await geometry(w, h, withDownload);
      check('the name is centred in the top bar (' + w + 'px wide, ' + (withDownload ? 'with' : 'without') + ' the app download button)',
        Math.abs(g.offset) <= 1.5 && g.leftGap > 0 && g.rightGap > 0, g);
    }
  }

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
