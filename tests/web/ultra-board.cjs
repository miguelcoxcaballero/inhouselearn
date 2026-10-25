// Ultra code's agents board (ultra.js + ultra.css) on its own: a fake answer
// with a spawn_agents step is patched three times (queued → running →
// done/error/stopped, two waves, a verifier, files with a conflict). The
// lanes and their orbs must be the SAME nodes across patches (animations
// survive), the waves get headers, the clock ticks, a lane opens to its
// result, nothing scrolls sideways at 390 px, reduced motion stops every
// animation and the dark theme has its own tokens. Then the approval queue
// above the composer: two requests at once wait in line (agent chip,
// «+1 en espera»), both resolve, and dockApprovalClear answers «no».
const { chromium } = require('playwright');
const { openApp, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : '')); };
let failed = 0;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 860 }, isMobile: true, hasTouch: true });

  // Until index.html loads them itself, the board's files are added here
  // (the sheet before theme.css, as the page will).
  await page.evaluate(async () => {
    if (!document.querySelector('link[href^="ultra.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'ultra.css?test=' + Date.now();
      const theme = document.querySelector('link[href^="theme.css"]');
      await new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; theme.parentNode.insertBefore(link, theme); });
    }
    if (!window.UltraAgents) {
      await new Promise((resolve) => { const s = document.createElement('script'); s.src = 'ultra.js?test=' + Date.now(); s.onload = resolve; s.onerror = resolve; document.head.appendChild(s); });
    }
  });

  await page.evaluate(() => {
    window.__haptics = [];
    const original = window.haptic;
    window.haptic = (style) => { window.__haptics.push(style); if (typeof original === 'function') original(style); };
    window.ultraCanStop = (stepId) => stepId === 'step-1' && window.__canStop !== false;
    window.__stops = [];
    window.ultraStopAgent = (stepId, agentId) => window.__stops.push(stepId + '/' + agentId);
    const thread = document.getElementById('thread');
    const article = document.createElement('article');
    article.className = 'message assistant';
    article.dataset.msgId = 'm-ultra';
    article.innerHTML = '<div class="message-body"><div class="bubble"><div class="bubble-content"><div class="slot-steps"></div><div class="slot-agents"></div><div class="md-root"></div></div></div></div>';
    thread.appendChild(article);
    article.scrollIntoView({ block: 'start' });
    const now = Date.now();
    const base = [
      { id: 'a1', name: 'Fuentes', role: 'explore', wave: 1, hue: 260, task: 'Busca tres fuentes sobre la fotosíntesis.', maxSteps: 30 },
      { id: 'a2', name: 'Esquema', role: 'build', wave: 1, hue: 330, task: 'Escribe el esquema en cinco puntos.', maxSteps: 30 },
      { id: 'a3', name: 'Ejemplos', role: 'build', wave: 1, hue: 200, task: 'Prepara dos ejemplos.', maxSteps: 30 },
      { id: 'a4', name: 'Redacción', role: 'build', wave: 2, hue: 40, task: 'Redacta el dossier con lo anterior.', deps: ['a1', 'a2'], maxSteps: 30 },
      { id: 'v', name: 'Verificador', role: 'verify', wave: 3, hue: 150, task: 'Comprueba los criterios.', maxSteps: 20 }
    ];
    const stage = (n) => {
      const agents = base.map((agent) => Object.assign({ status: 'queued', doing: 'En cola', cost: 0, steps: 0, trail: [], files: [] }, agent));
      if (n >= 1) {
        Object.assign(agents[0], { status: 'running', doing: 'Buscando «fotosíntesis»', cost: 0.0012, steps: 2, startedAt: now - 65000, kind: 'web', trail: [{ t: 'Buscado en internet', s: 'd', k: 'web', ms: 1200 }, { t: 'Leyendo una página', s: 'r', k: 'web' }] });
        Object.assign(agents[1], { status: 'running', doing: 'Leyendo apuntes.md', cost: 0.0008, steps: 1, startedAt: now - 64000, kind: 'read', trail: [{ t: 'Leyendo apuntes.md', s: 'r', k: 'read' }] });
        Object.assign(agents[2], { status: 'waiting', doing: 'Esperando tu aprobación', cost: 0.0004, steps: 1, startedAt: now - 64000, trail: [{ t: 'Guardando ejemplos.md', s: 'r', k: 'edit' }] });
      }
      if (n >= 2) {
        Object.assign(agents[0], { status: 'done', doing: 'Hecho', cost: 0.0031, steps: 4, endedAt: now - 20000, result: '## Fuentes\n\n1. **Campbell**, Biología.\n2. Khan Academy.\n\n`clorofila`', report: { artifacts: ['fuentes.md'], issues: ['Falta una fuente en castellano'] }, files: ['fuentes.md'], trail: [{ t: 'Buscado', s: 'd', k: 'web', ms: 1200 }, { t: 'Leído', s: 'd', k: 'web', ms: 2400 }, { t: 'Buscado en apuntes', s: 'd', k: 'search' }, { t: 'Guardado fuentes.md', s: 'd', k: 'edit' }] });
        Object.assign(agents[1], { status: 'error', doing: 'No terminó', cost: 0.0015, endedAt: now - 15000, result: 'Se cortó la conexión.', trail: [{ t: 'Leyendo apuntes.md', s: 'e', k: 'read' }] });
        Object.assign(agents[2], { status: 'stopped', doing: 'Detenido', cost: 0.0006, endedAt: now - 12000 });
        Object.assign(agents[3], { status: 'done', doing: 'Hecho', cost: 0.0042, startedAt: now - 19000, endedAt: now - 5000, result: 'Dossier escrito.', trail: [{ t: 'Guardado dossier.md', s: 'd', k: 'edit' }] });
        Object.assign(agents[4], { status: 'done', doing: 'Criterios comprobados', cost: 0.001, startedAt: now - 5000, endedAt: now - 1000, result: 'Dos de tres criterios cumplidos.' });
      }
      const step = { id: 'step-1', name: 'spawn_agents', status: n >= 2 ? 'done' : 'running', args: {}, output: '', agents, waves: 2, budget: 0.012 };
      if (n >= 2) {
        step.verify = { passed: true, checks: [{ criterion: 'Tres fuentes citadas', ok: true, evidence: 'fuentes.md' }, { criterion: 'Esquema de cinco puntos', ok: false, evidence: 'El agente Esquema falló' }] };
        step.files = [{ path: 'fuentes.md', agents: ['Fuentes'], conflict: false }, { path: 'dossier.md', agents: ['Redacción', 'Ejemplos'], conflict: true }];
      }
      return { id: 'm-ultra', role: 'assistant', toolSteps: [step] };
    };
    window.__ultraStage = stage;
    window.__ultraSlot = article.querySelector('.slot-agents');
  });

  const snapshot = () => page.evaluate(() => {
    const slot = window.__ultraSlot;
    const lanes = Array.from(slot.querySelectorAll('.ua-lane'));
    return {
      cards: slot.querySelectorAll('.ua-card').length,
      title: (slot.querySelector('.ua-title') || {}).textContent,
      clock: (slot.querySelector('.ua-clock') || {}).textContent,
      running: (slot.querySelector('.ua-card') || { dataset: {} }).dataset.running,
      statuses: lanes.map((lane) => lane.dataset.key + '=' + lane.dataset.status),
      order: lanes.map((lane) => lane.dataset.key.split(':')[1]),
      waveHeads: Array.from(slot.querySelectorAll('.ua-wave-head')).map((el) => el.textContent),
      segs: slot.querySelectorAll('.ua-segs > i').length,
      orbs: slot.querySelectorAll('.ua-lane .ua-orb').length,
      nodes: slot.querySelectorAll('.ua-constellation .ua-node').length,
      ticks: lanes.map((lane) => lane.querySelectorAll('.ua-tick').length),
      stops: lanes.filter((lane) => !lane.querySelector('.ua-stop').hidden).length,
      budget: (slot.querySelector('.ua-budget-text') || {}).textContent,
      laneTime: (slot.querySelector('.ua-lane[data-status="running"] .ua-time') || {}).textContent,
      doing: lanes.map((lane) => (lane.querySelector('.ua-doing-text:not(.out)') || {}).textContent)
    };
  });

  // 1. Queued: every agent waits.
  await page.evaluate(() => {
    window.__ultraSlot.innerHTML = window.UltraAgents.markupAll(window.__ultraStage(0));
    window.UltraAgents.patch(window.__ultraSlot, window.__ultraStage(0));
    const slot = window.__ultraSlot;
    window.__nodes = { lane: slot.querySelector('.ua-lane[data-key="step-1:a1"]'), orb: slot.querySelector('.ua-lane[data-key="step-1:a1"] .ua-orb'), card: slot.querySelector('.ua-card') };
  });
  const s0 = await snapshot();
  check('queued: one card, every lane «queued», the verifier pinned last', s0.cards === 1 && s0.statuses.every((item) => /=queued$/.test(item)) && s0.order[s0.order.length - 1] === 'v', s0);
  check('two waves: «Oleada 1», «Oleada 2» and «Verificación» headers', s0.waveHeads.includes('Oleada 1') && s0.waveHeads.includes('Oleada 2') && s0.waveHeads.includes('Verificación'), s0.waveHeads);
  check('one segment, one orb and one constellation node per agent', s0.segs === 5 && s0.orbs === 5 && s0.nodes === 5, s0);

  // 2. Running.
  await page.evaluate(() => window.UltraAgents.patch(window.__ultraSlot, window.__ultraStage(1)));
  await page.waitForTimeout(1200);
  const s1 = await snapshot();
  const same1 = await page.evaluate(() => { const slot = window.__ultraSlot; return { lane: slot.querySelector('.ua-lane[data-key="step-1:a1"]') === window.__nodes.lane, orb: slot.querySelector('.ua-lane[data-key="step-1:a1"] .ua-orb') === window.__nodes.orb, card: slot.querySelector('.ua-card') === window.__nodes.card }; });
  check('running: data-status running / waiting, the title counts and names the wave', s1.statuses.includes('step-1:a1=running') && s1.statuses.includes('step-1:a3=waiting') && /^Trabajando · 0 de 5 · oleada 1\/2/.test(s1.title), s1);
  check('patched in place: same card, same lane, same orb node', same1.lane && same1.orb && same1.card, same1);
  check('the live clock ticks (data-live-since)', /(\d+:\d\d|\d+ s|\d+ min)/.test(s1.clock || '') && /s$/.test(s1.laneTime || ''), { clock: s1.clock, lane: s1.laneTime });
  check('the rail has one tick per trail item; stop buttons only on live lanes', JSON.stringify(s1.ticks) === JSON.stringify([2, 1, 1, 0, 0]) && s1.stops === 5, s1);
  const spinning = await page.evaluate(() => getComputedStyle(document.querySelector('.ua-lane[data-key="step-1:a1"] .ua-orb-ring')).animationName);
  check('a running orb spins in its colour', spinning === 'ua-spin', spinning);
  await page.click('.ua-lane[data-key="step-1:a2"] .ua-stop');
  const stops = await page.evaluate(() => window.__stops.slice());
  check('a lane\'s stop button calls ultraStopAgent(stepId, agentId)', stops[0] === 'step-1/a2', stops);
  const stopBox = await page.evaluate(() => { const r = document.querySelector('.ua-lane[data-key="step-1:a1"] .ua-stop').getBoundingClientRect(); return [r.width, r.height]; });
  check('stop button hit area is 32 px', stopBox[0] >= 32 && stopBox[1] >= 32, stopBox);

  // 3. Done / error / stopped.
  await page.evaluate(() => window.UltraAgents.patch(window.__ultraSlot, window.__ultraStage(2)));
  await page.waitForTimeout(100);
  const s2 = await snapshot();
  const same2 = await page.evaluate(() => { const slot = window.__ultraSlot; return { lane: slot.querySelector('.ua-lane[data-key="step-1:a1"]') === window.__nodes.lane, orb: slot.querySelector('.ua-lane[data-key="step-1:a1"] .ua-orb') === window.__nodes.orb, glow: slot.querySelector('.ua-card').classList.contains('ua-glow'), haptics: window.__haptics.filter((h) => h === 'success').length }; });
  check('finished: done / error / stopped statuses', s2.statuses.join(',') === 'step-1:a1=done,step-1:a2=error,step-1:a3=stopped,step-1:a4=done,step-1:v=done', s2.statuses);
  check('finished title: agents, waves, duration and «verificado ✓»; clock stops', /^5 agentes · 2 oleadas · .*s · verificado ✓$/.test(s2.title) && !s2.clock && s2.running === '0', s2);
  check('still the same lane and orb nodes after three patches', same2.lane && same2.orb, same2);
  check('the completion moment: one glow and one haptic(«success»)', same2.glow && same2.haptics === 1, same2);
  await page.evaluate(() => window.UltraAgents.patch(window.__ultraSlot, window.__ultraStage(2)));
  const again = await page.evaluate(() => window.__haptics.filter((h) => h === 'success').length);
  check('…only once per step', again === 1, again);
  const files = await page.evaluate(() => Array.from(document.querySelectorAll('.ua-files .ua-file')).map((el) => el.textContent + (el.classList.contains('conflict') ? '!' : '')));
  check('files row with the conflict highlighted', files.length === 2 && files.some((f) => /dossier\.md.*!$/.test(f)) && files.some((f) => /^fuentes\.md$/.test(f)), files);
  const checks = await page.evaluate(() => Array.from(document.querySelectorAll('.ua-lane[data-role="verify"] .ua-checks li')).map((li) => li.dataset.ok + ':' + li.querySelector('.ua-check-mark').textContent));
  check('the verifier lane lists its criteria ✓ / ✕', JSON.stringify(checks) === JSON.stringify(['1:✓', '0:✕']), checks);
  const budget = s2.budget;
  const warn = await page.evaluate(() => !!document.querySelector('.ua-budget[data-warn]'));
  check('budget bar over 80% turns to the warning colour', /\d+% de \$0\.01/.test(budget || '') && warn, { budget, warn });

  // Expand a lane: the body is drawn only now, with the result as markdown.
  const before = await page.evaluate(() => document.querySelector('.ua-lane[data-key="step-1:a1"] .ua-body').innerHTML.length);
  await page.click('.ua-lane[data-key="step-1:a1"] .ua-lane-head');
  const opened = await page.evaluate(() => {
    const lane = document.querySelector('.ua-lane[data-key="step-1:a1"]');
    const body = lane.querySelector('.ua-body');
    return { expanded: lane.querySelector('.ua-lane-head').getAttribute('aria-expanded'), hidden: body.hidden, h2: !!body.querySelector('.ua-result h2'), strong: !!body.querySelector('.ua-result strong'), task: (body.querySelector('.ua-task') || {}).textContent, chips: Array.from(body.querySelectorAll('.ua-chip')).map((el) => el.textContent), steps: body.querySelectorAll('.ua-steps li').length };
  });
  check('a lane opens lazily: task, steps, result rendered as markdown, report chips', before === 0 && opened.expanded === 'true' && !opened.hidden && opened.h2 && opened.strong && /fotosíntesis/.test(opened.task) && opened.chips.includes('fuentes.md') && opened.chips.includes('Falta una fuente en castellano') && opened.steps === 4, opened);
  await page.evaluate(() => { window.copyTextToClipboard = (text) => { window.__copied = text; return Promise.resolve(); }; });
  await page.click('.ua-lane[data-key="step-1:a1"] [data-ua-copy]');
  await page.waitForTimeout(50);
  const copied = await page.evaluate(() => ({ text: window.__copied, label: document.querySelector('.ua-lane[data-key="step-1:a1"] [data-ua-copy]').textContent, toasts: (window.__inhouseNotices || []).length }));
  check('«Copiar» copies the result and says «Copiado» (no toast)', /Campbell/.test(copied.text || '') && copied.label === 'Copiado', copied);
  await page.waitForTimeout(1300);
  const relabel = await page.evaluate(() => document.querySelector('.ua-lane[data-key="step-1:a1"] [data-ua-copy]').textContent);
  check('…and back to «Copiar» after 1.2 s', relabel === 'Copiar', relabel);

  const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, card: (() => { const c = document.querySelector('.ua-card'); return c.scrollWidth - c.clientWidth; })() }));
  await page.screenshot({ path: SCRATCH + '/ultra-board-390.png', fullPage: false });
  check('no horizontal overflow at 390 px', overflow.doc <= overflow.win && overflow.card <= 1, overflow);

  // Reduced motion: no animation anywhere on the board.
  await page.evaluate(() => window.UltraAgents.patch(window.__ultraSlot, window.__ultraStage(1)));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => {
    const names = [];
    document.querySelectorAll('.ua-card, .ua-card *').forEach((el) => { const name = getComputedStyle(el).animationName; if (name && name !== 'none') names.push(el.className.baseVal !== undefined ? el.className.baseVal : el.className); });
    const before = getComputedStyle(document.querySelector('.ua-card'), '::before').animationName;
    return { names, before };
  });
  check('prefers-reduced-motion: animationName none everywhere', !reduced.names.length && reduced.before === 'none', reduced);
  const burst = await page.evaluate(() => { window.UltraAgents.burst(document.querySelector('.ua-badge')); return document.querySelectorAll('.ua-spark, .ua-burst-ring').length; });
  check('…and the activation burst draws nothing', burst === 0, burst);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const sparks = await page.evaluate(() => { window.UltraAgents.burst(document.querySelector('.ua-badge')); return { sparks: document.querySelectorAll('.ua-spark').length, ring: document.querySelectorAll('.ua-burst-ring').length }; });
  check('the activation burst: a ring and 14 sparks', sparks.sparks === 14 && sparks.ring === 1, sparks);

  // Dark theme: the same tokens, AMOLED values.
  const tokens = () => page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return ['--ua-accent', '--ua-ok', '--ua-err', '--ua-wait', '--ua-lane-bg', '--ua-read', '--ua-search', '--ua-edit', '--ua-web', '--ua-accent-soft'].map((name) => cs.getPropertyValue(name).trim()); });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const light = await tokens();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const dark = await tokens();
  check('dark theme tokens differ from light ones (all ten)', light.every((value, i) => value && dark[i] && value !== dark[i]), { light, dark });
  await page.screenshot({ path: SCRATCH + '/ultra-board-dark.png', fullPage: false });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // A new shape (an agent added) redraws the card; one agent hides the constellation.
  const single = await page.evaluate(() => {
    const message = window.__ultraStage(1);
    message.toolSteps[0].agents = message.toolSteps[0].agents.slice(0, 1);
    window.UltraAgents.patch(window.__ultraSlot, message);
    return { nodes: document.querySelectorAll('.ua-constellation').length, lanes: document.querySelectorAll('.ua-lane').length, heads: document.querySelectorAll('.ua-wave-head').length };
  });
  check('one agent: no constellation and no wave headers', single.nodes === 0 && single.lanes === 1 && single.heads === 0, single);

  // 4. The approval queue above the composer.
  const queue = await page.evaluate(async () => {
    const first = dockApprove({ title: 'Guardar archivo del chat', message: 'a.md', agent: 'Fuentes', agentHue: 260 });
    const second = dockApprove({ title: 'Editar archivo del chat', message: 'b.md', agent: 'Esquema', agentHue: 330 });
    await new Promise((r) => setTimeout(r, 30));
    const slot = document.getElementById('dock-approval');
    const shown1 = { title: slot.querySelector('.dock-approve-head b').textContent, chip: (slot.querySelector('.dock-agent-chip') || {}).textContent, waiting: (slot.querySelector('.dock-approve-queue') || {}).textContent, cards: slot.querySelectorAll('.dock-approve').length };
    let secondDone = false;
    second.then(() => { secondDone = true; });
    dockApprovalAnswer(true);
    const r1 = await first;
    await new Promise((r) => setTimeout(r, 10));
    const shown2 = { title: slot.querySelector('.dock-approve-head b').textContent, chip: (slot.querySelector('.dock-agent-chip') || {}).textContent, waitingHidden: slot.querySelector('.dock-approve-queue').hidden, secondDoneBefore: secondDone };
    slot.querySelector('[data-dock="approve"]').click();
    const r2 = await second;
    const empty = slot.innerHTML === '';
    // Clear: the shown one and the queued ones answer «no».
    const c1 = dockApprove({ title: 'Uno', agent: 'A' });
    const c2 = dockApprove({ title: 'Dos', agent: 'B' });
    dockApprovalClear();
    const cleared = [await c1, await c2];
    // Abort-aware: a queued request whose signal aborts leaves the line.
    const controller = new AbortController();
    const d1 = dockApprove({ title: 'Visible' });
    const d2 = dockApprove({ title: 'En fila', signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    const waitingBefore = slot.querySelector('.dock-approve-queue').textContent;
    controller.abort();
    const aborted = await d2;
    const waitingAfter = slot.querySelector('.dock-approve-queue').hidden;
    dockApprovalAnswer(true);
    const d1r = await d1;
    return { shown1, r1, shown2, r2, empty, cleared, waitingBefore, aborted, waitingAfter, d1r, afterAll: slot.innerHTML };
  });
  check('two approvals at once: the second waits; agent chip and «+1 en espera»', queue.shown1.cards === 1 && queue.shown1.title === 'Guardar archivo del chat' && queue.shown1.chip === 'Fuentes' && queue.shown1.waiting === '+1 en espera', queue.shown1);
  check('approving the first shows the second (still unresolved), approving it resolves both true', queue.r1 === true && queue.shown2.title === 'Editar archivo del chat' && queue.shown2.chip === 'Esquema' && queue.shown2.waitingHidden && !queue.shown2.secondDoneBefore && queue.r2 === true && queue.empty, queue);
  check('dockApprovalClear answers «no» to the shown and the queued one', JSON.stringify(queue.cleared) === '[false,false]', queue.cleared);
  check('a queued request whose signal aborts leaves the line («no»)', queue.waitingBefore === '+1 en espera' && queue.aborted === false && queue.waitingAfter && queue.d1r === true && queue.afterAll === '', queue);

  // approveChange forwards the agent and calls onWait(true/false) around the card.
  const gate = await page.evaluate(async () => {
    const chat = getActiveChat();
    const previous = chat.approvalMode;
    chat.approvalMode = 'ask';
    const waits = [];
    const pending = approveChange(chat, { title: 'Guardar', agent: 'Redacción', agentHue: 40, onWait: (value) => waits.push(value) });
    await new Promise((r) => setTimeout(r, 10));
    const chip = (document.querySelector('#dock-approval .dock-agent-chip') || {}).textContent;
    const during = waits.slice();
    dockApprovalAnswer(true);
    const ok = await pending;
    chat.approvalMode = 'full';
    const autoWaits = [];
    const auto = await approveChange(chat, { title: 'Guardar', onWait: (value) => autoWaits.push(value) });
    // Wrapped workspace tools carry the meta into their approvals.
    chat.approvalMode = 'ask';
    const seen = [];
    const tools = approvalWorkspaceTools(chat, [{ name: 'write_file', execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }], { agent: 'Ejemplos', agentHue: 200, onWait: (value) => seen.push(value) });
    const run = tools[0].execute('t1', { path: 'x.md', content: 'hola' });
    await new Promise((r) => setTimeout(r, 10));
    const toolChip = (document.querySelector('#dock-approval .dock-agent-chip') || {}).textContent;
    dockApprovalAnswer(true);
    await run;
    chat.approvalMode = previous;
    return { chip, during, waits, ok, auto, autoWaits, toolChip, seen };
  });
  check('approveChange: agent chip on the card, onWait(true) then onWait(false)', gate.chip === 'Redacción' && JSON.stringify(gate.during) === '[true]' && JSON.stringify(gate.waits) === '[true,false]' && gate.ok === true, gate);
  check('auto-approved changes never call onWait', gate.auto === true && gate.autoWaits.length === 0, gate);
  check('approvalWorkspaceTools forwards meta (agent, onWait) into its approvals', gate.toolChip === 'Ejemplos' && JSON.stringify(gate.seen) === '[true,false]', gate);

  // The live activity: retry line, «Coordinando N agentes» with mini orbs, then «Integrando…».
  const live = await page.evaluate(() => {
    const message = window.__ultraStage(1);
    message.pending = true;
    message.content = '';
    message.liveRetry = { attempt: 1, max: 2 };
    const holder = document.createElement('div');
    holder.innerHTML = renderLiveSteps(message, message.toolSteps);
    const during = { text: holder.querySelector('.live-now-text b').textContent, orbs: holder.querySelectorAll('.live-orbs i').length, retry: (holder.querySelector('.live-retry') || {}).textContent };
    const done = window.__ultraStage(2);
    done.pending = true;
    done.content = '';
    holder.innerHTML = renderLiveSteps(done, done.toolSteps);
    return { during, after: holder.querySelector('.live-now-text b').textContent, retryAfter: !!holder.querySelector('.live-retry') };
  });
  check('live row: «Coordinando 5 agentes» with 5 mini orbs and «Reintentando (1/2)…»', live.during.text === 'Coordinando 5 agentes' && live.during.orbs === 5 && live.during.retry === 'Reintentando (1/2)…', live);
  check('…then «Integrando lo de 5 agentes», no retry line', live.after === 'Integrando lo de 5 agentes' && !live.retryAfter, live);

  check('no JavaScript errors', !errors.length, errors);
  await browser.close();
  console.log(failed ? 'ultra-board: ' + failed + ' FAILED' : 'ultra-board: all PASS');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
