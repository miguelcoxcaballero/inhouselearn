// Ultra code: el modelo reparte un trabajo grande entre varios agentes de pi y
// recibe sus informes para integrarlos. Esta versión (v2) es un pequeño
// planificador: los agentes pueden depender unos de otros (depends_on, por
// oleadas), cada uno puede ser dueño de unos archivos (files), hay un
// presupuesto común (budget_usd) y, al final, un verificador de solo lectura
// comprueba los criterios de aceptación contra lo real y puede pedir UNA ronda
// de arreglos a los responsables.
//
// La app crea cada agente (ctx.runSubAgent: mismo modelo, mismas herramientas
// salvo spawn_agents, la misma puerta de aprobación) y dibuja en el chat lo que
// hace cada uno (details.agents, compacto porque viaja en el directo).
//
// ctx: {
//   runSubAgent(job) → Promise<{ text, cost, report? }>,
//   registerControls?(stepId, { stop(agentId) }), unregisterControls?(stepId),
//   timing?: { stagger, backoff, grace }   (solo para los tests)
// }
// job: { id, name, role, task, readOnly, ownedFiles, maxSteps, hue, signal,
//        onUpdate(update), onWrite(path, kind) → string|undefined, onReport(report) }
// update: { doing?, cost?, steps?, trail?, kind?, waiting?, wrote? }
import { Type } from '@earendil-works/pi-ai';

