// Los informes de los agentes de Ultra code: la herramienta con la que cada uno
// entrega el suyo (submit_result), cómo se normalizan, cómo se resumen para el
// modelo principal (digest acotado, que no le llene la ventana de contexto) y la
// herramienta con la que él pide el texto completo de uno (agent_report).
import { Type } from '@earendil-works/pi-ai';
import { clip, textResult } from './common.js';

const REPORT_STATUS = ['done', 'partial', 'blocked'];
const ARTIFACT_KINDS = ['file', 'commit', 'pr', 'document', 'url'];
// Lo que cabe entre TODOS los informes que vuelven al modelo principal (en
// caracteres, unos 6 000 tokens). Pocos agentes: informes enteros; muchos: cada
// uno se recorta y el modelo pide el texto completo del que le importe.
export const RESULT_BUDGET = 24000;
const MIN_SECTION = 1200;
const FULL_REPORT = 14000;

export function normalizeReport(raw, keepData) {
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
export function synthesizeReport(text, status) {
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

export function reportBody(report, text) {
  const lines = [report.summary || '(sin resumen)'];
  if (report.artifacts && report.artifacts.length) lines.push('Artefactos:\n' + report.artifacts.map((item) => '- ' + item.kind + ': ' + item.ref + (item.note ? ' — ' + item.note : '')).join('\n'));
  if (report.open_issues && report.open_issues.length) lines.push('Pendiente:\n' + report.open_issues.map((item) => '- ' + item).join('\n'));
  if (!report.synthesized && text) {
    const raw = String(text).trim();
    if (raw && raw !== report.summary) lines.push(raw.length < 1500 ? raw : clip(raw, 1500, '… (texto completo en el panel del agente)'));
  }
  return lines.join('\n');
}

export function confidenceLabel(report) {
  return report && Number.isFinite(report.confidence) ? ', confianza ' + (Math.round(report.confidence * 100) / 100) : '';
}

export function compactReport(report) {
  if (!report) return undefined;
  const out = { summary: clip(report.summary, 1200), status: report.status, artifacts: (report.artifacts || []).slice(0, 10), open_issues: (report.open_issues || []).slice(0, 6) };
  if (Number.isFinite(report.confidence)) out.confidence = report.confidence;
  if (report.synthesized) out.synthesized = true;
  return out;
}

// How much of each agent's report goes back to the main model: all of it when few
// agents ran, an even share of RESULT_BUDGET when many did.
export function sectionLimit(count) {
  return Math.max(MIN_SECTION, Math.floor(RESULT_BUDGET / Math.max(1, Number(count) || 1)));
}

// A section cut to its share, with the way to read the rest.
export function trimSection(body, limit, id) {
  const text = String(body == null ? '' : body);
  if (!limit || text.length <= limit) return { text, cut: false };
  return { text: clip(text, limit, '… (recortado; agent_report con «' + id + '» da el texto completo)'), cut: true };
}

// agent_report: what the main model uses to read one agent's whole work when the
// digest it got was trimmed. lookup(query) → { id, name, role, status, task, text, report } | null;
// names() → the agents it can ask for.
export function createAgentReportTool(lookup, names) {
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
      const found = typeof lookup === 'function' ? lookup(query) : null;
      if (!found) {
        const known = typeof names === 'function' ? names() : [];
        return Object.assign(textResult(known.length ? 'No hay ningún agente «' + query + '» en esta respuesta. Agentes: ' + known.map((item) => item.id + ' (' + item.name + ')').join(', ') + '.' : 'Todavía no se ha lanzado ningún agente en esta respuesta.', {}), { isError: true });
      }
      const part = params && ['full', 'report', 'task'].includes(params.part) ? params.part : 'full';
      const head = '## ' + found.name + ' (' + found.id + ', ' + found.role + ', ' + found.status + ')';
      if (part === 'task') return textResult(head + '\nTarea:\n' + found.task, { agent: found.id });
      const report = found.report ? reportBody(found.report, '') : '(sin informe)';
      if (part === 'report') return textResult(head + '\n' + report, { agent: found.id });
      const body = String(found.text || '').trim();
      return textResult(clip(head + '\n' + report + (body && !(found.report && !found.report.synthesized && body === found.report.summary) ? '\n\nTexto final:\n' + body : ''), FULL_REPORT, '… (recortado)'), { agent: found.id });
    }
  };
}
