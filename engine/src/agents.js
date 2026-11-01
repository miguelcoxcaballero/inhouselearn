// Ultra code: el modelo reparte un trabajo grande entre varios agentes de pi y
// recibe sus informes para integrarlos. Esta versión (v3) sigue siendo un
// planificador de agentes que dependen unos de otros (depends_on, por oleadas),
// cada uno con sus archivos (files), con un presupuesto común (budget_usd) y un
// verificador de solo lectura que intenta refutar el trabajo y puede pedir rondas
// de arreglos; y suma lo que lo hace más listo, útil y barato:
//   · esfuerzo por rol (quien lee piensa menos), pasos máximos por rol;
//   · no empezar un agente que el presupuesto no deja terminar, menos agentes a la
//     vez si el proveedor limita las peticiones, y un tope por respuesta;
//   · un plan que no puede funcionar se rechaza una vez antes de gastar nada;
//   · los informes vuelven recortados (el contexto del modelo es caro) y
//     agent_report da el texto completo del que importe.
//
// El código está repartido: agents/plan.js (el plan), agents/policy.js (las reglas
// de decisión), agents/effort.js, agents/report.js (informes y digest) y
// agents/run.js (la ejecución, lo único con estado). Todos son puros y no dependen de
// pi: este archivo es el único que importa su esquema (Type), define las herramientas
// y conserva la API que usan index.js, la app y los tests.
//
// La app crea cada agente (ctx.runSubAgent: mismo modelo, mismas herramientas
// salvo spawn_agents, la misma puerta de aprobación) y dibuja en el chat lo que
// hace cada uno (details.agents, compacto porque viaja en el directo).
//
// ctx: {
//   runSubAgent(job) → Promise<{ text, cost, report? }>,
//   registerControls?(stepId, { stop(agentId) }), unregisterControls?(stepId),
//   turnBudget?: tope en $ de todos los spawn_agents de la respuesta (8 por defecto),
//   timing?: { stagger, backoff, grace }   (solo para los tests)
// }
// job: { id, name, role, effort, task, readOnly, ownedFiles, maxSteps, hue, signal,
//        onUpdate(update), onWrite(path, kind) → string|undefined, onReport(report) }
// update: { doing?, cost?, steps?, trail?, kind?, waiting?, wrote? }
import { Type } from '@earendil-works/pi-ai';
import { MAX_AGENTS, MAX_PARALLEL, DEFAULT_BUDGET, DEFAULT_MINUTES, DEFAULT_TURN_BUDGET, MIN_BUDGET, textResult, ownsPath } from './agents/common.js';
import { planAgents } from './agents/plan.js';
import { ARTIFACT_KINDS, normalizeReport, fullReportText } from './agents/report.js';
import { runSpawn, STAGGER_MS } from './agents/run.js';
import { pickLevel, normalizeEffort, STEP_CAPS, EFFORTS } from './agents/effort.js';

export { planAgents, ownsPath, pickLevel, normalizeEffort, MAX_PARALLEL };
export const MAX_AGENT_STEPS = STEP_CAPS.build;

const SPAWN_DESCRIPTION = 'Ultra code: split a big job into parts and run them as separate agents (up to ' + MAX_AGENTS + ', ' + MAX_PARALLEL + ' at a time), then integrate what they return. Agents start from zero and never see this conversation: put what all need (user goal, decisions, repository, branch, conventions) in context once, and give each a self-contained task (what, where, what to return in returns); a task of a few words with no context is refused once, before anything is spent. ' +
  'depends_on: ids of agents whose results this one needs; it starts when they finish and receives their reports (waves); independent agents run in parallel. ' +
  'files: globs this agent owns; only it should change them (two agents editing one file without a dependency conflict). ' +
  'role "explore" = read-only research (reasons at medium, 25 steps); "build" writes (high, 40 steps); effort low|medium|high|max sets it per agent: do not pay max for reading. ' +
  'acceptance: checkable criteria; a read-only verifier (by default when something is written, when there are criteria or with 3+ agents; verify:false skips it) tries to refute the work against the real files/commits/sources, and the owners fix what fails: fix_rounds times (default 1, up to 3; it stops when nothing improves). ' +
  'budget_usd (default ' + DEFAULT_BUDGET + '): cap for this call, and the answer as a whole has a cap too; the most expensive agent is stopped when it runs out and none is started that what is left could not finish. When many agents ran their results come back trimmed: agent_report(agent) gives one agent\'s full text. ' +
  'max_minutes per agent (default ' + DEFAULT_MINUTES + '). on_failure "stop" skips everything not started once one fails. Do not use it for a single small task.';

// ─── submit_result: how each agent hands in its report ─────────────────────────────────
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