const MAX_AGENTS = 12;
export const MAX_PARALLEL = 6;
export const MAX_AGENT_STEPS = 40;
const DEFAULT_MINUTES = 10;
const DEFAULT_BUDGET = 1;
// The first agent goes alone for a moment so the provider's prompt cache (same
// system prompt and tools for everyone) is written once and read by the rest.
const STAGGER_MS = 300;
const MAX_TRIES = 3;
const TRANSIENT = /429|rate.?limit|overloaded|\b5\d\d\b|network|failed to fetch|timeout|ECONNRESET/i;
// No \b after an accented letter (it is not a \w in JS regexps): an explicit end instead.
const VAGUE = /(?:^|[^\wáéíóúñ])(arriba|antes|esta conversaci[oó]n|lo que te pas[eé]|above|previous)(?![\wáéíóúñ])/i;
// File paths named in a task (a known extension, so "e.g." or "v1.2" are not paths).
const PATH_IN_TEXT = /(?:^|[\s`'"(«])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:m?js|cjs|jsx|tsx?|css|scss|html?|md|json|ya?ml|toml|txt|py|rb|go|rs|java|kts?|swift|c|cc|cpp|h|hpp|cs|php|sh|sql|vue|svelte|xml|svg|csv|tex|bib|gradle|docx|xlsx|pptx|pdf))(?=$|[\s`'")»,:;!?]|\.(?:\s|$))/g;
const FAILED = new Set(['error', 'stopped', 'skipped']);
const ACTIVE = new Set(['running', 'waiting']);

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

function clip(text, max, note) {
  const value = String(text == null ? '' : text);
  return value.length > max ? value.slice(0, max).replace(/\s+\S*$/, '') + (note || '…') : value;
}

const money = (value) => '$' + (Number(value) || 0).toFixed(4);
const quoteList = (names) => names.map((name) => '«' + name + '»').join(', ');

function abortError(message) {
  const error = new Error(message || 'Detenido.');
  error.name = 'AbortError';
  return error;
}

function slug(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

// Small glob → RegExp (*, **, ?), only to tell an agent that a path belongs to another.
function globRegExp(glob) {
  let out = '';
  const text = String(glob || '').trim().replace(/^\.?\/+/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '*') {
      if (text[i + 1] === '*') { out += '.*'; i++; if (text[i + 1] === '/') i++; } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + (/[*?]/.test(text) || /\.[^/]+$/.test(text) ? '' : '(?:/.*)?') + '$');
}

const ownsPath = (globs, path) => (globs || []).some((glob) => { try { return globRegExp(glob).test(String(path || '').replace(/^\/+/, '')); } catch (_) { return false; } });

// ─── Plan ────────────────────────────────────────────
// planAgents(list) → { nodes, waves, warnings }. Throws when a dependency does
// not exist or the graph has a cycle (the model fixes the call and retries).
export function planAgents(list) {
  const raw = (Array.isArray(list) ? list : []).filter((agent) => agent && String(agent.task || '').trim()).slice(0, MAX_AGENTS);
  if (!raw.length) throw new Error('Pasa al menos un agente con su tarea.');
  const used = new Set();
  const given = new Map(); // id the model wrote → id it ended with (first wins)
  const nodes = raw.map((agent, index) => {
    const name = String(agent.name || '').trim().slice(0, 60) || 'Agente ' + (index + 1);
    const wanted = String(agent.id == null ? '' : agent.id).trim().slice(0, 40);
    let id = wanted && !used.has(wanted) ? wanted : '';
    if (!id) {
      const base = slug(name) || 'agente-' + (index + 1);
      id = base;
      for (let n = 2; used.has(id); n++) id = base + '-' + n;
    }
    used.add(id);
    if (wanted && !given.has(wanted)) given.set(wanted, id);
    if (!given.has(id)) given.set(id, id);
    const minutes = Math.max(1, Math.min(30, Math.round(Number(agent.max_minutes)) || DEFAULT_MINUTES));
    return {
      id, name, index,
      task: String(agent.task).trim(),
      role: agent.role === 'explore' ? 'explore' : 'build',
      rawDeps: (Array.isArray(agent.depends_on) ? agent.depends_on : []).map((dep) => String(dep).trim()).filter(Boolean),
      files: (Array.isArray(agent.files) ? agent.files : []).map((glob) => String(glob).trim()).filter(Boolean).slice(0, 20),
      returns: String(agent.returns || '').trim(),
      maxMinutes: minutes,
      deps: [], wave: 1
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node) => {
    node.deps = Array.from(new Set(node.rawDeps.map((dep) => {
      const id = given.get(dep) || (byId.has(dep) ? dep : '');
      if (!id) throw new Error('depends_on «' + dep + '» no existe');
      return id;
    })));
    if (node.deps.includes(node.id)) throw new Error('Hay un ciclo: ' + node.id + ' → ' + node.id);
    delete node.rawDeps;
  });
  // Cycle check and wave = longest path from a root + 1.
  const state = new Map();
  const trail = [];
  const depth = (node) => {
    if (state.get(node.id) === 2) return node.wave;
    if (state.get(node.id) === 1) {
      const from = trail.indexOf(node.id);
      throw new Error('Hay un ciclo: ' + trail.slice(from).concat(node.id).join(' → '));
    }
    state.set(node.id, 1);
    trail.push(node.id);
    node.wave = 1 + node.deps.reduce((max, dep) => Math.max(max, depth(byId.get(dep))), 0);
    trail.pop();
    state.set(node.id, 2);
    return node.wave;
  };
  nodes.forEach(depth);
  const waves = nodes.reduce((max, node) => Math.max(max, node.wave), 0);
  // Lint: what makes a sub-agent fail most often is a task that leans on a
  // conversation it never saw, or two agents rewriting the same file.
  const warnings = [];
  nodes.forEach((node) => {
    if (node.task.length < 120) warnings.push('La tarea de «' + node.name + '» es muy corta (' + node.task.length + ' caracteres): cada agente empieza de cero; di qué hacer, dónde y qué devolver.');
    const vague = VAGUE.exec(node.task);
    if (vague) warnings.push('«' + node.name + '» menciona «' + vague[1] + '», pero no ve esta conversación: pon eso en context o en su tarea.');
  });
  const ancestors = new Map();
  const ancestorsOf = (node) => {
    if (ancestors.has(node.id)) return ancestors.get(node.id);
    const set = new Set();
    node.deps.forEach((dep) => { set.add(dep); ancestorsOf(byId.get(dep)).forEach((id) => set.add(id)); });
    ancestors.set(node.id, set);
    return set;
  };
  const pathsOf = (node) => {
    const set = new Set(node.files.filter((glob) => !/[*?]/.test(glob)).map((path) => path.replace(/^\.?\/+/, '')));
    let match;
    PATH_IN_TEXT.lastIndex = 0;
    while ((match = PATH_IN_TEXT.exec(node.task))) if (!/^\d+(\.\d+)+$/.test(match[1]) && !/^https?:/i.test(match[1])) set.add(match[1].replace(/^\.?\/+/, ''));
    return set;
  };
  const paths = nodes.map(pathsOf);
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      if (ancestorsOf(nodes[a]).has(nodes[b].id) || ancestorsOf(nodes[b]).has(nodes[a].id)) continue;
      const shared = Array.from(paths[a]).filter((path) => paths[b].has(path));
      if (shared.length) warnings.push('«' + nodes[a].name + '» y «' + nodes[b].name + '» nombran los dos ' + shared.slice(0, 3).join(', ') + ' y ninguno depende del otro: dáselo a uno solo (files) o haz que uno dependa del otro.');
    }
  }
  return { nodes, waves, warnings };
}

// ─── Informe de cada agente ──────────────────────────
const REPORT_STATUS = ['done', 'partial', 'blocked'];
const ARTIFACT_KINDS = ['file', 'commit', 'pr', 'document', 'url'];

function normalizeReport(raw, keepData) {
  if (!raw || typeof raw !== 'object') return null;
  const report = {
    summary: clip(String(raw.summary || '').trim(), 3000),
    status: REPORT_STATUS.includes(raw.status) ? raw.status : 'done',
    artifacts: (Array.isArray(raw.artifacts) ? raw.artifacts : []).filter((item) => item && item.ref).slice(0, 20).map((item) => {
      const artifact = { kind: ARTIFACT_KINDS.includes(item.kind) ? item.kind : 'url', ref: clip(String(item.ref), 300) };
      if (item.note) artifact.note = clip(String(item.note), 200);
      return artifact;
    }),
    open_issues: (Array.isArray(raw.open_issues) ? raw.open_issues : []).map((item) => clip(String(item || '').trim(), 300)).filter(Boolean).slice(0, 10)
  };
  const confidence = Number(raw.confidence);
  if (raw.confidence != null && Number.isFinite(confidence)) report.confidence = Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence));
  if (keepData && raw.data !== undefined) report.data = raw.data;
  if (raw.synthesized) report.synthesized = true;
  return report;
}

