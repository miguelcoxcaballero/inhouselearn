// Estudio: the button above the account opens a full screen over the chat
// (the chats UI stays as it is), a subject with its exam, hours and weighted
// topics gets a plan with spaced reviews, «Hecho» updates the topic, «Empezar»
// opens a new chat of that subject with the task sent; the model saves memory
// (shown and forgettable in «Lo que sé de ti»), creates subjects, reports
// results (mistakes listed, most expensive first) and searches other chats.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 600) : ''));
const OUT = path.join(SCRATCH, 'study');
fs.mkdirSync(OUT, { recursive: true });
const inDays = (n) => { const d = new Date(Date.now() + n * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const prompts = [];
  await page.exposeFunction('__seenPrompt', (text) => prompts.push(text));
  await page.evaluate(() => {
    const orig = window.fetch;
    window.fetch = (input, init) => {
      try { const body = JSON.parse((init && init.body) || '{}'); if (body.messages && body.messages[0] && body.messages[0].role === 'system') { const last = body.messages.filter((m) => m.role === 'user').pop(); window.__seenPrompt(String(body.messages[0].content) + '\n' + (last ? JSON.stringify(last.content) : '')); } } catch (_) {}
      return orig(input, init);
    };
    InhouseStudy._reset();
    getActiveChat().approvalMode = 'auto';
  });

  // An older chat to find with recall.
  await page.evaluate(() => window.__replies.push({ text: 'La regla de la cadena: derivas la función de fuera y multiplicas por la derivada de dentro.' }));
  await send(page, 'Explícame la regla de la cadena');
  await idle(page);
  const oldChat = await page.evaluate(() => appState.activeChatId);

  // 1. The button sits above the account; the chats list is still there.
  await page.click('#hamburger-btn');
  await page.waitForTimeout(400);
  const place = await page.evaluate(() => {
    const b = document.getElementById('study-btn').getBoundingClientRect();
    const a = document.querySelector('.sidebar-account').getBoundingClientRect();
    const n = document.getElementById('new-chat-btn').getBoundingClientRect();
    return { above: b.bottom <= a.top + 1, gap: Math.round(a.top - b.bottom), overlapNew: !(n.bottom <= b.top || n.top >= b.bottom), rows: document.querySelectorAll('.chat-item').length, sub: document.getElementById('study-btn-sub').textContent };
  });
  await page.screenshot({ path: OUT + '/sidebar.png' });
  check('«Estudio» sits right above the Google account, the chats list stays', place.above && place.gap < 24 && !place.overlapNew && place.rows >= 1, place);

  // 2. Empty state, then a subject through the form.
  await page.click('#study-btn');
  await page.waitForSelector('#study-view:not(.hidden)');
  await page.waitForTimeout(350);
  const empty = await page.evaluate(() => document.querySelector('#study-view .study-hero h2').textContent);
  await page.screenshot({ path: OUT + '/empty.png' });
  await page.click('[data-study="new-space"]');
  await page.fill('.study-form [name="name"]', 'Análisis II');
  await page.fill('.study-form [name="examDate"]', inDays(20));
  await page.fill('.study-form [name="hoursWeek"]', '6');
  await page.fill('.study-form [name="topics"]', 'Límites · 2\nDerivadas · 3\nIntegrales · 3\nSeries\nEcuaciones diferenciales · 2');
  await page.screenshot({ path: OUT + '/form.png' });
  await page.click('.study-form [type="submit"]');
  const subject = await page.evaluate(() => { const sp = InhouseStudy.spaces()[0]; return sp && { name: sp.name, topics: sp.topics.map((t) => t.name + ':' + t.weight), hours: sp.hoursWeek, cards: document.querySelectorAll('#study-view .study-card').length, strip: document.querySelectorAll('#study-view .study-day').length }; });
  await page.screenshot({ path: OUT + '/subjects.png', fullPage: false });
  check('empty state, then the form saves a subject with weighted topics and shows its days', /Sin asignaturas|Organiza/.test(empty) && subject && subject.name === 'Análisis II' && subject.topics.join('|') === 'Límites:2|Derivadas:3|Integrales:3|Series:1|Ecuaciones diferenciales:2' && subject.strip === 10, { empty, subject });

  // 3. Hoy: the plan of today; «Hecho» marks it and the topic moves.
  await page.click('[data-study="tab"][data-tab="hoy"]');
  const today = await page.evaluate(() => ({ items: [...document.querySelectorAll('.study-today li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()), title: document.querySelector('.study-hero h2').textContent }));
  await page.screenshot({ path: OUT + '/today.png' });
  await page.click('.study-today li:first-child .study-check');
  const after = await page.evaluate(() => ({ done: document.querySelector('.study-today li:first-child').classList.contains('done'), seen: InhouseStudy.spaces()[0].topics.filter((t) => t.seenAt).map((t) => t.name), sub: document.getElementById('study-btn-sub').textContent }));
  check('Hoy lists today\'s sessions (the heaviest topics first) with minutes', today.items.length >= 1 && /Derivadas|Integrales/.test(today.items[0]) && /min/.test(today.items[0]) && /para hoy/.test(today.title), today);
  check('«Hecho» crosses it out, counts as practice and updates the sidebar button', after.done && after.seen.length === 1 && /Hoy: \d+ · \d+ min|Hoy ya está hecho/.test(after.sub), after);

  // 4. «Empezar»: a new chat of that subject, the task already sent.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'study_overview', args: { space: 'Análisis II' } }, { name: 'study_result', args: { space: 'Análisis II', topic: 'Integrales', correct: false, mistake: 'elige mal u y dv' } }, { name: 'study_result', args: { space: 'Análisis II', topic: 'integrales', correct: true } }] }, { text: 'Vamos con la primera pregunta.' }));
  await page.click('[data-study="tab"][data-tab="asignaturas"]');
  await page.click('[data-study="start"][data-kind="simulacro"]');
  await idle(page);
  const started = await page.evaluate(() => {
    const chat = getActiveChat();
    const sp = InhouseStudy.spaces()[0];
    const steps = chat.messages.slice(-1)[0].toolSteps || [];
    return { hidden: document.getElementById('study-view').classList.contains('hidden'), linked: sp.chatIds.includes(chat.id), first: chat.messages[0] && chat.messages[0].content.slice(0, 60), overview: (steps[0] || {}).output || '', result: (steps[1] || {}).output || '', mistakes: InhouseStudy.mistakes().map((m) => m.topic + ':' + m.cause) };
  });
  check('«Empezar» closes Estudio and starts a chat of the subject with the task', started.hidden && started.linked && /Simulacro de examen de Análisis II/.test(started.first), started);
  check('study_overview gives topics by priority, the days and the rules; study_result moves mastery and logs the mistake', /Temas por prioridad/.test(started.overview) && /Próximos días/.test(started.overview) && /«Integrales»: fallo apuntado/.test(started.result) && started.mistakes.join() === 'Integrales:elige mal u y dv', started);
  const studyPrompt = prompts.filter((p) => /Herramientas de este chat/.test(p)).pop() || '';
  check('a chat of the subject tells the model where the user stands', /Este chat es de la asignatura «Análisis II»/.test(studyPrompt) && /faltan 20 días/.test(studyPrompt) && /Hoy toca/.test(studyPrompt), (studyPrompt.match(/Este chat es[^\n]*/) || [''])[0].slice(0, 300));

  // 5. The model remembers, creates a subject, searches old chats.
  await page.evaluate((date) => window.__replies.push({ text: '', tools: [
    { name: 'memory_save', args: { text: 'Prefiere un dibujo antes de la fórmula', kind: 'preferencia' } },
    { name: 'study_space', args: { name: 'Física', exam_date: date, hours_week: 3, topics: [{ name: 'Cinemática', weight: 2 }, { name: 'Dinámica', weight: 3 }] } },
    { name: 'recall', args: { query: 'regla de la cadena' } }
  ] }, { text: 'Hecho.' }), inDays(9));
  await send(page, 'Tengo examen de Física');
  await idle(page);
  const model = await page.evaluate(() => { const steps = getActiveChat().messages.slice(-1)[0].toolSteps; return { mem: steps[0].output, space: steps[1].output, recall: steps[2].output, spaces: InhouseStudy.spaces().map((s) => s.name) }; });
  check('memory_save, study_space and recall (with the old chat\'s link)', /Recordado/.test(model.mem) && /Guardada «Física»/.test(model.space) && model.spaces.join() === 'Análisis II,Física' && model.recall.includes('?c=' + oldChat) && /regla de la cadena/i.test(model.recall), model);
  await page.evaluate(() => window.__replies.push({ text: 'Claro.' }));
  await send(page, 'Gracias');
  await idle(page);
  check('…and the next turn starts with what it knows of the user', /Prefiere un dibujo antes de la fórmula/.test(prompts.filter((p) => /Herramientas de este chat/.test(p)).pop() || ''));

  // 6. Lo que sé de ti / Errores, and forgetting.
  await page.evaluate(() => InhouseStudyView.open('memoria'));
  await page.waitForTimeout(350);
  const mem = await page.evaluate(() => [...document.querySelectorAll('.study-mem li')].map((li) => li.innerText.replace(/\s+/g, ' ')));
  await page.screenshot({ path: OUT + '/memory.png' });
  await page.click('.study-mem li [data-study="forget"]');
  const forgotten = await page.evaluate(() => InhouseStudy.memory().length);
  await page.click('[data-study="tab"][data-tab="errores"]');
  const errs = await page.evaluate(() => document.querySelector('.study-errors').innerText);
  await page.screenshot({ path: OUT + '/errors.png' });
  check('«Lo que sé de ti» shows the memory with its chat, and «Olvidar» removes it', mem.length === 1 && /Prefiere un dibujo/.test(mem[0]) && forgotten === 0, mem);
  check('«Errores» lists the most expensive mistakes', /Integrales/.test(errs) && /elige mal u y dv/.test(errs), errs);

  // 7. Back to the chats exactly as they were; the dark theme too.
  await page.click('[data-study="close"]');
  const back = await page.evaluate(() => ({ hidden: document.getElementById('study-view').classList.contains('hidden'), thread: document.querySelectorAll('#thread .message').length }));
  check('«Chats» goes back to the open chat', back.hidden && back.thread >= 2, back);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; InhouseStudyView.open('asignaturas'); });
  await page.waitForTimeout(350);
  await page.screenshot({ path: OUT + '/subjects-dark.png' });
  await page.evaluate(() => InhouseStudyView.open('hoy'));
  await page.waitForTimeout(350);
  await page.screenshot({ path: OUT + '/today-dark.png' });
  const overflow = await page.evaluate(() => document.querySelector('.study-body').scrollWidth > document.querySelector('.study-body').clientWidth + 1);
  check('no horizontal overflow on a phone', !overflow);

  // 8. Another device's study.json merges item by item: newer wins, deletions stay.
  const merged = await page.evaluate(() => {
    const local = JSON.parse(JSON.stringify(InhouseStudy.state));
    const remote = JSON.parse(JSON.stringify(local));
    const fisica = remote.spaces.find((s) => s.name === 'Física');
    fisica.hoursWeek = 5; fisica.updatedAt = new Date(Date.now() + 60000).toISOString();
    const analisis = remote.spaces.find((s) => s.name === 'Análisis II');
    analisis.hoursWeek = 1; analisis.updatedAt = '2000-01-01T00:00:00.000Z';
    remote.memory.push({ id: 'mem_remote', text: 'Le cuesta madrugar', kind: 'dato', updatedAt: new Date().toISOString() });
    remote.memory.push({ id: 'mem_gone', text: 'Borrado en el otro', kind: 'dato', deleted: true, updatedAt: new Date().toISOString() });
    const changed = InhouseStudy.merge(remote);
    return { changed, fisica: InhouseStudy.findSpace('Física').hoursWeek, analisis: InhouseStudy.findSpace('Análisis II').hoursWeek, memory: InhouseStudy.memory().map((m) => m.text) };
  });
  check('another device\'s study.json merges by item (newer wins, deleted stays deleted)', merged.changed && merged.fisica === 5 && merged.analisis === 6 && merged.memory.join() === 'Le cuesta madrugar', merged);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
