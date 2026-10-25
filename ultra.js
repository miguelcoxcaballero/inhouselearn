/* ─── Ultra code: el tablero de los agentes ──────────────────────────
   Una tarjeta por cada paso spawn_agents de una respuesta: cabecera con
   el progreso, el reloj, el coste total y el presupuesto; una barra de
   segmentos (uno por agente); una constelación opcional (el agente
   principal en el centro, un nodo por agente); y un carril por agente,
   agrupados por oleadas, con su orbe de estado, su rastro de pasos y lo
   que está haciendo. El verificador va siempre el último, con sus
   criterios. Debajo, los archivos que han tocado (los choques, marcados).

   The card is patched IN PLACE: every lane is keyed (data-key =
   stepId:agentId) and only its attributes and small texts change, so the
   DOM nodes survive updates and running CSS animations (spinning rings,
   flowing edges, the orbit border) never restart. The whole card is drawn
   again only when its shape changes (agents, waves or roles). Bodies are
   rendered lazily, when a lane is opened.

   Data: step.agents (engine/src/agents.js) plus waves, budget, verify and
   files, read from the step itself or from step.details.

   Loaded before the main script of index.html; uses its globals at call
   time (escapeHtml, costCounterMarkup, kickCostCounters, renderMarkdown,
   enhanceRichContent, copyTextToClipboard, haptic) and, when present,
   window.ultraCanStop / window.ultraStopAgent (per-lane stop buttons). */