// Tool the app gives each sub-agent so it ends with a structured report.
export function createSubAgentReportTool(onSubmit) {
  return {
    name: 'submit_result',
    label: 'Entregar informe',
    description: 'Hand your result to the main assistant when your task is finished (or you cannot go on). Call it once, at the end: summary of what you did and found, status (done, partial or blocked), the artifacts you produced (files, commits, PRs, documents, URLs), what is still open, your confidence (0-1) and, only if your task asks for it, structured data. Then end with one sentence.',
    parameters: Type.Object({
      summary: Type.String({ description: 'What you did and found, concise and complete (the main assistant integrates it).' }),
      status: Type.Union([Type.Literal('done'), Type.Literal('partial'), Type.Literal('blocked')]),
      artifacts: Type.Optional(Type.Array(Type.Object({
        kind: Type.Union(ARTIFACT_KINDS.map((kind) => Type.Literal(kind))),
        ref: Type.String({ description: 'Path, commit sha, PR URL, document name or URL.' }),
        note: Type.Optional(Type.String())
      }))),
      open_issues: Type.Optional(Type.Array(Type.String())),
      confidence: Type.Optional(Type.Number({ description: '0 to 1.' })),
      data: Type.Optional(Type.Any({ description: 'Structured data, only when the task asks for it.' }))
    }),
    execute: async (id, params) => {
      const report = normalizeReport(params, true);
      if (typeof onSubmit === 'function') onSubmit(report);
      return textResult('Recibido. Termina con una frase.', { report: Object.assign({}, report, { data: undefined }) });
    }
  };
}

