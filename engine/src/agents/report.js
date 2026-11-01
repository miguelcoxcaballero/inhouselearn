// Los informes de los agentes de Ultra code: cómo se normalizan, cómo se resumen
// para el modelo principal (digest acotado, que no le llene la ventana de contexto)
// y cómo se lee uno entero. Puro: sin red, sin DOM y sin pi-ai (las herramientas
// que los entregan y los leen, submit_result y agent_report, se definen en
// agents.js, el único módulo que necesita el esquema de pi).
import { clip } from './common.js';

export const REPORT_STATUS = ['done', 'partial', 'blocked'];
export const ARTIFACT_KINDS = ['file', 'commit', 'pr', 'document', 'url'];
// Lo que cabe entre TODOS los informes que vuelven al modelo principal (en
// caracteres, unos 6 000 tokens). Pocos agentes: informes enteros; muchos: cada
// uno se recorta y el modelo pide el texto completo del que le importe.
export const RESULT_BUDGET = 24000;
const MIN_SECTION = 1200;
// Lo máximo que devuelve agent_report de un agente.
export const FULL_REPORT = 14000;

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

// What agent_report returns for one agent: its report and its final text (or only
// one of them), cut at FULL_REPORT. entry: { id, name, role, status, task, text, report }.
export function fullReportText(entry, part) {
  const head = '## ' + entry.name + ' (' + entry.id + ', ' + entry.role + ', ' + entry.status + ')';
  if (part === 'task') return head + '\nTarea:\n' + entry.task;
  const report = entry.report ? reportBody(entry.report, '') : '(sin informe)';
  if (part === 'report') return head + '\n' + report;
  const body = String(entry.text || '').trim();
  const sameAsSummary = !!(entry.report && !entry.report.synthesized && body === entry.report.summary);
  return clip(head + '\n' + report + (body && !sameAsSummary ? '\n\nTexto final:\n' + body : ''), FULL_REPORT, '… (recortado)');
}
