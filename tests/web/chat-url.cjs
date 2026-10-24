// One URL per conversation (?c=<chat id>): a reload stays on the open chat,
// never on the snapshot's old activeChatId; without ?c= the most recently used
// chat opens; back goes to the chat opened before. And an expired Google
// session is said above the composer (the app never blocks without Drive).
const { chromium } = require('playwright');
const { openApp, send, idle, BASE } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  const state = () => page.evaluate(() => ({ active: appState.activeChatId, url: new URLSearchParams(location.search).get('c') || '', title: getActiveChat().title }));

  await page.evaluate(() => window.__replies.push({ text: 'Respuesta A.' }));
  await send(page, 'Primera conversación');
  await idle(page);
  const a = await state();
  check('the open conversation is in the URL', a.url === a.active && !!a.url, a);
  await page.evaluate(() => newChat());
  await page.evaluate(() => window.__replies.push({ text: 'Respuesta B.' }));
  await send(page, 'Segunda conversación');
  await idle(page);
  const b = await state();
  check('a new conversation gets its own URL', b.url === b.active && b.active !== a.active, b);

  // Open A from the list: the URL follows, and a reload stays on A even though
  // the saved snapshot says otherwise.
  await page.evaluate((id) => document.querySelector('[data-chat-id="' + id + '"]').click(), a.active);
  await page.evaluate((id) => { const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)); raw.activeChatId = id; localStorage.setItem(STORAGE_KEY, JSON.stringify(raw)); }, b.active);
  await page.reload();
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(800);
  const reloaded = await state();
  check('a reload stays on the conversation in the URL, not on the snapshot\'s old one', reloaded.active === a.active && reloaded.url === a.active, reloaded);

  // Back: the conversation opened before.
  await page.evaluate((id) => document.querySelector('[data-chat-id="' + id + '"]').click(), b.active);
  await page.waitForTimeout(200);
  await page.goBack();
  await page.waitForTimeout(500);
  const back = await state();
  check('back goes to the conversation opened before', back.active === a.active && back.url === a.active, back);

  // The base address opens the most recently used conversation.
  await page.evaluate((id) => { const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)); raw.activeChatId = id; localStorage.setItem(STORAGE_KEY, JSON.stringify(raw)); }, a.active);
  await page.goto(BASE);
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(800);
  const base = await state();
  check('without ?c= the most recently used conversation opens', base.active === b.active, { base, b: b.active });

  // A link to a conversation this browser does not have yet: a new chat meanwhile.
  await page.goto(BASE + '?c=chat-not-here-yet');
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(800);
  const unknown = await page.evaluate(() => ({ pending: appState.urlChatPending, empty: !getActiveChat().messages.length }));
  check('an unknown conversation link opens a new chat and waits for Drive to bring it', unknown.pending === 'chat-not-here-yet' && unknown.empty, unknown);

  // Expired Google session: a notice with one button, above the composer.
  const banner = await page.evaluate(() => {
    appState.profile = { email: 'me@example.com', name: 'Me' };
    appState.accessToken = 'old';
    appState.accessTokenExpiresAt = Date.now() - 1000;
    updateSessionBanner();
    const el = document.getElementById('session-banner');
    return { shown: !el.classList.contains('hidden'), text: el.innerText };
  });
  check('an expired Google session is said above the composer, with a button to sign in again', banner.shown && /ha caducado/.test(banner.text) && /Volver a entrar/.test(banner.text), banner);
  const fresh = await page.evaluate(() => { appState.accessTokenExpiresAt = Date.now() + 3600000; updateSessionBanner(); return document.getElementById('session-banner').classList.contains('hidden'); });
  check('…and it goes away with a valid session', fresh);

  // A new release on the server: the page reloads itself on the same chat,
  // but never while something is half-typed.
  const update = await page.evaluate(async () => {
    window.__reloads = 0;
    window.reloadPage = () => { window.__reloads++; };
    const same = '<html><head>' + Array.from(document.querySelectorAll('script[src*="?v="], link[rel="stylesheet"][href*="?v="]')).map((el) => el.outerHTML).join('') + '</head></html>';
    const inner = window.fetch;
    let html = same;
    window.fetch = (input, init) => String(input).includes('?fresh=') ? Promise.resolve(new Response(html, { status: 200 })) : inner(input, init);
    try { sessionStorage.removeItem('inhouse-learn-page-reload'); } catch (_) {}
    const unchanged = await checkForNewPage(true);
    html = same.replace(/\?v=[^"&]+/, '?v=newer-release');
    elements.composer.value = 'a medias';
    const changed = await checkForNewPage(true);
    const whileTyping = window.__reloads;
    elements.composer.value = '';
    await new Promise((r) => setTimeout(r, 5500));
    return { unchanged, changed, whileTyping, after: window.__reloads };
  });
  check('a new release on the server: the page reloads itself, after what is being typed', !update.unchanged && update.changed && update.whileTyping === 0 && update.after === 1, update);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