// No submit_result: the text itself becomes the report (links as artifacts).
function synthesizeReport(text, status) {
  const value = String(text || '').trim();
  const artifacts = [];
  const seen = new Set();
  (value.match(/https?:\/\/[^\s)>\]»"']+/g) || []).forEach((url) => {
    const ref = url.replace(/[.,;:]+$/, '');
    if (seen.has(ref) || artifacts.length >= 8) return;
    seen.add(ref);
    artifacts.push({ kind: /\/commit\/[0-9a-f]{7,}/.test(ref) ? 'commit' : /\/pull\/\d+/.test(ref) ? 'pr' : 'url', ref });
  });
  return { summary: clip(value, 1500, '… (texto completo en el panel del agente)') || '(sin respuesta)', status, artifacts, open_issues: [], synthesized: true };
}

function reportBody(report, text) {
  const lines = [report.summary || '(sin resumen)'];
  if (report.artifacts && report.artifacts.length) lines.push('Artefactos:\n' + report.artifacts.map((item) => '- ' + item.kind + ': ' + item.ref + (item.note ? ' — ' + item.note : '')).join('\n'));
  if (report.open_issues && report.open_issues.length) lines.push('Pendiente:\n' + report.open_issues.map((item) => '- ' + item).join('\n'));
  if (!report.synthesized && text) {
    const raw = String(text).trim();
    if (raw && raw !== report.summary) lines.push(raw.length < 1500 ? raw : clip(raw, 1500, '… (texto completo en el panel del agente)'));
  }
  return lines.join('\n');
}

function confidenceLabel(report) {
  return report && Number.isFinite(report.confidence) ? ', confianza ' + (Math.round(report.confidence * 100) / 100) : '';
}

const SPAWN_DESCRIPTION = 'Ultra code: split a big job into parts and run them as separate agents (up to ' + MAX_AGENTS + ', ' + MAX_PARALLEL + ' at a time), then integrate what they return. Agents start from zero and never see this conversation: put what all need (user goal, decisions, repository, branch, conventions) in context once, and give each a self-contained task (what, where, what to return in returns). ' +
  'depends_on: ids of agents whose results this one needs; it starts when they finish and receives their reports (waves); independent agents run in parallel. ' +
  'files: globs this agent owns; only it should change them (two agents editing one file without a dependency conflict). role "explore" = read-only research. ' +
  'acceptance: checkable criteria; a read-only verifier checks them against the real files/commits/sources after the agents and may send one round of fixes to the owners (verify:false to skip; with ≥2 agents a light review runs by default). ' +
  'budget_usd (default ' + DEFAULT_BUDGET + '): cap for all agents together; the most expensive is stopped when it runs out. max_minutes per agent (default ' + DEFAULT_MINUTES + '). on_failure "stop" skips everything not started once one fails. Do not use it for a single small task.';

