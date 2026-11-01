// La ejecución de un spawn_agents: el planificador por oleadas, el presupuesto,
// los reintentos, el verificador con sus rondas de arreglos y el resultado que
// vuelve al modelo principal. Es lo único con estado; las reglas de decisión
// viven en policy.js, el plan en plan.js y los informes en report.js.
//
// env: { ctx, timing, turn: { spent, cap }, store: Map, gate: { refused } }
//   ctx.runSubAgent(job) → Promise<{ text, cost, report? }>
//   store: lo que agent_report puede leer (id → { name, role, status, task, text, report })
//   turn: lo gastado en esta respuesta por todos los spawn_agents, y su tope
import { MAX_PARALLEL, DEFAULT_MINUTES, DEFAULT_BUDGET, MIN_BUDGET, textResult, clip, money, quoteList, abortError, ownsPath } from './common.js';
import { planAgents } from './plan.js';
import { normalizeReport, synthesizeReport, reportBody, confidenceLabel, compactReport, sectionLimit, trimSection } from './report.js';
import { effortFor, STEP_CAPS } from './effort.js';
import { shouldVerify, fixRoundsFrom, startVerdict, nextParallel, failingKey } from './policy.js';

// The first agent goes alone for a moment so the provider's prompt cache (same
// system prompt and tools for everyone) is written once and read by the rest.
export const STAGGER_MS = 300;
const MAX_TRIES = 3;
const TRANSIENT = /429|rate.?limit|overloaded|\b5\d\d\b|network|failed to fetch|timeout|ECONNRESET/i;
const LIMITED = /429|rate.?limit|overloaded/i;
const FAILED = new Set(['error', 'stopped', 'skipped']);
const ACTIVE = new Set(['running', 'waiting']);

