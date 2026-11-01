// Nothing turns once the turn is over. The plan (update_plan) spins its step «in
// progress» only while the answer is being written; stopped, failed, reloaded
// mid-way or simply ended, the plan card, the steps and the reasoning stay still
// and say how it ended. Also: a turn another device was answering that went
// quiet ends here instead of spinning for ever.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 700, height: 900 } });

  // What is animating inside the last answer's activity (the element and its ::before/::after).
  const moving = () => page.evaluate(() => {
    const root = document.querySelector('#thread .message:last-child .activity');
    if (!root) return ['(no activity)'];
    const out = [];
    [root].concat(Array.from(root.querySelectorAll('*'))).forEach((el) => {
      ['', '::before', '::after'].forEach((pseudo) => {
        const name = getComputedStyle(el, pseudo || null).animationName;
        if (name && name !== 'none') out.push((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) + pseudo + ':' + name);
      });
    });
    return out;
  });
  const plan = (items) => ({ text: '', tools: [{ name: 'update_plan', args: { items } }] });
  const items = [{ text: 'Leer los apuntes', status: 'done' }, { text: 'Escribir el resumen', status: 'in_progress' }, { text: 'Revisarlo', status: 'pending' }];
  const cardOf = () => page.evaluate(() => {
    const card = document.querySelector('#thread .message:last-child .plan-card');
    return card && { state: card.dataset.state, count: card.querySelector('.plan-count').textContent, items: Array.from(card.querySelectorAll('li')).map((li) => li.className) };
  });

  // 1. While it is written: the plan alone already draws, its step spins, «now» pings.
  await page.evaluate((list) => window.__replies.push(
    { text: '', tools: [{ name: 'update_plan', args: { items: list } }] },
    { text: 'Escribiendo el resumen poco a poco, con calma, para verlo en directo.', reasoning: 'Voy a escribirlo en tres partes.', chunk: 3, delay: 90 }
  ), items);
  await send(page, 'Haz un resumen');
  await page.waitForSelector('#thread .message:last-child .plan-card[data-state="live"]', { timeout: 15000 });
  await page.waitForFunction(() => appState.busy && (getActiveChat().messages.slice(-1)[0].content || '').length > 8, null, { timeout: 15000 });
  const live = { card: await cardOf(), moving: await moving() };
  check('while it is written the plan draws (even with no other step) and its step spins', live.card && live.card.state === 'live' && live.card.items.join() === 'done,in_progress,pending' && live.moving.some((name) => /plan-mark:plan-spin/.test(name)), live);
  await idle(page, 30000);

  // 2. It simply ended with a step left in progress: still, no «interrupted» note.
  const ended = { card: await cardOf(), moving: await moving() };
  check('once the answer ended nothing in its activity moves, and the step left open is a plain empty ring', ended.card && ended.card.state === 'open' && ended.card.items.join() === 'done,pending,pending' && !/interrumpido/.test(ended.card.count) && ended.moving.length === 0, ended);

  // 3. Stopped midway: still, marked as interrupted (a dash in the ring and the note).
  await page.evaluate((list) => window.__replies.push(
    { text: '', tools: [{ name: 'update_plan', args: { items: list } }] },
    { text: 'Una respuesta larga que voy a parar enseguida, mientras el plan sigue en marcha.', reasoning: 'Pienso despacio.', chunk: 2, delay: 140 }
  ), items);
  await send(page, 'Otro resumen');
  await page.waitForSelector('#thread .message:last-child .plan-card[data-state="live"]', { timeout: 15000 });
  await page.waitForFunction(() => appState.busy && (getActiveChat().messages.slice(-1)[0].content || '').length > 6, null, { timeout: 15000 });
  await page.click('#send-btn');
  await page.waitForFunction(() => !appState.busy, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const stopped = { card: await cardOf(), moving: await moving(), flag: await page.evaluate(() => getActiveChat().messages.slice(-1)[0].interrupted === true) };
  check('stopped midway: the plan says «interrumpido» with a still ring and dash, and nothing moves', stopped.card && stopped.card.state === 'halted' && stopped.card.items.join() === 'done,halted,pending' && /interrumpido/.test(stopped.card.count) && stopped.flag && stopped.moving.length === 0, stopped);

  // 4. A saved answer left halfway (tool step still «running», plan in progress): reading it settles it.
  const left = await page.evaluate(() => {
    const message = { id: 'm-left', role: 'assistant', pending: false, content: '', toolSteps: [
      { id: 'p1', name: 'update_plan', status: 'done', args: { items: [{ text: 'Leer', status: 'done' }, { text: 'Escribir', status: 'in_progress' }, { text: 'Revisar', status: 'pending' }] } },
      { id: 'r1', name: 'read_file', status: 'running', args: { path: 'a.md' }, output: '' }
    ] };
    const cardOf = () => { const holder = document.createElement('div'); holder.innerHTML = renderStepPlanCard(message); const card = holder.querySelector('.plan-card'); return { state: card.dataset.state, items: Array.from(card.querySelectorAll('li')).map((li) => li.className) }; };
    const before = cardOf();
    const found = settleTurnSteps(message, false);
    return { before, found, after: cardOf(), step: message.toolSteps[1].status, flag: message.interrupted, summary: renderToolStepsMarkup(message).includes('detenido') };
  });
  check('an old save with a step stuck «running» is settled: stopped, interrupted, the plan card halted', left.before.state === 'open' && left.found === true && left.step === 'stopped' && left.flag === true && left.after.state === 'halted' && left.after.items.join() === 'done,halted,pending' && left.summary, left);

  // 5. A turn that another device was answering and that went quiet ends here.
  const swept = await page.evaluate(() => {
    const chat = getActiveChat();
    const message = { id: 'm-remote', role: 'assistant', pending: true, remoteLive: true, liveAt: Date.now() - 4 * 60 * 1000, content: 'A medias', parts: [{ text: 'A medias' }], thinking: '', attachments: [], alternatives: [], activeAlternative: 0, createdAt: new Date().toISOString(), cost: 0, liveCost: 0.01, toolSteps: [{ id: 's1', name: 'web_search', status: 'running', args: { query: 'x' }, output: '' }] };
    chat.messages.push(message);
    renderThread({ preserveScroll: true });
    const before = !!document.querySelector('[data-msg-id="m-remote"] .live-now');
    const fresh = Object.assign({}, message, { id: 'm-fresh', liveAt: Date.now() });
    chat.messages.push(fresh);
    sweepStaleRemoteTurns();
    const el = document.querySelector('[data-msg-id="m-remote"]');
    return { before, pending: message.pending, interrupted: message.interrupted, live: !!(el && el.querySelector('.live-now, .live-spin')), cost: message.cost, step: message.toolSteps[0].status, freshStillLive: fresh.pending === true };
  });
  check('a quiet turn from another device stops being live (no spinner, cost kept), a recent one is left alone', swept.before && swept.pending === false && swept.interrupted === true && !swept.live && swept.cost === 0.01 && swept.step === 'stopped' && swept.freshStillLive, swept);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