// ─── spawn_agents ────────────────────────────────────
export function createAgentTools(ctx) {
  const timing = Object.assign({ stagger: STAGGER_MS, backoff: 1500, grace: 1500 }, ctx && ctx.timing);
  return [
    {
      name: 'spawn_agents',
      label: 'Agentes en paralelo',
      description: SPAWN_DESCRIPTION,
      parameters: Type.Object({
        goal: Type.Optional(Type.String({ description: 'The overall goal, in one or two sentences (the verifier checks against it).' })),
        context: Type.Optional(Type.String({ description: 'Shared brief every agent receives before its task: what was decided, where things are, conventions.' })),
        acceptance: Type.Optional(Type.Array(Type.String(), { maxItems: 10, description: 'Checkable acceptance criteria for the whole job.' })),
        verify: Type.Optional(Type.Boolean({ description: 'Run the read-only verifier at the end (default: yes with 2+ agents).' })),
        budget_usd: Type.Optional(Type.Number({ minimum: 0.05, maximum: 20, description: 'Spending cap for all agents together, in USD (default ' + DEFAULT_BUDGET + ').' })),
        on_failure: Type.Optional(Type.Union([Type.Literal('continue'), Type.Literal('stop')])),
        agents: Type.Array(Type.Object({
          id: Type.Optional(Type.String({ description: 'Short id for depends_on, e.g. "api".' })),
          name: Type.String({ description: 'Short name, e.g. "Tests", "Investigación precios".' }),
          task: Type.String({ description: 'The complete, self-contained task.' }),
          role: Type.Optional(Type.Union([Type.Literal('explore'), Type.Literal('build')])),
          depends_on: Type.Optional(Type.Array(Type.String())),
          files: Type.Optional(Type.Array(Type.String(), { description: 'Globs of the files this agent owns.' })),
          returns: Type.Optional(Type.String({ description: 'What it must return.' })),
          max_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 30 }))
        }), { minItems: 1, maxItems: MAX_AGENTS })
      }),
      executionMode: 'sequential',
      execute: (stepId, params, signal, onUpdate) => runSpawn(ctx, timing, stepId, params || {}, signal, onUpdate)
    }
  ];
}