export async function runSpawn(env, stepId, params, signal, onUpdate) {
  const { ctx, timing, turn, store, gate } = env;
  const goal = String(params.goal || '').trim();
  const context = String(params.context || '').trim();
  const plan = planAgents(params.agents, { context });
  const { nodes, waves, warnings, blockers } = plan;

  // A plan that cannot work as written (a task of a few words with no context, or
  // one that points at «lo de arriba») is refused once, before anyone starts and
  // before anything is spent: the model rewrites it. The second call goes through.
  if (blockers.length && !gate.refused) {
    gate.refused = true;
    return textResult('Plan NO ejecutado: no ha empezado ningún agente y no se ha gastado nada. Corrige esto y vuelve a llamar a spawn_agents:\n' +
      blockers.map((item) => '- ' + item).join('\n') + '\n(Si lo mantienes tal cual, la próxima llamada sí se ejecuta.)', { refused: true });
  }
  // One answer can launch several rounds; the cap is for all of them together.
  const turnLeft = turn.cap - turn.spent;
  if (turnLeft < MIN_BUDGET) {
    return textResult('Tope de gasto de Ultra code en esta respuesta alcanzado (' + money(turn.spent) + ' de $' + turn.cap.toFixed(2) + '): no lances más agentes. Integra lo que ya tienes y responde, diciendo qué ha quedado sin hacer.', { refused: true });
  }

  const acceptance = (Array.isArray(params.acceptance) ? params.acceptance : []).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 10);
  const asked = Math.max(MIN_BUDGET, Math.min(20, Number(params.budget_usd) || DEFAULT_BUDGET));
  const budget = Math.min(asked, turnLeft);
  const stopOnFailure = params.on_failure === 'stop';
  const doVerify = params.verify === false ? false : (params.verify === true || shouldVerify(nodes, acceptance));
  const fixRounds = fixRoundsFrom(params.fix_rounds);
  const startAll = Date.now();

  const rows = nodes.map((node) => ({
    id: node.id, name: node.name, role: node.role, task: clip(node.task, 400),
    status: 'queued', doing: 'En cola', kind: '', cost: 0, steps: 0, maxSteps: node.maxSteps, effort: node.effort,
    startedAt: 0, endedAt: 0, trail: [], result: '', files: [], wave: node.wave, deps: node.deps.slice(),
    hue: Math.round((node.index * 137.508 + 210) % 360)
  }));
  const verifyRow = doVerify ? {
    id: 'verify', name: 'Verificación', role: 'verify', task: acceptance.length ? clip(acceptance.map((item, i) => (i + 1) + '. ' + item).join(' '), 400) : 'Comprueba que cada informe cumple su tarea.',
    status: 'queued', doing: 'Después de los agentes', kind: '', cost: 0, steps: 0, maxSteps: STEP_CAPS.verify, effort: effortFor('verify'),
    startedAt: 0, endedAt: 0, trail: [], result: '', files: [], wave: waves + 1, deps: nodes.map((node) => node.id), hue: 145
  } : null;
  const allRows = verifyRow ? rows.concat(verifyRow) : rows.slice();
  const rowById = new Map(allRows.map((row) => [row.id, row]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  // Per agent, what is not in the compact row: full text, report, controller.
  const inner = new Map(allRows.map((row) => [row.id, { text: '', report: null, controller: null, stopReason: '', wrote: false, fullTask: '' }]));
  const touched = new Map(); // path → [agent names], fed by job.onWrite
  const touchedIds = new Map(); // path → [agent ids]
  let verify = null;
  let budgetOut = false;
  let budgetNear = false;
  let finished = false;
  let failedName = '';
  let rounds = 0;
  let notice = '';
  // How many agents run at once: a provider that limits requests slows it down.
  let pool = { limit: MAX_PARALLEL, calm: 0, max: MAX_PARALLEL, slowed: false };

  const totalCost = () => allRows.reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
  const details = () => {
    const out = { agents: allRows.map((row) => Object.assign({}, row, { trail: row.trail.slice(-24), files: row.files.slice(0, 20) })), waves, budget };
    if (verify) out.verify = verify;
    const files = touchedList();
    if (files.length) out.files = files;
    if (warnings.length) out.warnings = warnings.slice();
    if (rounds) out.rounds = rounds;
    if (notice) out.notice = notice;
    return out;
  };
  const touchedList = () => Array.from(touched.entries()).slice(0, 60).map(([path, agents]) => ({ path, agents: agents.slice(), conflict: agents.length > 1 }));
  const mark = (row) => (row.status === 'done' ? '✓ ' : row.status === 'error' ? '✕ ' : row.status === 'stopped' ? '■ ' : row.status === 'skipped' ? '– ' : row.status === 'queued' ? '· ' : '… ');
  let last = 0;
  const push = (force) => {
    if (typeof onUpdate !== 'function') return;
    const now = Date.now();
    if (!force && now - last < 250) return;
    last = now;
    onUpdate(textResult(allRows.map((row) => mark(row) + row.name + ': ' + row.doing + ' · ' + money(row.cost)).join('\n') + '\nTotal ' + money(totalCost()) + ' de $' + budget.toFixed(2), details()));
  };
  // The card says it while the pool is below its maximum (and how many run now).
  const poolNotice = () => (pool.limit < pool.max ? 'El proveedor limita las peticiones: ahora van ' + pool.limit + ' agentes a la vez.' : '');
  const slowDown = () => {
    pool = nextParallel(pool, 'limit');
    notice = poolNotice();
  };
  const speedUp = () => {
    pool = nextParallel(pool, 'ok');
    if (notice) notice = poolNotice();
  };

  // Wakes the scheduler when an agent ends, is stopped, or the parent aborts.
  let wakeResolve = null;
  const wake = () => { if (wakeResolve) { const resolve = wakeResolve; wakeResolve = null; resolve(); } };
  const nextWake = () => new Promise((resolve) => { wakeResolve = resolve; });
  const onParentAbort = () => {
    inner.forEach((own) => { if (own.controller) own.controller.abort(); });
    wake();
  };
  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const sleep = (ms) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    if (signal) signal.addEventListener('abort', stop, { once: true });
  });

  const stopRow = (row, reason) => {
    const own = inner.get(row.id);
    if (row.status === 'queued') {
      row.status = 'stopped';
      row.doing = reason;
      row.endedAt = Date.now();
      push(true);
      wake();
      return true;
    }
    if (!ACTIVE.has(row.status) || !own.controller) return false;
    own.stopReason = reason;
    own.controller.abort();
    return true;
  };

  // Spending cap across every agent: the most expensive one still working is stopped.
  const checkBudget = () => {
    if (totalCost() <= budget) return;
    budgetOut = true;
    budgetNear = false;
    const active = allRows.filter((row) => ACTIVE.has(row.status) && !inner.get(row.id).stopReason).sort((a, b) => b.cost - a.cost);
    if (active.length) stopRow(active[0], 'Parado: presupuesto agotado ($' + budget.toFixed(2) + ')');
  };
  const budgetWord = () => 'presupuesto ' + (budgetNear ? 'casi agotado' : 'agotado');

  if (ctx && typeof ctx.registerControls === 'function') {
    ctx.registerControls(stepId, {
      stop: (agentId) => {
        const row = rowById.get(String(agentId));
        return row ? stopRow(row, 'Parado por ti') : false;
      }
    });
  }

  // Runs one agent (or a fix round, or the verifier) with its own controller,
  // its caps, and whole-agent retries for transient failures before it wrote anything.
  async function runRow(row, job, label) {
    const own = inner.get(row.id);
    own.stopReason = '';
    row.status = 'running';
    row.doing = label;
    if (!row.startedAt) row.startedAt = Date.now();
    row.endedAt = 0;
    const costBase = row.cost;
    let spentBefore = 0; // previous tries of this run
    push(true);
    // One time allowance for all the tries of this agent.
    let remaining = job.maxMinutes * 60000;
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      own.controller = controller;
      if (signal && signal.aborted) controller.abort();
      let attemptCost = 0;
      let timerStart = Date.now();
      let timer = null;
      const arm = () => { timerStart = Date.now(); timer = setTimeout(() => { own.stopReason = own.stopReason || 'Parado: ' + job.maxMinutes + ' min'; controller.abort(); }, Math.max(0, remaining)); };
      const disarm = () => { if (timer) { clearTimeout(timer); timer = null; remaining -= Date.now() - timerStart; } };
      arm();
      const setCost = (value) => {
        if (!Number.isFinite(value)) return;
        attemptCost = Math.max(attemptCost, value);
        row.cost = costBase + spentBefore + attemptCost;
      };
      const onAgentUpdate = (update) => {
        if (finished || !update || own.controller !== controller) return;
        if (update.doing) row.doing = clip(String(update.doing), 120);
        if (update.kind) row.kind = String(update.kind).slice(0, 20);
        if (Number.isFinite(update.steps)) {
          row.steps = update.steps;
          // The app warns from maxSteps−5 and refuses past maxSteps (the agent can still
          // report); the scheduler only cuts an agent that keeps going anyway.
          if (update.steps >= job.maxSteps + 5 && !own.stopReason) { own.stopReason = 'Parado: límite de ' + job.maxSteps + ' pasos'; controller.abort(); }
        }
        if (Array.isArray(update.trail)) row.trail = update.trail.slice(-24);
        if (update.wrote) own.wrote = true;
        if (typeof update.waiting === 'boolean' && ACTIVE.has(row.status)) {
          // Waiting for the user's approval does not count against its minutes.
          if (update.waiting && row.status !== 'waiting') { row.status = 'waiting'; disarm(); }
          else if (!update.waiting && row.status === 'waiting') { row.status = 'running'; arm(); }
        }
        setCost(Number(update.cost));
        checkBudget();
        push(false);
      };
      const subJob = {
        id: row.id, name: row.name, role: job.role, task: job.task, readOnly: job.readOnly,
        ownedFiles: job.ownedFiles, maxSteps: job.maxSteps, effort: job.effort, hue: row.hue,
        signal: controller.signal,
        onUpdate: onAgentUpdate,
        onWrite: (path, kind) => {
          own.wrote = true;
          const key = String(path || '').replace(/^\/+/, '');
          if (!key) return undefined;
          if (!row.files.includes(key) && row.files.length < 20) row.files.push(key);
          // Keyed by agent id (two agents may share a name); names are for reading.
          const ids = touchedIds.get(key) || [];
          const others = ids.filter((other) => other !== row.id).map((other) => (rowById.get(other) || {}).name || other);
          if (!ids.includes(row.id)) ids.push(row.id);
          touchedIds.set(key, ids);
          touched.set(key, ids.map((other) => (rowById.get(other) || {}).name || other));
          push(false);
          if (others.length) return 'Aviso: «' + others.join('», «') + '» ya cambió ' + key + ' en esta ejecución; vuelve a leerlo con read_file e integra sus cambios en vez de sustituirlos.';
          const owner = nodes.find((node) => node.id !== row.id && ownsPath(node.files, key));
          if (owner && !ownsPath(job.ownedFiles, key)) return 'Aviso: ' + key + ' es de «' + owner.name + '» (files); cámbialo solo si tu tarea lo pide y sin pisar lo suyo.';
          return undefined;
        },
        onReport: (report) => {
          if (finished || own.controller !== controller) return;
          own.report = normalizeReport(report, row.id === 'verify');
        }
      };
      // The stop must win even when runSubAgent ignores its signal: after a
      // short grace for its partial text, the agent is given up.
      let graceTimer = null;
      const stopped = new Promise((resolve) => {
        controller.signal.addEventListener('abort', () => { graceTimer = setTimeout(() => resolve({ given: true }), timing.grace); }, { once: true });
      });
      let outcome;
      try {
        outcome = await Promise.race([
          Promise.resolve().then(() => ctx.runSubAgent(subJob)).then((value) => ({ value }), (error) => ({ error })),
          stopped
        ]);
      } finally {
        disarm();
        clearTimeout(graceTimer);
      }
      if (finished) return;
      if (outcome.value && !controller.signal.aborted) {
        const result = outcome.value || {};
        setCost(Number(result.cost));
        checkBudget();
        own.text = String(result.text || '').trim();
        if (result.report && !own.report) own.report = normalizeReport(result.report, row.id === 'verify');
        if (!own.report) own.report = synthesizeReport(own.text, 'done');
        row.report = compactReport(own.report);
        row.result = clip(own.text || own.report.summary, 4000);
        row.status = 'done';
        row.doing = 'Terminado';
        row.endedAt = Date.now();
        speedUp();
        push(true);
        return;
      }
      const error = outcome.error || abortError();
      if (error && error.usage && Number.isFinite(error.usage.cost)) setCost(error.usage.cost);
      const partial = String((error && error.partialText) || (outcome.value && outcome.value.text) || '').trim();
      if (signal && signal.aborted) return; // the scheduler settles every row
      if (own.stopReason || controller.signal.aborted) {
        row.status = 'stopped';
        row.doing = own.stopReason || 'Parado';
        row.endedAt = Date.now();
        own.text = partial;
        if (!own.report) own.report = synthesizeReport(partial || '(sin texto: se paró antes de escribir)', 'partial');
        row.report = compactReport(own.report);
        row.result = clip(partial, 4000);
        push(true);
        return;
      }
      const message = String((error && error.message) || error);
      if (attempt < MAX_TRIES && !own.wrote && TRANSIENT.test(message)) {
        if (LIMITED.test(message)) slowDown();
        spentBefore += attemptCost;
        row.doing = 'Reintentando (' + (attempt + 1) + '/' + MAX_TRIES + ')';
        push(true);
        try { await sleep(timing.backoff * attempt); } catch (_) { return; }
        if (finished) return;
        continue;
      }
      row.status = 'error';
      row.doing = clip(message, 160);
      row.endedAt = Date.now();
      own.text = partial;
      own.report = partial ? synthesizeReport(partial, 'blocked') : null;
      if (own.report) row.report = compactReport(own.report);
      row.result = clip(partial || 'Ha fallado: ' + message, 4000);
      push(true);
      return;
    }
  }

  const sharedPrefix = (goal ? 'Objetivo general: ' + goal + '\n\n' : '') + (context ? 'Contexto común (lo mismo para todos los agentes):\n' + context + '\n\n' : '');
  // limit: how much of the body goes in (the digest for the main model); none = all of it.
  let anyCut = false;
  const sectionOf = (row, limit) => {
    const own = inner.get(row.id);
    const report = own.report;
    const status = report && row.status === 'done' ? report.status : row.status;
    const head = '## ' + row.name + ' [' + status + confidenceLabel(report) + ']';
    if (row.status === 'skipped') return head + '\n' + row.doing;
    if (row.status === 'error' && !report) return head + '\nHa fallado: ' + row.doing;
    const trimmed = trimSection(report ? reportBody(report, own.text) : (own.text || '(sin respuesta)'), limit, row.id);
    if (trimmed.cut) anyCut = true;
    return head + (row.status === 'stopped' ? '\n' + row.doing + '.' : '') + '\n' + trimmed.text;
  };
  const taskFor = (node) => {
    const deps = node.deps.map((id) => {
      const row = rowById.get(id);
      const own = inner.get(id);
      const body = (own.report && !own.report.synthesized ? reportBody(own.report, '') + '\n\n' : '') + (own.text || (own.report && own.report.summary) || '');
      return '### ' + row.name + ' (' + id + ')\n' + clip(body.trim() || '(sin respuesta)', 6000, '… (recortado)');
    });
    return sharedPrefix + (deps.length ? 'Resultados de los agentes de los que dependes:\n' + deps.join('\n\n') + '\n\n' : '') +
      'Tu tarea:\n' + node.task + (node.returns ? '\n\nDevuelve: ' + node.returns : '') +
      (node.files.length ? '\n\nArchivos que te tocan a ti (solo tú los cambias): ' + node.files.join(', ') : '') +
      (node.role === 'explore' ? '\n\nSolo investiga y lee: no cambies nada.' : '') +
      '\n\nAl terminar, llama a submit_result con tu informe (resumen, estado, artefactos, lo pendiente).';
  };
  const jobFor = (node, task) => ({ role: node.role, task, readOnly: node.role === 'explore', ownedFiles: node.files.length ? node.files.slice() : null, maxSteps: node.maxSteps, effort: node.effort, maxMinutes: node.maxMinutes });

  // Starts every node whose dependencies are done, as many at a time as the pool
  // allows, staggered; failures skip their dependants (or everything, on_failure
  // stop); an agent that cannot finish inside what is left of the budget is not started.
  async function schedule(list) {
    const running = new Map();
    let lastStart = 0;
    for (;;) {
      if (signal && signal.aborted) break;
      let changed = false;
      list.forEach((node) => {
        const row = rowById.get(node.id);
        if (row.status !== 'queued') return;
        const failed = node.deps.map((id) => rowById.get(id)).find((dep) => FAILED.has(dep.status));
        const reason = failed ? 'No empieza: falló «' + failed.name + '»'
          : budgetOut ? 'No empieza: ' + budgetWord()
            : stopOnFailure && failedName ? 'No empieza: falló «' + failedName + '»' : '';
        if (reason) {
          row.status = 'skipped';
          row.doing = reason;
          row.endedAt = Date.now();
          changed = true;
          return;
        }
        const waitingFor = node.deps.map((id) => rowById.get(id)).filter((dep) => dep.status !== 'done').map((dep) => dep.name);
        const doing = waitingFor.length ? 'En espera de ' + quoteList(waitingFor) : 'En cola';
        if (row.doing !== doing) { row.doing = doing; changed = true; }
      });
      if (changed) push(true);
      const ready = list.filter((node) => rowById.get(node.id).status === 'queued' && node.deps.every((id) => rowById.get(id).status === 'done'));
      if (ready.length && running.size < pool.limit) {
        const gap = lastStart ? timing.stagger - (Date.now() - lastStart) : 0;
        if (gap > 0) {
          try { await sleep(gap); } catch (_) { break; }
          continue;
        }
        const verdict = startVerdict({ spent: totalCost(), budget, finishedCosts: rows.filter((row) => row.status === 'done').map((row) => row.cost) });
        if (!verdict.ok) {
          // What is left would not finish another agent: the queue is skipped, the
          // ones already working go on.
          budgetOut = true;
          budgetNear = !!verdict.near;
          continue;
        }
        const node = ready[0];
        const row = rowById.get(node.id);
        lastStart = Date.now();
        const task = taskFor(node);
        inner.get(node.id).fullTask = task;
        const promise = runRow(row, jobFor(node, task), 'Empezando').catch((error) => {
          row.status = 'error';
          row.doing = clip(String((error && error.message) || error), 160);
          row.endedAt = Date.now();
        }).then(() => {
          running.delete(node.id);
          if (FAILED.has(row.status) && row.status !== 'skipped' && !failedName) failedName = row.name;
          wake();
        });
        running.set(node.id, promise);
        continue;
      }
      if (!running.size) break;
      await nextWake();
    }
  }

  // The verifier: read-only, checks the reports against what really exists. Its job
  // is to try to refute the work, not to confirm it.
  const verifierTask = () => {
    const workers = rows.filter((row) => row.status !== 'skipped');
    return 'Eres el verificador de un trabajo que han hecho varios agentes. No cambies nada: solo comprueba.\n\n' +
      (goal ? 'Objetivo: ' + goal + '\n\n' : '') + (context ? 'Contexto:\n' + clip(context, 4000) + '\n\n' : '') +
      (acceptance.length ? 'Criterios de aceptación:\n' + acceptance.map((item, i) => (i + 1) + '. ' + item).join('\n') : 'No hay criterios explícitos: comprueba que cada informe cumple su tarea (un criterio por agente).') +
      '\n\nTareas e informes de los agentes:\n' + workers.map((row) => '### ' + row.name + ' (id ' + row.id + ', ' + row.status + ')\nTarea: ' + clip(nodeById.get(row.id).task, 1500) + '\nInforme:\n' + clip(sectionOf(row), 3000)).join('\n\n') +
      '\n\nTu trabajo es intentar refutar lo hecho, no confirmarlo: busca el caso que falla. Comprueba cada criterio contra lo real: lee los archivos, commits, PRs, documentos o fuentes que citan (no te fíes solo de los informes), sin cambiar nada. ' +
      'Después llama a submit_result con data = { "passed": true|false, "checks": [{ "criterion": "…", "ok": true|false, "evidence": "qué viste y dónde", "owner_id": "id del agente responsable" }], "fixes": [{ "owner_id": "…", "instruction": "qué tiene que corregir, concreto" }] }. ' +
      'fixes solo para lo que falla; passed es true si todo se cumple.';
  };
  const verifyJob = () => ({ role: 'verify', task: verifierTask(), readOnly: true, ownedFiles: null, maxSteps: STEP_CAPS.verify, effort: effortFor('verify'), maxMinutes: DEFAULT_MINUTES });
  const readVerdict = () => {
    const report = inner.get('verify').report;
    const data = report && report.data && typeof report.data === 'object' ? report.data : null;
    if (!data) return null;
    const checks = (Array.isArray(data.checks) ? data.checks : []).slice(0, 20).map((check) => ({
      criterion: clip(String((check && check.criterion) || ''), 200),
      ok: !!(check && check.ok),
      evidence: clip(String((check && check.evidence) || ''), 300),
      owner_id: String((check && check.owner_id) || '')
    }));
    const fixes = (Array.isArray(data.fixes) ? data.fixes : []).filter((fix) => fix && rowById.has(String(fix.owner_id)) && fix.owner_id !== 'verify' && String(fix.instruction || '').trim())
      .map((fix) => ({ owner_id: String(fix.owner_id), instruction: clip(String(fix.instruction).trim(), 800) }));
    return { passed: typeof data.passed === 'boolean' ? data.passed : (checks.length > 0 && checks.every((check) => check.ok)), checks, fixes };
  };
  const aborted = () => !!(signal && signal.aborted);

  try {
    await schedule(nodes);
    if (!aborted() && verifyRow) {
      if (!rows.some((row) => row.status === 'done')) {
        verifyRow.status = 'skipped';
        verifyRow.doing = 'No empieza: ningún agente terminó';
      } else if (budgetOut) {
        verifyRow.status = 'skipped';
        verifyRow.doing = 'No empieza: ' + budgetWord();
      } else {
        await runRow(verifyRow, verifyJob(), 'Comprobando');
        let verdict = verifyRow.status === 'done' ? readVerdict() : null;
        // Rounds of fixes (one by default, up to three): each owner gets what failed, then
        // the verifier looks again. It stops when everything passes, the same checks keep
        // failing (no progress), the budget is gone or the user stops.
        let lastFailing = '';
        while (verdict && !verdict.passed && verdict.fixes.length && rounds < fixRounds && !budgetOut && !aborted()) {
          const failing = failingKey(verdict.checks);
          if (failing && failing === lastFailing) break;
          lastFailing = failing;
          rounds++;
          const byOwner = new Map();
          verdict.fixes.forEach((fix) => {
            const row = rowById.get(fix.owner_id);
            if (!row || row.status === 'skipped' || !row.startedAt) return;
            byOwner.set(fix.owner_id, (byOwner.get(fix.owner_id) || []).concat(fix.instruction));
          });
          const owners = Array.from(byOwner.keys()).slice(0, pool.limit);
          if (!owners.length) break;
          await Promise.all(owners.map(async (id, index) => {
            if (index) await sleep(timing.stagger * index).catch(() => {});
            if (finished || aborted() || budgetOut) return;
            const row = rowById.get(id);
            const node = nodeById.get(id);
            const own = inner.get(id);
            const previous = sectionOf(row);
            const kept = { report: own.report, text: own.text, result: row.result, status: row.status };
            own.report = null;
            const task = (own.fullTask || taskFor(node)) + '\n\nTu informe anterior:\n' + clip(previous, 4000) + '\n\nEl verificador encontró: ' + byOwner.get(id).join(' ') + ' Corrige solo eso.';
            await runRow(row, jobFor(node, task), rounds > 1 ? 'Corrigiendo (ronda ' + rounds + ')' : 'Corrigiendo');
            // A fix that fails never erases the work that was already done.
            if (row.status !== 'done' && kept.status === 'done' && !aborted()) {
              own.report = kept.report;
              own.text = kept.text;
              row.result = kept.result;
              row.status = 'done';
              row.doing = 'La corrección no terminó: queda su informe anterior';
              push(true);
            }
          }));
          if (aborted() || budgetOut) break;
          inner.get('verify').report = null;
          await runRow(verifyRow, verifyJob(), rounds > 1 ? 'Comprobando otra vez (ronda ' + rounds + ')' : 'Comprobando otra vez');
          verdict = verifyRow.status === 'done' ? readVerdict() : verdict;
        }
        if (verdict) verify = { passed: verdict.passed, checks: verdict.checks.map((check) => ({ criterion: check.criterion, ok: check.ok, evidence: check.evidence })) };
      }
    }
    if (aborted()) {
      finished = true;
      const now = Date.now();
      allRows.forEach((row) => {
        if (row.status === 'running' || row.status === 'queued' || row.status === 'waiting') {
          row.status = 'stopped';
          row.doing = 'Detenido';
          row.endedAt = now;
        }
      });
      push(true);
      throw abortError();
    }
  } finally {
    finished = true;
    if (signal) signal.removeEventListener('abort', onParentAbort);
    if (ctx && typeof ctx.unregisterControls === 'function') ctx.unregisterControls(stepId);
    // What this run spent counts against the answer's cap, and what each agent
    // wrote stays readable for agent_report, even after a stop.
    turn.spent += totalCost();
    allRows.forEach((row) => {
      const own = inner.get(row.id);
      store.set(row.id, { id: row.id, name: row.name, role: row.role, status: row.status, task: own.fullTask || (nodeById.get(row.id) || {}).task || row.task, text: own.text, report: own.report });
    });
  }

  // ─── Resultado para el modelo principal ──────────────────────────
  // The «fewer at a time» notice is for while it lasts; a finished card carries none.
  notice = '';
  const ok = rows.filter((row) => row.status === 'done').length;
  const failedRows = rows.filter((row) => row.status === 'error' || row.status === 'stopped');
  const notStarted = rows.filter((row) => row.status === 'skipped' || row.status === 'queued').length;
  const limit = sectionLimit(rows.length);
  const parts = [];
  if (verify && acceptance.length) {
    const k = Math.min(acceptance.length, verify.checks.filter((check) => check.ok).length);
    const failing = verify.checks.filter((check) => !check.ok).map((check) => check.criterion).filter(Boolean);
    parts.push('Verificación: ' + k + '/' + acceptance.length + ' criterios OK' + (verify.passed ? '.' : (failing.length ? '; falla: ' + failing.slice(0, 5).join(' · ') : '.')));
  } else if (verifyRow && acceptance.length) {
    parts.push('Verificación: 0/' + acceptance.length + ' criterios OK (' + (verifyRow.status === 'done' ? 'el verificador no entregó su resultado' : verifyRow.doing) + ').');
  } else if (verifyRow) {
    // The light review (no criteria): its verdict also goes first.
    const checks = verify && Array.isArray(verify.checks) ? verify.checks : [];
    parts.push('Verificación: ' + (verify ? (verify.passed ? 'pasa' : 'no pasa') + (checks.length ? ' (' + checks.filter((check) => check.ok).length + '/' + checks.length + ' comprobaciones)' : '') : (verifyRow.status === 'done' ? 'hecha (ver su sección)' : verifyRow.doing || verifyRow.status)) + '.');
  }
  if (rounds) parts.push(rounds + (rounds === 1 ? ' ronda' : ' rondas') + ' de arreglos tras la verificación.');
  if (warnings.length) parts.push('Avisos del plan:\n' + warnings.map((item) => '- ' + item).join('\n'));
  rows.forEach((row) => parts.push(sectionOf(row, limit)));
  const files = touchedList();
  if (files.length) {
    parts.push('### Archivos tocados\n' + files.map((file) => (file.conflict ? '⚠ Conflicto posible: ' : '- ') + file.path + ' (' + file.agents.join(', ') + ')').join('\n'));
  }
  if (verifyRow && verifyRow.status !== 'queued') {
    const own = inner.get('verify');
    parts.push('## Verificación [' + (verify ? (verify.passed ? 'pasa' : 'no pasa') : verifyRow.status) + ']\n' +
      (verify && verify.checks.length ? verify.checks.map((check) => (check.ok ? '✓ ' : '✕ ') + check.criterion + (check.evidence ? ' — ' + check.evidence : '')).join('\n') : (own.report ? own.report.summary : verifyRow.doing)));
  }
  const seconds = Math.round((Date.now() - startAll) / 1000);
  parts.push('(' + rows.length + ' agentes en ' + waves + (waves === 1 ? ' oleada' : ' oleadas') + ': ' + ok + ' ok, ' + failedRows.length + ' fallidos, ' + notStarted + ' sin empezar, ' + money(totalCost()) + ') ' + seconds + ' s. Revisa e integra lo que han hecho antes de responder.');
  parts.push('Gasto de Ultra code en esta respuesta: ' + money(turn.spent) + ' de $' + turn.cap.toFixed(2) + '.' + (anyCut ? ' Hay informes recortados: agent_report con el id del agente da su texto completo.' : ''));
  if (failedRows.length || notStarted || (verify && !verify.passed)) {
    const redo = failedRows.concat(rows.filter((row) => row.status === 'skipped')).map((row) => row.name);
    parts.push('Siguiente paso sugerido: ' + (redo.length ? 'repite solo ' + quoteList(redo) + ' (con spawn_agents y una tarea más concreta' + (budgetOut ? ' o más budget_usd' : '') + ') o hazlo tú; lo que ya terminó está bien' : 'corrige tú lo que el verificador marca como fallido') + '.');
  }
  return textResult(parts.join('\n\n'), details());
}
