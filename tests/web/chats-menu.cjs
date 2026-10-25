// The chats menu «Índice» (chats-menu.css): groups Fijadas/Hoy/Ayer/…, serif
// titles sized by recency, short date, a pin on the left for pinned chats and,
// for chats with news, a bold title with an orange diamond and date (an answer that ended while the user was in
// another chat or away, or another device wrote there; this device only).
// Long press / right click opens Fijar · Renombrar · Eliminar; a search
// filters by title. «Nuevo chat» sits bottom right.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.evaluate(() => {
    const now = Date.now();
    const mk = (title, hours, extra) => Object.assign(normalizeStoredChat({ title, autoTitle: title, messages: [{ role: 'user', content: title }, { role: 'assistant', content: 'ok' }] }), { updatedAt: new Date(now - hours * 3600e3).toISOString() }, extra || {});
    appState.chats = [mk('Fotosíntesis y fase luminosa', 0.2), mk('Revolución francesa causas', 5, { pinned: true }), mk('Tiro parabólico física', 26), mk('Integrales por partes', 900)];
    appState.activeChatId = appState.chats[0].id;
    renderHistory(); renderThread(); setChatsDrawer(true);
  });
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('#chat-list .ix-h')].map((h) => h.textContent),
    rows: [...document.querySelectorAll('#chat-list .chat-item')].map((r) => ({ t: r.querySelector('.t').textContent, d: r.querySelector('.d').textContent, pin: !!r.querySelector('.pn'), cls: r.className })),
    serif: getComputedStyle(document.querySelector('#chat-list .ix .t')).fontFamily
  }));
  const sizes = await page.evaluate(() => [...document.querySelectorAll('#chat-list .chat-item .t')].map((t) => parseFloat(getComputedStyle(t).fontSize)));
  check('groups Fijadas · Hoy · Ayer · month, serif titles, short dates, a pin only on the pinned chat', menu.groups.join() === 'Fijadas,Hoy,Ayer,' + new Date(Date.now() - 900 * 3600e3).toLocaleDateString('es-ES', { month: 'long' }).replace(/^./, (c) => c.toUpperCase()) &&
    /Newsreader/.test(menu.serif) && menu.rows[0].pin && !menu.rows[1].pin && menu.rows[1].d === '12 min' && menu.rows[2].d === 'ayer', menu);
  check('recent chats are bigger than old ones', sizes[1] > sizes[3], sizes);

  // News: an answer that ends while the user is in another chat leaves an orange diamond.
  const first = await page.evaluate(() => appState.chats[0].id);
  await page.evaluate(() => { window.__replies.push({ text: 'Una respuesta que tarda un poco en llegar entera para cambiar de chat. '.repeat(6), delay: 40, chunk: 4 }); });
  await page.evaluate(() => setChatsDrawer(false));
  await send(page, 'Explícame la fase oscura');
  await page.waitForFunction(() => appState.busy);
  await page.evaluate(() => { setChatsDrawer(true); });
  await page.click('.chat-item[data-chat-id="' + await page.evaluate(() => appState.chats.find((c) => c.title === 'Tiro parabólico física').id) + '"]');
  await idle(page, 30000);
  await page.evaluate(() => setChatsDrawer(true));
  await page.waitForTimeout(300);
  const news = await page.evaluate((id) => { const row = document.querySelector('.chat-item[data-chat-id="' + id + '"]'); return { unread: row.classList.contains('unread'), diamond: !!row.querySelector('.nw'), bold: Number(getComputedStyle(row.querySelector('.t')).fontWeight) >= 600, color: getComputedStyle(row.querySelector('.d')).color, label: row.getAttribute('aria-label') }; }, first);
  check('an answer that ends while you are in another chat marks it with news (bold title, diamond and orange date)', news.unread && news.diamond && news.bold && /Con novedades/.test(news.label), news);
  await page.click('.chat-item[data-chat-id="' + first + '"]');
  await page.evaluate(() => setChatsDrawer(true));
  await page.waitForTimeout(300);
  const read = await page.evaluate((id) => document.querySelector('.chat-item[data-chat-id="' + id + '"]').classList.contains('unread'), first);
  check('opening it clears the news', !read);

  // Another device answered in a chat that is not open: news too.
  await page.evaluate(() => {
    const chat = appState.chats.find((c) => c.title === 'Integrales por partes');
    applyLivePayload({ v: 1, device: 'otro', turn: 't1', seq: 1, at: new Date().toISOString(), done: true, chat: { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: new Date().toISOString() }, messages: [{ id: 'm-remote', role: 'assistant', content: 'Respuesta desde el móvil', createdAt: new Date().toISOString() }] });
  });
  await page.waitForTimeout(300);
  const remote = await page.evaluate(() => { const chat = appState.chats.find((c) => c.title === 'Integrales por partes'); return document.querySelector('.chat-item[data-chat-id="' + chat.id + '"]').classList.contains('unread'); });
  check('another device answering in a chat that is not open marks news', remote);

  // Long press: Fijar · Renombrar · Eliminar.
  const target = await page.evaluate(() => appState.chats.find((c) => c.title === 'Tiro parabólico física').id);
  const box = await page.locator('.chat-item[data-chat-id="' + target + '"]').boundingBox();
  await page.touchscreen.tap(box.x + 40, box.y + 10).catch(() => {});
  await page.evaluate(() => setChatsDrawer(true));
  await page.dispatchEvent('.chat-item[data-chat-id="' + target + '"]', 'contextmenu');
  await page.waitForSelector('#chat-menu');
  const items = await page.evaluate(() => [...document.querySelectorAll('#chat-menu button')].map((b) => b.textContent.trim()));
  await page.click('#chat-menu [data-act="pin"]');
  const pinned = await page.evaluate((id) => ({ pinned: appState.chats.find((c) => c.id === id).pinned, pin: !!document.querySelector('.chat-item[data-chat-id="' + id + '"] .gut .pn') }), target);
  check('right click / long press opens Fijar · Renombrar · Eliminar, and Fijar pins it (with its pin)', items[0] === 'Fijar' && items.includes('Renombrar') && items.includes('Eliminar') && pinned.pinned && pinned.pin, { items, pinned });

  // Manual rename: double click on the name, and the new one is typed out
  // letter by letter like the model's automatic names.
  const renameId = await page.evaluate(() => appState.chats.find((c) => c.title === 'Revolución francesa causas').id);
  await page.evaluate((id) => { document.querySelector('[data-title-chat-id="' + id + '"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }, renameId);
  // No box at all: the name itself is the field, and the keys go to it.
  const editor = await page.evaluate(() => {
    const el = document.querySelector('#top-title-main.renaming');
    return el ? { value: el.textContent, focused: document.activeElement === el, editable: el.getAttribute('contenteditable'), field: !!document.querySelector('input, textarea') } : null;
  });
  await page.keyboard.type('Historia moderna');
  await page.keyboard.press('Enter');
  const typed = [];
  for (let i = 0; i < 70; i++) {
    typed.push(await page.evaluate((id) => { const el = document.querySelector('[data-title-chat-id="' + id + '"]'); return el ? (el.classList.contains('title-typing') ? '|' : '') + el.textContent : ''; }, renameId));
    if (typed[typed.length - 1] === 'Historia moderna') break;
    await page.waitForTimeout(80);
  }
  const renamed = await page.evaluate((id) => { const chat = appState.chats.find((c) => c.id === id); return { title: chat.title, custom: chat.customTitle }; }, renameId);
  const partial = typed.filter((f) => f.startsWith('|'));
  check('double click renames the chat with no box at all, and the name is typed out like the automatic ones',
    editor && editor.value === 'Revolución francesa causas' && editor.focused && editor.editable === 'plaintext-only' && !editor.field &&
    renamed.custom === 'Historia moderna' && renamed.title === 'Historia moderna' &&
    partial.length >= 3 && partial.some((f) => f.length > 1 && f.length < 22) && typed[typed.length - 1] === 'Historia moderna',
    { renamed, editor, partial: partial.slice(0, 10) });

  // The arrow keys move the caret inside the name itself.
  await page.evaluate((id) => { document.querySelector('[data-title-chat-id="' + id + '"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }, renameId);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const caret = await page.evaluate(() => { const sel = window.getSelection(); return sel && sel.rangeCount ? sel.getRangeAt(0).startOffset : -1; });
  await page.keyboard.press('Escape');
  check('the arrow keys move the caret inside the name (the keys go to the name, not to a field)', caret === 'Historia moderna'.length - 2, { caret });

  await page.evaluate((id) => { document.querySelector('[data-title-chat-id="' + id + '"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }, renameId);
  await page.keyboard.type('Nombre descartado');
  await page.keyboard.press('Escape');
  const escaped = await page.evaluate((id) => { const chat = appState.chats.find((c) => c.id === id); return { title: chat.title, custom: chat.customTitle, list: (document.querySelector('[data-title-chat-id="' + id + '"]') || {}).textContent }; }, renameId);
  check('Escape discards the edit and keeps the name', escaped.title === 'Historia moderna' && escaped.custom === 'Historia moderna' && escaped.list === 'Historia moderna', escaped);

  // The open chat's own name, in the top bar: a tap is enough, the list does
  // not need to be open (it closes itself when a chat is chosen).
  await page.evaluate((id) => { appState.activeChatId = id; setChatsDrawer(false); renderHistory(); renderThread(); }, renameId);
  await page.click('#top-title-main');
  const topEditor = await page.evaluate(() => { const el = document.getElementById('top-title-main'); return el.classList.contains('renaming') && !document.querySelector('input, textarea') ? { value: el.textContent, focused: document.activeElement === el } : null; });
  await page.keyboard.type('Historia contemporánea');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => getActiveChat().title === 'Historia contemporánea' && !document.querySelector('.title-typing'), null, { timeout: 10000 });
  const topRenamed = await page.evaluate(() => ({ title: getActiveChat().title, custom: getActiveChat().customTitle, top: document.getElementById('top-title-main').textContent, list: (document.querySelector('[data-title-chat-id="' + appState.activeChatId + '"]') || {}).textContent }));
  check('tapping the open chat\'s name in the top bar renames it (and the new name is typed out there too)',
    topEditor && topEditor.value === 'Historia moderna' && topEditor.focused && topRenamed.title === 'Historia contemporánea' &&
    topRenamed.custom === 'Historia contemporánea' && topRenamed.top === 'Historia contemporánea' && topRenamed.list === 'Historia contemporánea',
    { topEditor, topRenamed });

  // The same, from the + menu.
  await page.click('#plus-btn');
  const plusRename = await page.evaluate(() => { const btn = document.getElementById('rename-chat-btn'); return btn ? btn.textContent.replace(/\s+/g, ' ').trim() : ''; });
  await page.click('#rename-chat-btn');
  const plusEditor = await page.evaluate(() => document.getElementById('top-title-main').classList.contains('renaming'));
  await page.keyboard.press('Escape');
  check('the + menu offers «Renombrar chat» and opens the editor of the open one', /Renombrar chat/.test(plusRename) && plusEditor, { plusRename, plusEditor });

  // Search filters by title, accents ignored.
  await page.click('#chats-search-btn');
  await page.fill('#chats-search-input', 'parabolico');
  const found = await page.evaluate(() => [...document.querySelectorAll('#chat-list .chat-item .t')].map((t) => t.textContent));
  await page.keyboard.press('Escape');
  const back = await page.evaluate(() => document.querySelectorAll('#chat-list .chat-item').length);
  check('the search filters chats by title (accents ignored) and Escape brings them all back', found.length === 1 && found[0] === 'Tiro parabólico física' && back === 4, { found, back });

  // «Nuevo chat», bottom right.
  const fab = await page.evaluate(() => { const r = document.getElementById('new-chat-btn').getBoundingClientRect(); const s = document.getElementById('sidebar').getBoundingClientRect(); return { right: Math.round(s.right - r.right), bottom: Math.round(s.bottom - r.bottom), text: document.getElementById('new-chat-btn').textContent.trim() }; });
  check('«Nuevo chat» sits bottom right, within thumb reach', fab.right < 40 && fab.bottom < 160 && fab.text === 'Nuevo chat', fab);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