// ─── agent_report: how the main model reads one agent in full ────────────────────────
// lookup(query) → the stored entry of an agent | null; names() → [{ id, name }] it can ask for.
function createAgentReportTool(lookup, names) {
  return {
    name: 'agent_report',
    label: 'Informe de un agente',
    description: 'Read the full report and final text of one agent from a spawn_agents run of this answer (give its id or its name, as in the results). The results you got back are trimmed to keep your context short: use this only for the agents whose details you really need. part: full (default), report (only its structured report) or task (what it was asked).',
    parameters: Type.Object({
      agent: Type.String({ description: 'The agent id or name.' }),
      part: Type.Optional(Type.Union([Type.Literal('full'), Type.Literal('report'), Type.Literal('task')]))
    }),
    execute: async (id, params) => {
      const query = String((params && params.agent) || '').trim();
      const found = lookup(query);
      if (!found) {
        const known = names();
        return Object.assign(textResult(known.length ? 'No hay ningún agente «' + query + '» en esta respuesta. Agentes: ' + known.map((item) => item.id + ' (' + item.name + ')').join(', ') + '.' : 'Todavía no se ha lanzado ningún agente en esta respuesta.', {}), { isError: true });
      }
      const part = params && ['full', 'report', 'task'].includes(params.part) ? params.part : 'full';
      return textResult(fullReportText(found, part), { agent: found.id });
    }
  };
}

// ─── spawn_agents y agent_report ────────────────────────────────────────
// The app builds these tools again for each answer, so what they remember (what
// was spent, what each agent wrote, whether a plan was already refused) is the
// state of ONE answer.
export function createAgentTools(ctx) {
  const timing = Object.assign({ stagger: STAGGER_MS, backoff: 1500, grace: 1500 }, ctx && ctx.timing);
  const cap = Number(ctx && ctx.turnBudget);
  const turn = { spent: 0, cap: Number.isFinite(cap) && cap >= MIN_BUDGET ? cap : DEFAULT_TURN_BUDGET };
  const store = new Map();
  const gate = { refused: false };
  const env = { ctx, timing, turn, store, gate };
  // An agent by id, by exact name, or by part of its name (the latest run wins).
  const lookup = (query) => {
    const wanted = String(query || '').trim().toLowerCase();
    if (!wanted) return null;
    const entries = Array.from(store.values());
    return entries.find((entry) => entry.id.toLowerCase() === wanted) ||
      entries.find((entry) => String(entry.name).toLowerCase() === wanted) ||
      entries.find((entry) => String(entry.name).toLowerCase().includes(wanted)) || null;
  };
  const names = () => Array.from(store.values()).map((entry) => ({ id: entry.id, name: entry.name }));
  return [
    {
      name: 'spawn_agents',
      label: 'Agentes en paralelo',
      description: SPAWN_DESCRIPTION,
      parameters: Type.Object({
        goal: Type.Optional(Type.String({ description: 'The overall goal, in one or two sentences (the verifier checks against it).' })),
        context: Type.Optional(Type.String({ description: 'Shared brief every agent receives before its task: what was decided, where things are, conventions.' })),
        acceptance: Type.Optional(Type.Array(Type.String(), { maxItems: 10, description: 'Checkable acceptance criteria for the whole job.' })),
        verify: Type.Optional(Type.Boolean({ description: 'Run the read-only verifier at the end (default: when something is written, with criteria or with 3+ agents).' })),
        fix_rounds: Type.Optional(Type.Number({ minimum: 0, maximum: 3, description: 'Rounds of fixes after a failed verification (default 1; it stops when nothing improves).' })),
        budget_usd: Type.Optional(Type.Number({ minimum: MIN_BUDGET, maximum: 20, description: 'Spending cap for all agents of this call, in USD (default ' + DEFAULT_BUDGET + ').' })),
        on_failure: Type.Optional(Type.Union([Type.Literal('continue'), Type.Literal('stop')])),
        agents: Type.Array(Type.Object({
          id: Type.Optional(Type.String({ description: 'Short id for depends_on, e.g. "api".' })),
          name: Type.String({ description: 'Short name, e.g. "Tests", "Investigación precios".' }),
          task: Type.String({ description: 'The complete, self-contained task.' }),
          role: Type.Optional(Type.Union([Type.Literal('explore'), Type.Literal('build')])),
          effort: Type.Optional(Type.Union(EFFORTS.map((effort) => Type.Literal(effort)), { description: 'How hard it thinks (default: medium for explore, high for build).' })),
          depends_on: Type.Optional(Type.Array(Type.String())),
          files: Type.Optional(Type.Array(Type.String(), { description: 'Globs of the files this agent owns.' })),
          returns: Type.Optional(Type.String({ description: 'What it must return.' })),
          max_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 30 }))
        }), { minItems: 1, maxItems: MAX_AGENTS })
      }),
      executionMode: 'sequential',
      execute: (stepId, params, signal, onUpdate) => runSpawn(env, stepId, params || {}, signal, onUpdate)
    },
    createAgentReportTool(lookup, names)
  ];
}
