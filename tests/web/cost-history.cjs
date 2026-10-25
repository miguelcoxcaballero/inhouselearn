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

  // 5. Closing the tab in the middle of an answer: what it had cost stays.
  await page.evaluate(() => window.__replies.push({ text: 'Una respuesta larga que se queda a medias porque el usuario cierra la pestaña. '.repeat(12), chunk: 4, delay: 40 }));
  const beforeCut = (await total()).total;
  await send(page, 'Escribe mucho');
  await page.waitForFunction(() => { const m = getActiveChat().messages.slice(-1)[0]; return m.pending && (m.liveCost || 0) > 0.0002; }, null, { timeout: 20000 });
  const live = await page.evaluate(() => getActiveChat().messages.slice(-1)[0].liveCost);
  await page.reload();
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(1500);
  const cut = await page.evaluate(() => { const m = getActiveChat().messages.slice(-1)[0]; return { pending: m.pending, cost: m.cost, total: Number(chatTotalCost(getActiveChat()).toFixed(6)) }; });
  check('closing mid-answer keeps what it had cost (in the message and the total)', !cut.pending && cut.cost >= live * 0.9 && cut.total >= beforeCut + live * 0.9, { live, cut, beforeCut });

  // 6. A copy from Drive saved by an older page (no costs) never wipes them.
  const wiped = await page.evaluate(() => {
    const chat = JSON.parse(JSON.stringify(getActiveChat()));
    chat.messages.forEach((m) => { delete m.cost; (m.alternatives || []).forEach((a) => delete a.cost); });
    chat.updatedAt = new Date(Date.now() + 60000).toISOString();
    chat.messages.push({ id: 'msg_remote', role: 'user', content: 'Desde otro dispositivo', createdAt: new Date().toISOString() });
    const before = Number(chatTotalCost(getActiveChat()).toFixed(6));
    mergeRemoteSnapshot({ chats: [chat] });
    return { before, after: Number(chatTotalCost(getActiveChat()).toFixed(6)), merged: getActiveChat().messages.some((m) => m.id === 'msg_remote') };
  });
  check('a Drive copy without costs (older page on another device) keeps every known cost', wiped.merged && wiped.after === wiped.before && wiped.before > 0, wiped);

  // 7. While the model writes a long tool call (a file, code), the counter keeps counting.
  await page.evaluate(() => { getActiveChat().approvalMode = 'auto'; window.__replies.push({ text: '', tools: [{ name: 'write_file', args: { path: 'largo.md', content: 'Una línea del archivo que el modelo escribe despacio.\n'.repeat(60) } }], toolChunk: 40, delay: 30 }, { text: 'Hecho.' }); });
  await send(page, 'Escribe un archivo largo');
  const counted = [];
  for (let k = 0; k < 6; k++) {
    await page.waitForTimeout(300);
    counted.push(await page.evaluate(() => { const m = getActiveChat().messages.slice(-1)[0]; return { live: Number((m.liveCost || 0).toFixed(6)), shown: (document.querySelector('#thread .message:last-child .msg-cost') || {}).textContent, step: (m.toolSteps || []).length }; }));
  }
  await idle(page);
  const writing = counted.filter((c) => !c.step);
  check('while a long tool call is being written the cost counts up live (shown too)', writing.length >= 3 && writing[writing.length - 1].live > writing[0].live && writing[writing.length - 1].shown !== writing[0].shown, counted);

  // 8. A new chat starts at zero: the previous chat's total never leaks onto it.
  const oldId = await page.evaluate(() => appState.activeChatId);
  const fresh = await page.evaluate(() => {
    const was = { hidden: document.getElementById('chat-cost').classList.contains('hidden'), total: Number(chatTotalCost(getActiveChat()).toFixed(6)) };
    newChat();
    const el = document.getElementById('chat-cost');
    return { was, hidden: el.classList.contains('hidden'), text: el.textContent, cost: el.dataset.cost, key: el.dataset.costFor, id: appState.activeChatId, zero: el.classList.contains('zero') };
  });
  check('a new chat starts at zero (the old chat\'s total never leaks above the send button)', fresh.was.total > 0 && !fresh.was.hidden && !fresh.hidden && fresh.text === '$0.0000' && fresh.cost === '0' && fresh.zero && fresh.key === 'chat:' + fresh.id, fresh);
  const back = await page.evaluate((id) => { appState.activeChatId = id; renderThread(); const el = document.getElementById('chat-cost'); const chat = appState.chats.find((c) => c.id === id); return { hidden: el.classList.contains('hidden'), zero: el.classList.contains('zero'), ok: el.dataset.costFor === 'chat:' + id && Math.abs(Number(el.dataset.cost) - chatTotalCost(chat)) < 1e-9 }; }, oldId);
  check('…and switching back to the old chat brings its total with it', !back.hidden && !back.zero && back.ok, back);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
