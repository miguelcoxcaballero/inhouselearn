/* ─── Ultra code: el tablero de los agentes ──────────────────────────
   Una tarjeta por cada paso spawn_agents de una respuesta, con el aire de
   Claude: arriba la chispa (un asterisco de rayos que late y gira mientras
   trabajan), el título con un brillo que lo recorre, el reloj y el coste;
   una línea fina de progreso; y debajo un árbol tranquilo con un carril por
   agente (agrupados por oleadas): su punto de estado, su nombre, su rol, y
   bajo él «⎿ lo que está haciendo · N pasos». El verificador va el último,
   con sus criterios. Al final, los archivos que han tocado (choques, marcados).

   The card is patched IN PLACE: every lane is keyed (data-key =
   stepId:agentId) and only its attributes and small texts change, so the
   DOM nodes survive updates and running CSS animations (the spark, the
   pulsing dots, the sheen) never restart. The whole card is drawn again only
   when its shape changes (agents, waves or roles). Bodies are rendered
   lazily, when a lane is opened.

   Data: step.agents (engine/src/agents.js) plus waves, budget, verify, files
   and shared (reads shared between agents), from the step or step.details.

   Loaded before the main script of index.html; uses its globals at call
   time (escapeHtml, costCounterMarkup, kickCostCounters, renderMarkdown,
   enhanceRichContent, copyTextToClipboard, haptic) and, when present,
   window.ultraCanStop / window.ultraStopAgent (per-lane stop buttons). */