(function () {
  const ROLE_LABEL = { explore: 'Explora', build: 'Construye', verify: 'Verifica', review: 'Verifica' };
  const STATUS_LABEL = {
    queued: 'En cola', running: 'Trabajando', waiting: 'Esperando tu aprobación',
    done: 'Hecho', error: 'Con error', stopped: 'Detenido', skipped: 'Omitido'
  };
  const LIVE = /^(queued|running|waiting)$/;
  const SPARK_PALETTE = ['#a78bfa', '#f472b6', '#38bdf8', '#c4b5fd', '#f9a8d4', '#7dd3fc'];
  // Cards whose completion moment already played (once per step id).
  const celebrated = new Set();
  // Steps this page saw running: if a full redraw shows them finished before
  // the last patch did, the completion moment still plays once.
  const seenRunning = new Set();
  // The latest data each card was drawn with: the click handlers need it for
  // the lazy bodies and «Copiar» (never kept in the DOM, it can be large).
  const cardData = new WeakMap();
  let bound = null;

  // A registered angle makes the orbit border turn smoothly; without it the
  // border stays still (an unregistered custom property only jumps).
  let orbit = false;
  try {
    if (window.CSS && typeof CSS.registerProperty === 'function') {
      CSS.registerProperty({ name: '--ua-a', syntax: '<angle>', inherits: false, initialValue: '0deg' });
      orbit = true;
    }
  } catch (_) { orbit = true; /* already registered (CSS @property) */ }
  let motionPath = false;
  try { motionPath = !!(window.CSS && CSS.supports && CSS.supports('offset-path', "path('M0 0 L1 1')")); } catch (_) {}

  const esc = (value) => (typeof escapeHtml === 'function' ? escapeHtml(value) : String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  function fmtDuration(ms) {
    if (typeof formatSeconds === 'function') return formatSeconds(ms);
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  }

  function hueOf(agent, index) {
    const hue = Number(agent && agent.hue);
    return Number.isFinite(hue) ? ((Math.round(hue) % 360) + 360) % 360 : (index * 67 + 260) % 360;
  }

  function costMarkup(id, value) {
    if (typeof costCounterMarkup === 'function') return costCounterMarkup(id, value);
    return '<span class="msg-cost" data-cost-for="' + esc(id) + '" data-cost="' + value + '">$' + value.toFixed(4) + '</span>';
  }

  function agentSteps(message) {
    const steps = message && Array.isArray(message.toolSteps) ? message.toolSteps : [];
    return steps.filter((step) => step && step.name === 'spawn_agents' && Array.isArray(step.agents) && step.agents.length);
  }

  // waves, budget, verify and files: on the step, or in its result details.
  function detailsOf(step) {
    const d = step.details && typeof step.details === 'object' ? step.details : {};
    const pick = (key) => (step[key] !== undefined ? step[key] : d[key]);
    const verify = pick('verify');
    const files = pick('files');
    return {
      waves: num(pick('waves')),
      budget: num(pick('budget')),
      verify: verify && typeof verify === 'object' ? verify : null,
      files: Array.isArray(files) ? files.slice(0, 40) : []
    };
  }

  function stepRunning(step) {
    if (step.status) return step.status === 'running';
    return step.agents.some((agent) => LIVE.test(agent.status));
  }

  // Display order: by wave, the verifier(s) pinned last. Each entry keeps its
  // index in step.agents (the cost counters are keyed by it).
  function layoutOf(step) {
    const entries = step.agents.map((agent, index) => ({ agent: agent || {}, index }));
    const isVerify = (entry) => entry.agent.role === 'verify' || entry.agent.role === 'review';
    const workers = entries.filter((entry) => !isVerify(entry));
    const verifiers = entries.filter(isVerify);
    const waveIds = Array.from(new Set(workers.map((entry) => num(entry.agent.wave)))).sort((a, b) => a - b);
    const groups = waveIds.map((wave, i) => ({ label: 'Oleada ' + (i + 1), wave, entries: workers.filter((entry) => num(entry.agent.wave) === wave) }));
    return { groups, verifiers, order: groups.flatMap((group) => group.entries).concat(verifiers), waveIds };
  }

  function shapeKey(step) {
    const layout = layoutOf(step);
    return layout.order.map((entry) => (entry.agent.id || entry.index) + '/' + num(entry.agent.wave) + '/' + (entry.agent.role || '')).join(',');
  }

  function agentKey(step, entry) {
    return step.id + ':' + (entry.agent.id != null ? entry.agent.id : entry.index);
  }

  function domId(text) {
    return 'ua-' + String(text).replace(/[^\w-]/g, '_');
  }

  function bounds(step) {
    let start = num(step.startedAt) || 0;
    let end = num(step.endedAt) || 0;
    step.agents.forEach((agent) => {
      const s = num(agent.startedAt);
      const e = num(agent.endedAt);
      if (s && (!start || s < start)) start = s;
      if (e && e > end) end = e;
    });
    return { start, end };
  }

  /* ─── Text ─────────────────────────────────────────────────────────── */

  function titleText(step, details, layout) {
    const total = step.agents.length;
    const finished = step.agents.filter((agent) => !LIVE.test(agent.status)).length;
    const waves = Math.max(details.waves, layout.waveIds.length, 1);
    if (stepRunning(step)) {
      let text = 'Trabajando · ' + finished + ' de ' + total;
      if (waves > 1) {
        const live = layout.groups.findIndex((group) => group.entries.some((entry) => LIVE.test(entry.agent.status)));
        const current = live >= 0 ? live + 1 : waves;
        text += ' · oleada ' + Math.min(current, waves) + '/' + waves;
      }
      return text;
    }
    const { start, end } = bounds(step);
    let text = total + (total === 1 ? ' agente' : ' agentes');
    if (waves > 1) text += ' · ' + waves + ' oleadas';
    if (start && end > start) text += ' · ' + fmtDuration(end - start);
    if (details.verify && details.verify.passed) text += ' · verificado ✓';
    return text;
  }

  function laneTime(agent) {
    const start = num(agent.startedAt);
    if (!start) return { text: '', since: 0 };
    if (LIVE.test(agent.status) && agent.status !== 'queued' && !agent.endedAt) return { text: fmtDuration(Date.now() - start), since: start };
    const end = num(agent.endedAt);
    return { text: end > start ? fmtDuration(end - start) : '', since: 0 };
  }

  // What a finished lane says: the start of its result (its summary when it
  // reported one), not a bare «Terminado».
  function resultPreview(agent) {
    const summary = agent.report && typeof agent.report === 'object' && agent.report.summary;
    let raw = String(summary || agent.result || '');
    // Only the «Resultado» section of the closing report, not the ones after it.
    const section = /^#+\s*(?:Resultado|Result)\s*\n([\s\S]*?)(?=^#+\s|$(?![\s\S]))/im.exec(raw);
    if (!summary && section && section[1].trim()) raw = section[1];
    const text = raw.replace(/[#*_`>]+/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 140) + (text.length > 140 ? '…' : '') : '';
  }

  function doingText(agent) {
    if (agent.status === 'done') {
      const preview = resultPreview(agent);
      if (preview) return preview;
    }
    const doing = String(agent.doing || '').trim();
    if (doing) return doing.slice(0, 160);
    return STATUS_LABEL[agent.status] || '';
  }

  function canStop(step, agent) {
    return LIVE.test(agent.status) && typeof window.ultraCanStop === 'function' && typeof window.ultraStopAgent === 'function' && !!window.ultraCanStop(step.id);
  }

  /* ─── Markup ───────────────────────────────────────────────────────── */

  const ORB = '<svg class="ua-orb" viewBox="0 0 20 20" aria-hidden="true">' +
    '<circle class="ua-orb-track" cx="10" cy="10" r="8"/>' +
    '<circle class="ua-orb-ring" cx="10" cy="10" r="8" pathLength="100"/>' +
    '<circle class="ua-orb-dot" cx="10" cy="10" r="3.2"/>' +
    '<path class="ua-orb-check" d="M6.2 10.4 8.8 13 13.9 7.4" pathLength="1"/>' +
    '<path class="ua-orb-x" d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" pathLength="1"/>' +
    '<path class="ua-orb-bar" d="M7 10h6"/>' +
    '</svg>';
  const CHEVRON = '<svg class="ua-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>';

  function tickMarkup(item) {
    return '<i class="ua-tick" data-k="' + esc(item.k || 'read') + '" data-s="' + esc(item.s || 'd') + '"></i>';
  }

  function checksMarkup(verify) {
    const checks = verify && Array.isArray(verify.checks) ? verify.checks.slice(0, 20) : [];
    if (!checks.length) return '';
    return checks.map((check) => '<li data-ok="' + (check.ok ? '1' : '0') + '"><span class="ua-check-mark" aria-hidden="true">' + (check.ok ? '✓' : '✕') + '</span>' +
      '<span class="ua-check-text">' + esc(String(check.criterion || '').slice(0, 200)) +
      (check.evidence ? '<small>' + esc(String(check.evidence).slice(0, 240)) + '</small>' : '') + '</span>' +
      '<span class="ua-sr">' + (check.ok ? 'cumplido' : 'no cumplido') + '</span></li>').join('');
  }

  function laneMarkup(message, step, entry, details, position) {
    const agent = entry.agent;
    const key = agentKey(step, entry);
    const hue = hueOf(agent, entry.index);
    const time = laneTime(agent);
    const trail = Array.isArray(agent.trail) ? agent.trail.slice(-24) : [];
    const isVerify = agent.role === 'verify' || agent.role === 'review';
    const checks = isVerify ? checksMarkup(details.verify) : '';
    const body = domId(message.id + '-' + key);
    return '<li class="ua-lane" data-key="' + esc(key) + '" data-status="' + esc(agent.status || 'queued') + '" data-role="' + esc(agent.role || 'build') + '"' +
      (agent.kind ? ' data-kind="' + esc(agent.kind) + '"' : '') +
      ' style="--i:' + position + ';--agent-hue:hsl(' + hue + ' 75% 60%)">' +
      '<div class="ua-lane-row">' +
      '<button type="button" class="ua-lane-head" aria-expanded="false" aria-controls="' + body + '">' +
      ORB +
      '<span class="ua-name" title="' + esc(agent.name || 'Agente') + '">' + esc(agent.name || 'Agente') + '</span>' +
      '<span class="ua-role">' + esc(ROLE_LABEL[agent.role] || ROLE_LABEL.build) + '</span>' +
      '<span class="ua-status-text ua-sr">' + esc(STATUS_LABEL[agent.status] || '') + '</span>' +
      '<span class="ua-time"' + (time.since ? ' data-live-since="' + time.since + '"' : '') + '>' + esc(time.text) + '</span>' +
      '<span class="ua-cost">' + costMarkup(message.id + ':agent:' + step.id + ':' + entry.index, num(agent.cost)) + '</span>' +
      CHEVRON +
      '</button>' +
      '<button type="button" class="ua-stop" data-ua-stop="' + esc(agent.id != null ? agent.id : entry.index) + '" aria-label="Detener ' + esc(agent.name || 'agente') + '" title="Detener este agente"' + (canStop(step, agent) ? '' : ' hidden') + '>' + STOP + '</button>' +
      '</div>' +
      '<div class="ua-rail" aria-hidden="true"><span class="ua-ticks">' + trail.map(tickMarkup).join('') + '</span><span class="ua-comet"></span></div>' +
      '<div class="ua-doing"><span class="ua-doing-text">' + esc(doingText(agent)) + '</span></div>' +
      (isVerify ? '<ul class="ua-checks"' + (checks ? '' : ' hidden') + '>' + checks + '</ul>' : '') +
      '<div class="ua-body" id="' + body + '" hidden></div>' +
      '</li>';
  }

  function segsMarkup(layout) {
    return layout.order.map((entry) => '<i data-status="' + esc(entry.agent.status || 'queued') + '" style="--agent-hue:hsl(' + hueOf(entry.agent, entry.index) + ' 75% 60%)"></i>').join('');
  }

  // Hub at the bottom centre, one node per agent on an arc above it.
  function constellationMarkup(step, layout) {
    const n = layout.order.length;
    if (n < 2) return '';
    const hub = { x: 160, y: 84 };
    const radius = 64;
    const parts = [];
    const nodes = [];
    layout.order.forEach((entry, i) => {
      const angle = Math.PI - ((i + 0.5) * Math.PI) / n;
      const x = Math.round((hub.x + Math.cos(angle) * radius * 1.9) * 10) / 10;
      const y = Math.round((hub.y - Math.sin(angle) * radius) * 10) / 10;
      const key = agentKey(step, entry);
      const hue = 'hsl(' + hueOf(entry.agent, entry.index) + ' 75% 60%)';
      const path = 'M' + x + ' ' + y + ' L' + hub.x + ' ' + hub.y;
      parts.push('<line class="ua-edge" data-key="' + esc(key) + '" data-status="' + esc(entry.agent.status || 'queued') + '" x1="' + x + '" y1="' + y + '" x2="' + hub.x + '" y2="' + hub.y + '" style="--agent-hue:' + hue + '"/>');
      nodes.push('<g class="ua-node" data-key="' + esc(key) + '" data-status="' + esc(entry.agent.status || 'queued') + '" style="--agent-hue:' + hue + '">' +
        '<circle class="ua-node-dot" cx="' + x + '" cy="' + y + '" r="6"/>' +
        '<text class="ua-node-label" x="' + x + '" y="' + (y - 10) + '" text-anchor="middle">' + esc(String(entry.agent.name || '').length > 14 ? String(entry.agent.name).slice(0, 13) + '…' : String(entry.agent.name || '')) + '<title>' + esc(entry.agent.name || '') + '</title></text>' +
        (motionPath ? '<circle class="ua-pulse" r="3" cx="0" cy="0" style="offset-path:path(\'' + path + '\')"/>' : '') +
        '</g>');
    });
    return '<svg class="ua-constellation" viewBox="0 0 320 96" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
      parts.join('') + nodes.join('') +
      '<circle class="ua-hub-halo" cx="' + hub.x + '" cy="' + hub.y + '" r="11"/>' +
      '<circle class="ua-hub" cx="' + hub.x + '" cy="' + hub.y + '" r="7"/></svg>';
  }

  function filesMarkup(details) {
    if (!details.files.length) return '';
    return details.files.map((file) => {
      const path = typeof file === 'string' ? file : String((file && file.path) || '');
      const agents = file && Array.isArray(file.agents) ? file.agents.join(', ') : '';
      const conflict = !!(file && file.conflict);
      return '<span class="ua-file' + (conflict ? ' conflict' : '') + '"' + (agents ? ' title="' + esc((conflict ? 'Choque: ' : '') + agents) + '"' : '') + '>' +
        (conflict ? '<b aria-hidden="true">!</b>' : '') + '<code>' + esc(path) + '</code>' + (conflict ? '<span class="ua-sr"> (choque)</span>' : '') + '</span>';
    }).join('');
  }

  function budgetMarkup(total, budget) {
    const ratio = budget > 0 ? Math.min(1, total / budget) : 0;
    return '<span class="ua-budget-bar"><i style="width:' + (ratio * 100).toFixed(1) + '%"></i></span>' +
      '<span class="ua-budget-text">' + Math.round(ratio * 100) + '% de $' + budget.toFixed(2) + '</span>';
  }

  function cardMarkup(message, step) {
    const details = detailsOf(step);
    const layout = layoutOf(step);
    const running = stepRunning(step);
    const total = step.agents.reduce((sum, agent) => sum + num(agent && agent.cost), 0);
    const { start } = bounds(step);
    const lanes = (entries, offset) => entries.map((entry, i) => laneMarkup(message, step, entry, details, offset + i)).join('');
    let body = '';
    let position = 0;
    if (layout.groups.length > 1) {
      layout.groups.forEach((group) => {
        body += '<div class="ua-wave" data-wave="' + esc(group.wave) + '"><div class="ua-wave-head">' + esc(group.label) + '</div><ol class="ua-lanes">' + lanes(group.entries, position) + '</ol></div>';
        position += group.entries.length;
      });
      if (layout.verifiers.length) body += '<div class="ua-wave ua-wave-verify"><div class="ua-wave-head">Verificación</div><ol class="ua-lanes">' + lanes(layout.verifiers, position) + '</ol></div>';
    } else {
      body = '<ol class="ua-lanes">' + lanes(layout.order, 0) + '</ol>';
    }
    const ratio = details.budget > 0 ? total / details.budget : 0;
    return '<section class="ua-card' + (orbit ? ' ua-orbit' : '') + '" data-step="' + esc(step.id) + '" data-msg="' + esc(message.id) + '" data-shape="' + esc(shapeKey(step)) + '" data-running="' + (running ? '1' : '0') + '" style="--n:' + step.agents.length + '" aria-label="Agentes de Ultra code">' +
      '<header class="ua-head">' +
      '<span class="ua-badge">Ultra</span>' +
      '<span class="ua-title" aria-live="polite">' + esc(titleText(step, details, layout)) + '</span>' +
      '<span class="ua-clock"' + (running && start ? ' data-live-since="' + start + '"' : '') + '>' + (running && start ? esc(fmtDuration(Date.now() - start)) : '') + '</span>' +
      '<span class="ua-total">' + costMarkup(message.id + ':agents:' + step.id, total) + '</span>' +
      '</header>' +
      '<div class="ua-budget"' + (details.budget > 0 ? '' : ' hidden') + (ratio > 0.8 ? ' data-warn="1"' : '') + '>' + (details.budget > 0 ? budgetMarkup(total, details.budget) : '') + '</div>' +
      '<div class="ua-segs" aria-hidden="true">' + segsMarkup(layout) + '</div>' +
      constellationMarkup(step, layout) +
      '<div class="ua-board">' + body + '</div>' +
      '<div class="ua-files"' + (details.files.length ? '' : ' hidden') + '>' + filesMarkup(details) + '</div>' +
      '</section>';
  }

  /* ─── Patching in place ────────────────────────────────────────────── */

  function setAttr(el, name, value) {
    if (!el) return;
    if (value === null || value === undefined) { if (el.hasAttribute(name)) el.removeAttribute(name); return; }
    const text = String(value);
    if (el.getAttribute(name) !== text) el.setAttribute(name, text);
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setHtml(el, html) {
    if (el && el.__uaHtml !== html) { el.__uaHtml = html; el.innerHTML = html; }
  }

  function setCost(holder, value) {
    const counter = holder && holder.querySelector('[data-cost-for]');
    if (!counter) return;
    const text = String(value);
    if (counter.dataset.cost !== text) {
      counter.dataset.cost = text;
      if (typeof kickCostCounters === 'function') kickCostCounters();
    }
  }

  // The doing text crossfades: the new line fades in over the old one.
  function setDoing(lane, text) {
    const holder = lane.querySelector('.ua-doing');
    if (!holder) return;
    const current = holder.querySelector('.ua-doing-text:not(.out)');
    if (current && current.textContent === text) return;
    if (!current || reducedMotion()) {
      holder.innerHTML = '<span class="ua-doing-text">' + esc(text) + '</span>';
      return;
    }
    holder.querySelectorAll('.ua-doing-text.out').forEach((el) => el.remove());
    current.classList.add('out');
    window.setTimeout(() => current.remove(), 260);
    const next = document.createElement('span');
    next.className = 'ua-doing-text in';
    next.textContent = text;
    holder.appendChild(next);
  }

  function patchTicks(lane, trail) {
    const holder = lane.querySelector('.ua-ticks');
    if (!holder) return;
    const items = trail.slice(-24);
    while (holder.children.length > items.length) holder.lastElementChild.remove();
    items.forEach((item, i) => {
      let tick = holder.children[i];
      if (!tick) {
        holder.insertAdjacentHTML('beforeend', tickMarkup(item));
        return;
      }
      setAttr(tick, 'data-k', item.k || 'read');
      setAttr(tick, 'data-s', item.s || 'd');
    });
  }

  function patchLane(lane, message, step, entry, details) {
    const agent = entry.agent;
    const previous = lane.dataset.status;
    const status = agent.status || 'queued';
    setAttr(lane, 'data-status', status);
    setAttr(lane, 'data-kind', agent.kind || null);
    // The error nudge plays once, when the lane turns red in front of you.
    if (previous && previous !== status && status === 'error') lane.classList.add('ua-just-failed');
    setText(lane.querySelector('.ua-status-text'), STATUS_LABEL[status] || '');
    const time = laneTime(agent);
    const timeEl = lane.querySelector('.ua-time');
    setAttr(timeEl, 'data-live-since', time.since || null);
    if (!time.since) setText(timeEl, time.text);
    else if (!timeEl.textContent) setText(timeEl, time.text);
    setCost(lane.querySelector('.ua-cost'), num(agent.cost));
    setAttr(lane.querySelector('.ua-stop'), 'hidden', canStop(step, agent) ? null : '');
    patchTicks(lane, Array.isArray(agent.trail) ? agent.trail : []);
    setDoing(lane, doingText(agent));
    const checks = lane.querySelector('.ua-checks');
    if (checks) {
      const html = checksMarkup(details.verify);
      setHtml(checks, html);
      setAttr(checks, 'hidden', html ? null : '');
    }
    const body = lane.querySelector('.ua-body');
    if (body && !body.hidden) renderBody(body, step, entry, details);
  }

  function patchCard(card, message, step) {
    if (stepRunning(step)) seenRunning.add(step.id);
    const details = detailsOf(step);
    const layout = layoutOf(step);
    const running = stepRunning(step);
    const wasRunning = card.dataset.running === '1';
    const total = step.agents.reduce((sum, agent) => sum + num(agent && agent.cost), 0);
    cardData.set(card, { message, step });
    setText(card.querySelector('.ua-title'), titleText(step, details, layout));
    const clock = card.querySelector('.ua-clock');
    const { start } = bounds(step);
    if (running && start) {
      setAttr(clock, 'data-live-since', start);
      if (!clock.textContent) setText(clock, fmtDuration(Date.now() - start));
    } else {
      setAttr(clock, 'data-live-since', null);
      setText(clock, '');
    }
    setCost(card.querySelector('.ua-total'), total);
    const budget = card.querySelector('.ua-budget');
    if (budget) {
      setAttr(budget, 'hidden', details.budget > 0 ? null : '');
      setAttr(budget, 'data-warn', details.budget > 0 && total / details.budget > 0.8 ? '1' : null);
      if (details.budget > 0) {
        if (!budget.querySelector('.ua-budget-bar')) budget.innerHTML = budgetMarkup(total, details.budget);
        const ratio = Math.min(1, total / details.budget);
        const bar = budget.querySelector('.ua-budget-bar i');
        if (bar) bar.style.width = (ratio * 100).toFixed(1) + '%';
        setText(budget.querySelector('.ua-budget-text'), Math.round(ratio * 100) + '% de $' + details.budget.toFixed(2));
      }
    }
    const segs = card.querySelectorAll('.ua-segs > i');
    layout.order.forEach((entry, i) => {
      setAttr(segs[i], 'data-status', entry.agent.status || 'queued');
      const key = agentKey(step, entry);
      const lane = card.querySelector('.ua-lane[data-key="' + cssEscape(key) + '"]');
      if (lane) patchLane(lane, message, step, entry, details);
      const node = card.querySelector('.ua-node[data-key="' + cssEscape(key) + '"]');
      if (node) {
        const before = node.getAttribute('data-status');
        setAttr(node, 'data-status', entry.agent.status || 'queued');
        // A pulse travels back to the hub when an agent hands in its work.
        if (before && LIVE.test(before) && entry.agent.status === 'done') node.classList.add('ua-return');
      }
      setAttr(card.querySelector('.ua-edge[data-key="' + cssEscape(key) + '"]'), 'data-status', entry.agent.status || 'queued');
    });
    const files = card.querySelector('.ua-files');
    if (files) {
      setHtml(files, filesMarkup(details));
      setAttr(files, 'hidden', details.files.length ? null : '');
    }
    card.dataset.running = running ? '1' : '0';
    return wasRunning && !running;
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
  }

  // Once per step id, only when it finishes in front of the reader (not on a
  // reload, which never saw it running, and not for another device's turn).
  function celebrate(card, stepId, options) {
    if (celebrated.has(stepId) || (options && options.remote) || document.hidden) return;
    const box = card.getBoundingClientRect();
    if (!(box.bottom > 0 && box.top < (window.innerHeight || 0))) return;
    celebrated.add(stepId);
    card.classList.remove('ua-glow');
    void card.offsetWidth;
    card.classList.add('ua-glow');
    window.setTimeout(() => card.classList.remove('ua-glow'), 1800);
    if (typeof haptic === 'function') haptic('success');
  }

  function fromHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content.firstElementChild;
  }

  function markupAll(message) {
    const steps = agentSteps(message);
    // A finished card drawn now (reload, redraw) must not celebrate later.
    steps.forEach((step) => {
      if (stepRunning(step)) { seenRunning.add(step.id); return; }
      if (seenRunning.has(step.id) && !celebrated.has(step.id)) {
        window.setTimeout(() => {
          const card = document.querySelector('.ua-card[data-step="' + cssEscape(String(step.id)) + '"]');
          if (card) celebrate(card, step.id);
        }, 60);
      } else {
        celebrated.add(step.id);
      }
    });
    return steps.map((step) => cardMarkup(message, step)).join('');
  }

  function patch(slotEl, message, options) {
    if (!slotEl || !message) return;
    const steps = agentSteps(message);
    const keep = new Set();
    steps.forEach((step, i) => {
      let card = Array.from(slotEl.children).find((el) => el.classList && el.classList.contains('ua-card') && el.dataset.step === String(step.id));
      if (card && card.dataset.shape !== shapeKey(step)) {
        // A new shape (agents added, waves or roles changed): drawn again.
        const fresh = fromHtml(cardMarkup(message, step));
        fresh.dataset.running = card.dataset.running;
        card.replaceWith(fresh);
        card = fresh;
      }
      if (!card) {
        card = fromHtml(cardMarkup(message, step));
        const after = slotEl.children[i] || null;
        slotEl.insertBefore(card, after);
        if (!stepRunning(step)) celebrated.add(step.id);
      }
      keep.add(card);
      if (patchCard(card, message, step)) celebrate(card, step.id, options);
    });
    Array.from(slotEl.children).forEach((el) => { if (el.classList && el.classList.contains('ua-card') && !keep.has(el)) el.remove(); });
  }

  /* ─── The lane's body, drawn when it is opened ─────────────────────── */

  function reportChips(report) {
    if (!report || typeof report !== 'object') return '';
    const list = (value) => (Array.isArray(value) ? value : []).map((item) => (typeof item === 'string' ? item : String((item && (item.path || item.title || item.text || item.name)) || ''))).filter(Boolean).slice(0, 20);
    const artifacts = list(report.artifacts || report.files);
    const issues = list(report.issues || report.open_issues || report.openIssues);
    let html = '';
    if (artifacts.length) html += '<div class="ua-sec"><b>Entregado</b><div class="ua-chips">' + artifacts.map((item) => '<code class="ua-chip">' + esc(item) + '</code>').join('') + '</div></div>';
    if (issues.length) html += '<div class="ua-sec"><b>Pendiente</b><div class="ua-chips">' + issues.map((item) => '<span class="ua-chip issue">' + esc(item) + '</span>').join('') + '</div></div>';
    return html;
  }

  function resultTextOf(agent) {
    if (agent.result) return String(agent.result);
    if (agent.report && typeof agent.report.summary === 'string') return agent.report.summary;
    return '';
  }

  function renderBody(body, step, entry, details) {
    const agent = entry.agent;
    const trail = Array.isArray(agent.trail) ? agent.trail : [];
    const result = resultTextOf(agent);
    const key = [agent.status, result.length, trail.length, agent.task ? agent.task.length : 0, JSON.stringify(agent.report || null).length, (agent.files || []).length].join('|');
    if (body.dataset.rendered === key) return;
    body.dataset.rendered = key;
    const files = Array.isArray(agent.files) ? agent.files.slice(0, 20) : [];
    let html = '';
    if (agent.task) html += '<div class="ua-sec"><b>Tarea</b><p class="ua-task">' + esc(agent.task) + '</p></div>';
    if (trail.length) {
      html += '<div class="ua-sec"><b>Pasos</b><ol class="ua-steps">' + trail.map((item) => '<li data-k="' + esc(item.k || 'read') + '" data-s="' + esc(item.s || 'd') + '"><i aria-hidden="true"></i><span>' + esc(item.t || '') + '</span>' +
        (item.ms >= 1000 ? '<small>' + esc(fmtDuration(item.ms)) + '</small>' : '') + '</li>').join('') + '</ol></div>';
    }
    if (files.length) html += '<div class="ua-sec"><b>Archivos</b><div class="ua-chips">' + files.map((path) => '<code class="ua-chip">' + esc(typeof path === 'string' ? path : (path && path.path) || '') + '</code>').join('') + '</div></div>';
    if (result) html += '<div class="ua-sec"><b>Resultado</b><div class="ua-result md"></div></div>';
    html += reportChips(agent.report);
    if (result) html += '<div class="ua-body-actions"><button type="button" class="ua-copy" data-ua-copy>Copiar</button></div>';
    if (!html) html = '<p class="ua-empty">' + esc(LIVE.test(agent.status) ? 'Todavía no hay nada que enseñar.' : 'Sin resultado.') + '</p>';
    body.innerHTML = html;
    const out = body.querySelector('.ua-result');
    if (out) {
      out.innerHTML = typeof renderMarkdown === 'function' ? renderMarkdown(result) : esc(result);
      if (typeof enhanceRichContent === 'function') {
        try { enhanceRichContent(out, { renderMath: true, latexPreview: false }); } catch (_) {}
      }
    }
  }

  // A card drawn from saved history (reload, redraw) was never patched: find
  // its message in the open chat so its lanes still open and copy.
  function dataOf(card) {
    if (!card) return null;
    let data = cardData.get(card);
    if (data) return data;
    const article = card.closest('[data-msg-id]');
    const chat = typeof getActiveChat === 'function' ? getActiveChat() : null;
    const message = article && chat && chat.messages.find((item) => item.id === article.getAttribute('data-msg-id'));
    const step = message && agentSteps(message).find((item) => String(item.id) === card.dataset.step);
    if (!step) return null;
    data = { message, step };
    cardData.set(card, data);
    return data;
  }

  function laneContext(lane) {
    const card = lane && lane.closest('.ua-card');
    const data = dataOf(card);
    if (!data) return null;
    const layout = layoutOf(data.step);
    const entry = layout.order.find((item) => agentKey(data.step, item) === lane.dataset.key);
    return entry ? { card, step: data.step, message: data.message, entry, details: detailsOf(data.step) } : null;
  }

  function onClick(event) {
    const head = event.target.closest('.ua-lane-head');
    if (head) {
      const lane = head.closest('.ua-lane');
      const body = lane && lane.querySelector('.ua-body');
      if (!body) return;
      const open = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      lane.classList.toggle('open', open);
      if (open) {
        const ctx = laneContext(lane);
        if (ctx) renderBody(body, ctx.step, ctx.entry, ctx.details);
      }
      body.hidden = !open;
      if (typeof haptic === 'function') haptic('select');
      return;
    }
    const stop = event.target.closest('[data-ua-stop]');
    if (stop) {
      const card = stop.closest('.ua-card');
      if (card && typeof window.ultraStopAgent === 'function') {
        const raw = stop.getAttribute('data-ua-stop');
        const data = dataOf(card);
        const agent = data && data.step.agents.find((item, index) => String(item.id != null ? item.id : index) === raw);
        window.ultraStopAgent(card.dataset.step, agent && agent.id != null ? agent.id : raw);
        stop.disabled = true;
        window.setTimeout(() => { stop.disabled = false; }, 1500);
      }
      return;
    }
    const copy = event.target.closest('[data-ua-copy]');
    if (copy) {
      const ctx = laneContext(copy.closest('.ua-lane'));
      const text = ctx ? resultTextOf(ctx.entry.agent) : '';
      if (!text || typeof copyTextToClipboard !== 'function') return;
      copyTextToClipboard(text).then(() => {
        copy.textContent = 'Copiado';
        window.setTimeout(() => { copy.textContent = 'Copiar'; }, 1200);
      }).catch(() => {});
    }
  }

  // Delegated listeners, once: on the given root, or on the document.
  function bind(rootEl) {
    if (bound) return;
    bound = rootEl || document;
    bound.addEventListener('click', onClick);
    // The error nudge and the return pulse play once, then are forgotten.
    bound.addEventListener('animationend', (event) => {
      const el = event.target;
      if (!el || !el.closest) return;
      if (event.animationName === 'ua-nudge') { const lane = el.closest('.ua-lane'); if (lane) lane.classList.remove('ua-just-failed'); }
      if (event.animationName === 'ua-return') { const node = el.closest('.ua-node'); if (node) node.classList.remove('ua-return'); }
    });
  }

  /* ─── Turning Ultra code on: a ring and a few sparks ───────────────── */

  function burst(anchorEl) {
    if (!anchorEl || reducedMotion()) return;
    const box = anchorEl.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const ring = document.createElement('span');
    ring.className = 'ua-burst-ring';
    ring.style.left = cx + 'px';
    ring.style.top = cy + 'px';
    ring.style.setProperty('--ua-burst-size', Math.max(44, Math.min(140, box.width * 1.1)) + 'px');
    document.body.appendChild(ring);
    window.setTimeout(() => ring.remove(), 900);
    for (let i = 0; i < 10; i++) {
      const spark = document.createElement('span');
      spark.className = 'ultra-spark ua-spark';
      const angle = (Math.PI * 2 * i) / 10 + (Math.random() - 0.5) * 0.35;
      const distance = 28 + Math.random() * 26;
      spark.style.left = cx + 'px';
      spark.style.top = cy + 'px';
      spark.style.setProperty('--dx', (Math.cos(angle) * distance).toFixed(1) + 'px');
      spark.style.setProperty('--dy', (Math.sin(angle) * distance).toFixed(1) + 'px');
      spark.style.background = SPARK_PALETTE[i % SPARK_PALETTE.length];
      document.body.appendChild(spark);
      window.setTimeout(() => spark.remove(), 900);
    }
  }

  window.UltraAgents = { markupAll, patch, bind, burst };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bind(null));
  else bind(null);
})();