async function runSpawn(ctx, timing, stepId, params, signal, onUpdate) {
  const plan = planAgents(params.agents);
  const { nodes, waves, warnings } = plan;
  const goal = String(params.goal || '').trim();
  const context = String(params.context || '').trim();
  const acceptance = (Array.isArray(params.acceptance) ? params.acceptance : []).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 10);
  const budget = Math.max(0.05, Math.min(20, Number(params.budget_usd) || DEFAULT_BUDGET));
  const stopOnFailure = params.on_failure === 'stop';
  const doVerify = params.verify === false ? false : (params.verify === true || nodes.length >= 2);
  const startAll = Date.now();

  const rows = nodes.map((node) => ({
    id: node.id, name: node.name, role: node.role, task: clip(node.task, 400),
    status: 'queued', doing: 'En cola', kind: '', cost: 0, steps: 0, maxSteps: MAX_AGENT_STEPS,
    startedAt: 0, endedAt: 0, trail: [], result: '', files: [], wave: node.wave, deps: node.deps.slice(),
    hue: Math.round((node.index * 137.508 + 210) % 360)
  }));
  const verifyRow = doVerify ? {
    id: 'verify', name: 'Verificación', role: 'verify', task: acceptance.length ? clip(acceptance.map((item, i) => (i + 1) + '. ' + item).join(' '), 400) : 'Comprueba que cada informe cumple su tarea.',
    status: 'queued', doing: 'Después de los agentes', kind: '', cost: 0, steps: 0, maxSteps: MAX_AGENT_STEPS,
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
  let finished = false;
  let failedName = '';

  const totalCost = () => allRows.reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
  const details = () => {
    const out = { agents: allRows.map((row) => Object.assign({}, row, { trail: row.trail.slice(-24), files: row.files.slice(0, 20) })), waves, budget };
    if (verify) out.verify = verify;
    const files = touchedList();
    if (files.length) out.files = files;
    if (warnings.length) out.warnings = warnings.slice();
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
    const active = allRows.filter((row) => ACTIVE.has(row.status) && !inner.get(row.id).stopReason).sort((a, b) => b.cost - a.cost);
    if (active.length) stopRow(active[0], 'Parado: presupuesto agotado ($' + budget.toFixed(2) + ')');
  };

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
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      own.controller = controller;
      if (signal && signal.aborted) controller.abort();
      let attemptCost = 0;
      let remaining = job.maxMinutes * 60000;
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
          if (update.steps >= job.maxSteps && !own.stopReason) { own.stopReason = 'Parado: límite de ' + job.maxSteps + ' pasos'; controller.abort(); }
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
        ownedFiles: job.ownedFiles, maxSteps: job.maxSteps, hue: row.hue,
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
  const sectionOf = (row) => {
    const own = inner.get(row.id);
    const report = own.report;
    const status = report && row.status === 'done' ? report.status : row.status;
    const head = '## ' + row.name + ' [' + status + confidenceLabel(report) + ']';
    if (row.status === 'skipped') return head + '\n' + row.doing;
    if (row.status === 'error' && !report) return head + '\nHa fallado: ' + row.doing;
    return head + (row.status === 'stopped' ? '\n' + row.doing + '.' : '') + '\n' + (report ? reportBody(report, own.text) : (own.text || '(sin respuesta)'));
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
  const jobFor = (node, task) => ({ role: node.role, task, readOnly: node.role === 'explore', ownedFiles: node.files.length ? node.files.slice() : null, maxSteps: MAX_AGENT_STEPS, maxMinutes: node.maxMinutes });

  // Starts every node whose dependencies are done, ≤ MAX_PARALLEL at a time,
  // staggered; failures skip their dependants (or everything, on_failure stop).
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
          : budgetOut ? 'No empieza: presupuesto agotado'
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
      if (ready.length && running.size < MAX_PARALLEL) {
        const gap = lastStart ? timing.stagger - (Date.now() - lastStart) : 0;
        if (gap > 0) {
          try { await sleep(gap); } catch (_) { break; }
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

  // The verifier: read-only, checks the reports against what really exists.
  const verifierTask = () => {
    const workers = rows.filter((row) => row.status !== 'skipped');
    return 'Eres el verificador de un trabajo que han hecho varios agentes. No cambies nada: solo comprueba.\n\n' +
      (goal ? 'Objetivo: ' + goal + '\n\n' : '') + (context ? 'Contexto:\n' + clip(context, 4000) + '\n\n' : '') +
      (acceptance.length ? 'Criterios de aceptación:\n' + acceptance.map((item, i) => (i + 1) + '. ' + item).join('\n') : 'No hay criterios explícitos: comprueba que cada informe cumple su tarea (un criterio por agente).') +
      '\n\nTareas e informes de los agentes:\n' + workers.map((row) => '### ' + row.name + ' (id ' + row.id + ', ' + row.status + ')\nTarea: ' + clip(nodeById.get(row.id).task, 1500) + '\nInforme:\n' + clip(sectionOf(row), 3000)).join('\n\n') +
      '\n\nComprueba cada criterio contra lo real: lee los archivos, commits, PRs, documentos o fuentes que citan (no te fíes solo de los informes), sin cambiar nada. ' +
      'Después llama a submit_result con data = { "passed": true|false, "checks": [{ "criterion": "…", "ok": true|false, "evidence": "qué viste y dónde", "owner_id": "id del agente responsable" }], "fixes": [{ "owner_id": "…", "instruction": "qué tiene que corregir, concreto" }] }. ' +
      'fixes solo para lo que falla; passed es true si todo se cumple.';
  };
  const verifyJob = () => ({ role: 'verify', task: verifierTask(), readOnly: true, ownedFiles: null, maxSteps: MAX_AGENT_STEPS, maxMinutes: DEFAULT_MINUTES });
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

  try {
    await schedule(nodes);
    if (!(signal && signal.aborted) && verifyRow) {
      if (!rows.some((row) => row.status === 'done')) {
        verifyRow.status = 'skipped';
        verifyRow.doing = 'No empieza: ningún agente terminó';
      } else if (budgetOut) {
        verifyRow.status = 'skipped';
        verifyRow.doing = 'No empieza: presupuesto agotado';
      } else {
        await runRow(verifyRow, verifyJob(), 'Comprobando');
        let verdict = verifyRow.status === 'done' ? readVerdict() : null;
        // One round of fixes at most: each owner gets what failed, then the verifier looks again.
        if (verdict && !verdict.passed && verdict.fixes.length && !budgetOut && !(signal && signal.aborted)) {
          const byOwner = new Map();
          verdict.fixes.forEach((fix) => {
            const row = rowById.get(fix.owner_id);
            if (!row || row.status === 'skipped' || !row.startedAt) return;
            byOwner.set(fix.owner_id, (byOwner.get(fix.owner_id) || []).concat(fix.instruction));
          });
          const owners = Array.from(byOwner.keys()).slice(0, MAX_PARALLEL);
          await Promise.all(owners.map(async (id, index) => {
            if (index) await sleep(timing.stagger * index).catch(() => {});
            if (finished || (signal && signal.aborted) || budgetOut) return;
            const row = rowById.get(id);
            const node = nodeById.get(id);
            const own = inner.get(id);
            const previous = sectionOf(row);
            const kept = { report: own.report, text: own.text, result: row.result, status: row.status };
            own.report = null;
            const task = (own.fullTask || taskFor(node)) + '\n\nTu informe anterior:\n' + clip(previous, 4000) + '\n\nEl verificador encontró: ' + byOwner.get(id).join(' ') + ' Corrige solo eso.';
            await runRow(row, jobFor(node, task), 'Corrigiendo');
            // A fix that fails never erases the work that was already done.
            if (row.status !== 'done' && kept.status === 'done' && !(signal && signal.aborted)) {
              own.report = kept.report;
              own.text = kept.text;
              row.result = kept.result;
              row.status = 'done';
              row.doing = 'La corrección no terminó: queda su informe anterior';
              push(true);
            }
          }));
          if (!(signal && signal.aborted) && !budgetOut) {
            inner.get('verify').report = null;
            await runRow(verifyRow, verifyJob(), 'Comprobando otra vez');
            verdict = verifyRow.status === 'done' ? readVerdict() : verdict;
          }
        }
        if (verdict) verify = { passed: verdict.passed, checks: verdict.checks.map((check) => ({ criterion: check.criterion, ok: check.ok, evidence: check.evidence })) };
      }
    }
    if (signal && signal.aborted) {
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
  }

  // ─── Resultado para el modelo principal ────────────
  const ok = rows.filter((row) => row.status === 'done').length;
  const failedRows = rows.filter((row) => row.status === 'error' || row.status === 'stopped');
  const notStarted = rows.filter((row) => row.status === 'skipped' || row.status === 'queued').length;
  const parts = [];
  if (verify && acceptance.length) {
    const k = Math.min(acceptance.length, verify.checks.filter((check) => check.ok).length);
    const failing = verify.checks.filter((check) => !check.ok).map((check) => check.criterion).filter(Boolean);
    parts.push('Verificación: ' + k + '/' + acceptance.length + ' criterios OK' + (verify.passed ? '.' : (failing.length ? '; falla: ' + failing.slice(0, 5).join(' · ') : '.')));
  } else if (verifyRow && acceptance.length) {
    parts.push('Verificación: 0/' + acceptance.length + ' criterios OK (' + (verifyRow.status === 'done' ? 'el verificador no entregó su resultado' : verifyRow.doing) + ').');
  }
  if (warnings.length) parts.push('Avisos del plan:\n' + warnings.map((item) => '- ' + item).join('\n'));
  rows.forEach((row) => parts.push(sectionOf(row)));
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
  if (failedRows.length || notStarted || (verify && !verify.passed)) {
    const redo = failedRows.concat(rows.filter((row) => row.status === 'skipped')).map((row) => row.name);
    parts.push('Siguiente paso sugerido: ' + (redo.length ? 'repite solo ' + quoteList(redo) + ' (con spawn_agents y una tarea más concreta' + (budgetOut ? ' o más budget_usd' : '') + ') o hazlo tú; lo que ya terminó está bien' : 'corrige tú lo que el verificador marca como fallido') + '.');
  }
  return textResult(parts.join('\n\n'), details());
}

function compactReport(report) {
  if (!report) return undefined;
  const out = { summary: clip(report.summary, 1200), status: report.status, artifacts: (report.artifacts || []).slice(0, 10), open_issues: (report.open_issues || []).slice(0, 6) };
  if (Number.isFinite(report.confidence)) out.confidence = report.confidence;
  if (report.synthesized) out.synthesized = true;
  return out;
}