(function () {
  const ROLE_LABEL = { explore: 'Explora', build: 'Construye', verify: 'Verifica', review: 'Verifica' };
  const EFFORT_LABEL = { low: 'rápido', medium: 'medio', high: 'a fondo', max: 'máximo' };
  const STATUS_LABEL = {
    queued: 'En cola', running: 'Trabajando', waiting: 'Esperando tu aprobación',
    done: 'Hecho', error: 'Con error', stopped: 'Detenido', skipped: 'Omitido'
  };
  const LIVE = /^(queued|running|waiting)$/;
  // Cards whose completion moment already played (once per step id).
  const celebrated = new Set();
  // Steps this page saw running: if a full redraw shows them finished before
  // the last patch did, the completion moment still plays once.
  const seenRunning = new Set();
  // Steps another device is answering: their end is not celebrated here.
  const remoteSteps = new Set();
  // The latest data each card was drawn with: the click handlers need it for
  // the lazy bodies and «Copiar» (never kept in the DOM, it can be large).
  const cardData = new WeakMap();
  let bound = null;

  const esc = (value) => (typeof escapeHtml === 'function' ? escapeHtml(value) : String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  function fmtDuration(ms) {
    if (typeof formatSeconds === 'function') return formatSeconds(ms);
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  }

  function costMarkup(id, value) {
    if (typeof costCounterMarkup === 'function') return costCounterMarkup(id, value);
    return '<span class="msg-cost" data-cost-for="' + esc(id) + '" data-cost="' + value + '">$' + value.toFixed(4) + '</span>';
  }

  function agentSteps(message) {
    const steps = message && Array.isArray(message.toolSteps) ? message.toolSteps : [];
    // Saved data can be old or damaged: only plain agent objects are drawn.
    return steps.filter((step) => step && step.name === 'spawn_agents' && Array.isArray(step.agents) && step.agents.some((agent) => agent && typeof agent === 'object'))
      .map((step) => (step.agents.every((agent) => agent && typeof agent === 'object') ? step : Object.assign({}, step, { agents: step.agents.filter((agent) => agent && typeof agent === 'object') })));
  }

  // waves, budget, verify, files and shared: on the step, or in its result details.
  function detailsOf(step) {
    const d = step.details && typeof step.details === 'object' ? step.details : {};
    const pick = (key) => (step[key] !== undefined ? step[key] : d[key]);
    const verify = pick('verify');
    const files = pick('files');
    return {
      waves: num(pick('waves')),
      budget: num(pick('budget')),
      shared: num(pick('shared')),
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

  function progressOf(step) {
    const total = step.agents.length || 1;
    const finished = step.agents.filter((agent) => !LIVE.test(agent.status)).length;
    return Math.max(0, Math.min(1, finished / total));
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
    if ((!summary || (agent.report && agent.report.synthesized)) && section && section[1].trim()) raw = section[1];
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

  function countText(agent) {
    const steps = num(agent.steps);
    return steps ? steps + (steps === 1 ? ' paso' : ' pasos') : '';
  }

  function roleText(agent) {
    const role = ROLE_LABEL[agent.role] || ROLE_LABEL.build;
    const effort = EFFORT_LABEL[agent.effort];
    return effort ? role + ' · ' + effort : role;
  }

  function canStop(step, agent) {
    return LIVE.test(agent.status) && typeof window.ultraCanStop === 'function' && typeof window.ultraStopAgent === 'function' && !!window.ultraCanStop(step.id);
  }

  /* ─── Markup ───────────────────────────────────────────────────────── */

  // The spark: three strokes crossing (six rays) and a core, like Claude's
  // thinking asterisk. CSS makes it breathe and turn while the card runs.
  const SPARK = '<svg class="ua-glyph" viewBox="0 0 24 24" aria-hidden="true">' +
    '<g class="ua-glyph-rays"><path d="M12 3.2v17.6M4.4 7.6l15.2 8.8M4.4 16.4l15.2-8.8"/></g>' +
    '<g class="ua-glyph-rays ua-glyph-rays2"><path d="M12 6.5v11M7.2 9.25l9.6 5.5M7.2 14.75l9.6-5.5"/></g>' +
    '<circle class="ua-glyph-core" cx="12" cy="12" r="2.1"/></svg>';
  // The lane's state: a hollow ring (queued), a breathing dot with a ripple
  // (running), an amber dot (waiting), a drawn check, a cross, a bar.
  const ORB = '<svg class="ua-orb" viewBox="0 0 20 20" aria-hidden="true">' +
    '<circle class="ua-orb-track" cx="10" cy="10" r="7"/>' +
    '<circle class="ua-orb-ring" cx="10" cy="10" r="4"/>' +
    '<circle class="ua-orb-dot" cx="10" cy="10" r="3.4"/>' +
    '<path class="ua-orb-check" d="M6.6 10.3 8.9 12.6 13.5 7.6" pathLength="1"/>' +
    '<path class="ua-orb-x" d="M7.6 7.6l4.8 4.8M12.4 7.6l-4.8 4.8" pathLength="1"/>' +
    '<path class="ua-orb-bar" d="M7.2 10h5.6"/>' +
    '</svg>';
  const CHEVRON = '<svg class="ua-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>';

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
    const time = laneTime(agent);
    const isVerify = agent.role === 'verify' || agent.role === 'review';
    const checks = isVerify ? checksMarkup(details.verify) : '';
    const body = domId(message.id + '-' + key);
    return '<li class="ua-lane" data-key="' + esc(key) + '" data-status="' + esc(agent.status || 'queued') + '" data-role="' + esc(agent.role || 'build') + '"' +
      (agent.kind ? ' data-kind="' + esc(agent.kind) + '"' : '') + ' style="--i:' + position + '">' +
      '<div class="ua-lane-row">' +
      '<button type="button" class="ua-lane-head" aria-expanded="false" aria-controls="' + body + '">' +
      ORB +
      '<span class="ua-name" title="' + esc(agent.name || 'Agente') + '">' + esc(agent.name || 'Agente') + '</span>' +
      '<span class="ua-role">' + esc(roleText(agent)) + '</span>' +
      '<span class="ua-status-text ua-sr">' + esc(STATUS_LABEL[agent.status] || '') + '</span>' +
      '<span class="ua-time"' + (time.since ? ' data-live-since="' + time.since + '"' : '') + '>' + esc(time.text) + '</span>' +
      '<span class="ua-cost">' + costMarkup(message.id + ':agent:' + step.id + ':' + entry.index, num(agent.cost)) + '</span>' +
      CHEVRON +
      '</button>' +
      '<button type="button" class="ua-stop" data-ua-stop="' + esc(agent.id != null ? agent.id : entry.index) + '" aria-label="Detener ' + esc(agent.name || 'agente') + '" title="Detener este agente"' + (canStop(step, agent) ? '' : ' hidden') + '>' + STOP + '</button>' +
      '</div>' +
      '<div class="ua-doing"><span class="ua-elbow" aria-hidden="true">⎿</span><span class="ua-doing-box"><span class="ua-doing-text">' + esc(doingText(agent)) + '</span></span>' +
      '<span class="ua-count">' + esc(countText(agent)) + '</span></div>' +
      (isVerify ? '<ul class="ua-checks"' + (checks ? '' : ' hidden') + '>' + checks + '</ul>' : '') +
      '<div class="ua-body" id="' + body + '" hidden></div>' +
      '</li>';
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

  function sharedText(details) {
    return details.shared > 0 ? details.shared + (details.shared === 1 ? ' lectura compartida' : ' lecturas compartidas') : '';
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
    const shared = sharedText(details);
    return '<section class="ua-card" data-step="' + esc(step.id) + '" data-msg="' + esc(message.id) + '" data-shape="' + esc(shapeKey(step)) + '" data-running="' + (running ? '1' : '0') + '" style="--n:' + step.agents.length + '" aria-label="Agentes de Ultra code">' +
      '<header class="ua-head">' + SPARK +
      '<span class="ua-title" aria-live="polite">' + esc(titleText(step, details, layout)) + '</span>' +
      '<span class="ua-meta"><span class="ua-clock"' + (running && start ? ' data-live-since="' + start + '"' : '') + '>' + (running && start ? esc(fmtDuration(Date.now() - start)) : '') + '</span>' +
      '<span class="ua-total">' + costMarkup(message.id + ':agents:' + step.id, total) + '</span></span>' +
      '</header>' +
      '<div class="ua-progress" aria-hidden="true"><i style="width:' + (progressOf(step) * 100).toFixed(1) + '%"></i></div>' +
      '<div class="ua-budget"' + (details.budget > 0 ? '' : ' hidden') + (ratio > 0.8 ? ' data-warn="1"' : '') + (details.budget > 0 && ratio < 0.25 ? ' data-low="1"' : '') + '>' + (details.budget > 0 ? budgetMarkup(total, details.budget) : '') + '</div>' +
      '<div class="ua-board">' + body + '</div>' +
      '<div class="ua-foot"' + (details.files.length || shared ? '' : ' hidden') + '>' +
      '<div class="ua-files"' + (details.files.length ? '' : ' hidden') + '>' + filesMarkup(details) + '</div>' +
      '<div class="ua-shared"' + (shared ? '' : ' hidden') + '>' + esc(shared) + '</div>' +
      '</div>' +
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

  // The doing line crossfades: the new text rises in over the old one.
  function setDoing(lane, text) {
    const holder = lane.querySelector('.ua-doing-box');
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

  function patchLane(lane, message, step, entry, details) {
    const agent = entry.agent;
    const previous = lane.dataset.status;
    const status = agent.status || 'queued';
    setAttr(lane, 'data-status', status);
    setAttr(lane, 'data-kind', agent.kind || null);
    // The error nudge plays once, when the lane turns red in front of you.
    if (previous && previous !== status && status === 'error') lane.classList.add('ua-just-failed');
    setText(lane.querySelector('.ua-status-text'), STATUS_LABEL[status] || '');
    setText(lane.querySelector('.ua-role'), roleText(agent));
    const time = laneTime(agent);
    const timeEl = lane.querySelector('.ua-time');
    setAttr(timeEl, 'data-live-since', time.since || null);
    if (!time.since) setText(timeEl, time.text);
    else if (!timeEl.textContent) setText(timeEl, time.text);
    setCost(lane.querySelector('.ua-cost'), num(agent.cost));
    setAttr(lane.querySelector('.ua-stop'), 'hidden', canStop(step, agent) ? null : '');
    setDoing(lane, doingText(agent));
    setText(lane.querySelector('.ua-count'), countText(agent));
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
    const bar = card.querySelector('.ua-progress > i');
    if (bar) {
      const width = (progressOf(step) * 100).toFixed(1) + '%';
      if (bar.style.width !== width) bar.style.width = width;
    }
    const budget = card.querySelector('.ua-budget');
    if (budget) {
      setAttr(budget, 'hidden', details.budget > 0 ? null : '');
      setAttr(budget, 'data-warn', details.budget > 0 && total / details.budget > 0.8 ? '1' : null);
      // The budget only shows once it matters (a quarter of it spent).
      setAttr(budget, 'data-low', details.budget > 0 && total / details.budget < 0.25 ? '1' : null);
      if (details.budget > 0) {
        if (!budget.querySelector('.ua-budget-bar')) budget.innerHTML = budgetMarkup(total, details.budget);
        const ratio = Math.min(1, total / details.budget);
        const fill = budget.querySelector('.ua-budget-bar i');
        if (fill) fill.style.width = (ratio * 100).toFixed(1) + '%';
        setText(budget.querySelector('.ua-budget-text'), Math.round(ratio * 100) + '% de $' + details.budget.toFixed(2));
      }
    }
    layout.order.forEach((entry) => {
      const lane = card.querySelector('.ua-lane[data-key="' + cssEscape(agentKey(step, entry)) + '"]');
      if (lane) patchLane(lane, message, step, entry, details);
    });
    const files = card.querySelector('.ua-files');
    if (files) {
      setHtml(files, filesMarkup(details));
      setAttr(files, 'hidden', details.files.length ? null : '');
    }
    const shared = sharedText(details);
    const sharedEl = card.querySelector('.ua-shared');
    if (sharedEl) {
      setText(sharedEl, shared);
      setAttr(sharedEl, 'hidden', shared ? null : '');
    }
    setAttr(card.querySelector('.ua-foot'), 'hidden', details.files.length || shared ? null : '');
    card.dataset.running = running ? '1' : '0';
    return wasRunning && !running;
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
  }

  // Once per step id, only when it finishes in front of the reader (not on a
  // reload, which never saw it running, and not for another device's turn):
  // the spark blooms once and the card breathes a soft ring.
  function celebrate(card, stepId, options) {
    if (celebrated.has(stepId) || (options && options.remote) || document.hidden) return;
    const box = card.getBoundingClientRect();
    if (!(box.bottom > 0 && box.top < (window.innerHeight || 0))) return;
    celebrated.add(stepId);
    card.classList.remove('ua-glow');
    void card.offsetWidth;
    card.classList.add('ua-glow');
    window.setTimeout(() => card.classList.remove('ua-glow'), 1600);
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
      if (seenRunning.has(step.id) && !celebrated.has(step.id) && !remoteSteps.has(step.id)) {
        window.setTimeout(() => {
          const card = document.querySelector('.ua-card[data-step="' + cssEscape(String(step.id)) + '"]');
          if (card) celebrate(card, step.id);
        }, 60);
      } else {
        celebrated.add(step.id);
      }
    });
    // One bad step never breaks the drawing of the whole thread.
    return steps.map((step) => { try { return cardMarkup(message, step); } catch (error) { console.warn('Ultra: no se pudo dibujar un paso de agentes.', error); return ''; } }).join('');
  }

  function patch(slotEl, message, options) {
    if (!slotEl || !message) return;
    const steps = agentSteps(message);
    if (options && options.remote) steps.forEach((step) => remoteSteps.add(step.id));
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
    const list = (value) => (Array.isArray(value) ? value : []).map((item) => (typeof item === 'string' ? item : String((item && (item.path || item.ref || item.title || item.text || item.name)) || ''))).filter(Boolean).slice(0, 20);
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
    // The error nudge plays once, then is forgotten.
    bound.addEventListener('animationend', (event) => {
      const el = event.target;
      if (!el || !el.closest) return;
      if (event.animationName === 'ua-nudge') { const lane = el.closest('.ua-lane'); if (lane) lane.classList.remove('ua-just-failed'); }
    });
  }

  /* ─── Turning Ultra code on: a glint runs once around the pill ─────── */
  // No confetti: a thin rainbow light travels once around the pill's edge
  // while a soft halo blooms and fades behind it (the word itself shimmers
  // through .ultra-burst in index.html), like Claude's ultrathink.
  function burst(anchorEl) {
    if (!anchorEl || reducedMotion()) return;
    const box = anchorEl.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const radius = getComputedStyle(anchorEl).borderRadius || '999px';
    document.querySelectorAll('.ua-glint').forEach((el) => el.remove());
    const glint = document.createElement('span');
    glint.className = 'ua-glint';
    glint.setAttribute('aria-hidden', 'true');
    glint.style.left = (box.left - 3) + 'px';
    glint.style.top = (box.top - 3) + 'px';
    glint.style.width = (box.width + 6) + 'px';
    glint.style.height = (box.height + 6) + 'px';
    glint.style.borderRadius = radius === '0px' ? '12px' : 'calc(' + radius + ' + 3px)';
    glint.innerHTML = '<span class="ua-glint-halo"></span><span class="ua-glint-edge"></span>';
    document.body.appendChild(glint);
    window.setTimeout(() => glint.remove(), 1300);
  }

  window.UltraAgents = { markupAll, patch, bind, burst };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bind(null));
  else bind(null);
})();
