// Motor de inhouse learn sobre pi: pi-ai pone el proveedor (OpenRouter), el
// streaming y el coste, y pi-agent-core el bucle del agente con herramientas.
// Se empaqueta como window.InhousePi para que index.html lo use sin build propio.
//
// No hay catálogo fijo: los modelos salen en vivo de GET /models de OpenRouter,
// con sus precios, límites y niveles de razonamiento.
import { createModels, createProvider, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openRouterCost } from '@earendil-works/pi-ai/providers/openrouter-api';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { Agent } from '@earendil-works/pi-agent-core';
import Anthropic from '@anthropic-ai/sdk';
import JSZip from 'jszip';
import { createWorkspaceTools, normalizePath, runInSandbox, configureSandbox, globToRegExp } from './tools.js';
import { createGuidedTools } from './guided.js';
import { createLibraryTools } from './library.js';
import { createGithubTools, githubWhoAmI, githubPushStaged } from './github.js';
import { createToolCoach, NOTE_MARK } from './coach.js';
import { ageToolResults, estimateContextChars } from './context.js';

export { createWorkspaceTools, createGuidedTools, createLibraryTools, createGithubTools, githubWhoAmI, githubPushStaged, normalizePath, runInSandbox, configureSandbox, globToRegExp };
export { createToolCoach, NOTE_MARK, ageToolResults, estimateContextChars };
export { createDriveTools } from './gdrive.js';
export { createGmailTools, googleProblem } from './gmail.js';
export { createWebTools } from './web.js';
export { createAgentTools, createSubAgentReportTool, planAgents, ownsPath } from './agents.js';
export { createDocumentTools } from './documents.js';
export { createInteractTools } from './interact.js';
export { createStudyTools } from './study.js';
export { textQualityIssues, protectedTextSpans, TEXT_QUALITY_PROMPT } from './text-quality.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// xhigh solo se ofrece si el modelo no tiene max (ver thinkingLevels).
export const UI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Tope de salida por petición: OpenRouter reserva saldo según max_tokens, así que
// pedir el máximo del modelo (a veces cientos de miles) da 402 con poco saldo.
const MAX_OUTPUT_TOKENS = 32768;
const MAX_STEP_OUTPUT = 4000;
const EFFORT_FOR_LEVEL = { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const LEVEL_FOR_EFFORT = Object.fromEntries(Object.entries(EFFORT_FOR_LEVEL).map(([level, effort]) => [effort, level]));

// Lo que pone la app: key de OpenRouter y cabeceras propias.
const hooks = {
  getOpenRouterKey: () => '',
  getAnthropicKey: () => '',
  openRouterHeaders: {}
};

export function configure(next) {
  Object.assign(hooks, next || {});
}

const models = createModels();
models.setProvider(createProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl: OPENROUTER_BASE_URL,
  auth: {
    apiKey: {
      name: 'OpenRouter API key',
      resolve: async () => {
        const key = hooks.getOpenRouterKey();
        return key ? { auth: { apiKey: key } } : undefined;
      }
    }
  },
  models: [],
  api: openAICompletionsApi()
}));

// Claude directly with the user's own Anthropic API key (the API credit of a
// Claude plan, for instance): the official SDK, called from the browser, with
// prompt caching, adaptive thinking and effort handled by pi.
models.setProvider(createProvider({
  id: 'anthropic',
  name: 'Anthropic',
  baseUrl: 'https://api.anthropic.com',
  auth: {
    apiKey: {
      name: 'Anthropic API key',
      resolve: async () => {
        const key = hooks.getAnthropicKey();
        return key ? { auth: { apiKey: key } } : undefined;
      }
    }
  },
  models: [],
  api: anthropicMessagesApi()
}));

// ─── Modelos ─────────────────────────────────────────

const registered = new Map();

function isChatModel(entry) {
  const id = String((entry && entry.id) || '');
  const arch = (entry && entry.architecture) || {};
  const input = arch.input_modalities || ['text'];
  const output = arch.output_modalities || ['text'];
  return !!id && !id.startsWith('~') && !id.endsWith(':batch') &&
    input.includes('text') && output.includes('text') && !output.includes('image') && !output.includes('audio');
}

function perMillion(value) {
  const perToken = parseFloat(value);
  return Number.isFinite(perToken) && perToken > 0 ? Number((perToken * 1e6).toFixed(4)) : 0;
}

function titleCase(slug) {
  return String(slug || '').split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** Resumen de un modelo del listado: lo que necesitan la UI, la caché y pi. */
function summarize(entry, rank) {
  const companyId = entry.id.split('/')[0];
  const [first, ...rest] = String(entry.name || entry.id).split(': ');
  const params = entry.supported_parameters || [];
  const reasoning = entry.reasoning || (params.includes('reasoning') ? {} : null);
  const benchmarks = entry.benchmarks && entry.benchmarks.artificial_analysis;
  return {
    id: entry.id,
    name: rest.length ? rest.join(': ') : first,
    company: rest.length ? first : titleCase(companyId),
    companyId,
    rank,
    created: entry.created || 0,
    pricing: entry.pricing || {},
    price: { input: perMillion(entry.pricing && entry.pricing.prompt), output: perMillion(entry.pricing && entry.pricing.completion) },
    context: (entry.top_provider && entry.top_provider.context_length) || entry.context_length || 0,
    maxOutput: (entry.top_provider && entry.top_provider.max_completion_tokens) || 0,
    images: ((entry.architecture && entry.architecture.input_modalities) || []).includes('image'),
    audio: ((entry.architecture && entry.architecture.input_modalities) || []).includes('audio'),
    video: ((entry.architecture && entry.architecture.input_modalities) || []).includes('video'),
    files: ((entry.architecture && entry.architecture.input_modalities) || []).includes('file'),
    tools: params.includes('tools'),
    reasoning: reasoning && {
      efforts: Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts : [],
      defaultEffort: reasoning.default_effort || null,
      defaultEnabled: reasoning.default_enabled !== false,
      mandatory: !!reasoning.mandatory
    },
    // Artificial Analysis indices as published by OpenRouter for each model.
    intelligence: benchmarks && typeof benchmarks.intelligence_index === 'number' ? benchmarks.intelligence_index : null,
    coding: benchmarks && typeof benchmarks.coding_index === 'number' ? benchmarks.coding_index : null,
    agentic: benchmarks && typeof benchmarks.agentic_index === 'number' ? benchmarks.agentic_index : null
  };
}

function thinkingLevelMapFrom(reasoning) {
  if (!reasoning || !reasoning.efforts || !reasoning.efforts.length) return reasoning && reasoning.mandatory ? { off: null } : undefined;
  const map = {};
  for (const [level, effort] of Object.entries(EFFORT_FOR_LEVEL)) {
    map[level] = reasoning.efforts.includes(effort) ? effort : null;
  }
  if (reasoning.mandatory) map.off = null;
  return map;
}

function piModelFrom(summary) {
  return {
    id: summary.id,
    name: summary.name,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: !!summary.reasoning,
    thinkingLevelMap: thinkingLevelMapFrom(summary.reasoning),
    input: summary.images ? ['text', 'image'] : ['text'],
    cost: openRouterCost(summary.pricing),
    contextWindow: summary.context || 128000,
    maxTokens: Math.min(summary.maxOutput || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    compat: { thinkingFormat: 'openrouter' }
  };
}

/** Registra en pi una lista de modelos ya resumida (p. ej. la de la caché local). */
export function registerOpenRouterModels(summaries) {
  for (const summary of summaries || []) {
    if (summary && summary.id) registered.set(summary.id, { summary, model: piModelFrom(summary) });
  }
}

/**
 * Pide a OpenRouter todos sus modelos de chat. Por defecto en el orden de
 * "más usados esta semana", que es lo que la app muestra como recomendados.
 */
export async function fetchOpenRouterModels(options = {}) {
  const sort = options.sort || 'top-weekly';
  const response = await fetch(OPENROUTER_BASE_URL + '/models?sort=' + encodeURIComponent(sort), { signal: options.signal });
  if (!response.ok) throw new Error('OpenRouter respondió ' + response.status + ' al pedir la lista de modelos.');
  const body = await response.json();
  const summaries = (body.data || []).filter(isChatModel).map((entry, index) => summarize(entry, index));
  registerOpenRouterModels(summaries);
  return summaries;
}

// ─── Claude con la API de Anthropic ──────────────────
// App ids carry this prefix so they never collide with OpenRouter's
// «anthropic/…» models; the request uses the bare Anthropic id.
export const CLAUDE_API_PREFIX = 'claude-api/';
const CLAUDE_API_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
// Anthropic bills what is used, not what max_tokens reserves.
const CLAUDE_MAX_OUTPUT = 64000;

export function isClaudeApiModel(id) {
  return String(id || '').startsWith(CLAUDE_API_PREFIX);
}

/** The current Claude models as catalog entries (same shape as OpenRouter's), registered in pi. */
export function claudeApiModels() {
  return CLAUDE_API_MODELS.filter((id) => ANTHROPIC_MODELS[id]).map((id, index) => {
    const base = ANTHROPIC_MODELS[id];
    const levels = Object.entries(base.thinkingLevelMap || {}).filter(([, effort]) => effort).map(([, effort]) => effort);
    const summary = {
      id: CLAUDE_API_PREFIX + id,
      name: String(base.name || id).replace(/^Claude\s+/, ''),
      company: 'Claude · tu API',
      companyId: 'anthropic',
      provider: 'anthropic',
      rank: -100 + index,
      created: 0,
      pricing: { prompt: String(base.cost.input / 1e6), completion: String(base.cost.output / 1e6), input_cache_read: String((base.cost.cacheRead || 0) / 1e6), input_cache_write: String((base.cost.cacheWrite || 0) / 1e6) },
      price: { input: base.cost.input, output: base.cost.output },
      context: base.contextWindow,
      maxOutput: base.maxTokens,
      images: (base.input || []).includes('image'),
      audio: false,
      video: false,
      files: false,
      tools: true,
      reasoning: base.reasoning ? {
        efforts: levels,
        // Haiku answers fast at medium; the others give their best at high.
        defaultEffort: /haiku/.test(id) ? 'medium' : 'high',
        defaultEnabled: true,
        mandatory: !(base.thinkingLevelMap && base.thinkingLevelMap.off !== null)
      } : null,
      intelligence: null,
      coding: null,
      agentic: null
    };
    registered.set(summary.id, { summary, model: Object.assign({}, base, { maxTokens: Math.min(base.maxTokens || CLAUDE_MAX_OUTPUT, CLAUDE_MAX_OUTPUT) }) });
    return summary;
  });
}

/**
 * One short request without tools (a chat's title, for instance) with any
 * registered model: { text, cost, usage: { input, output } }.
 */
export async function quickComplete(id, systemPrompt, userText, options = {}) {
  const model = getModel(id);
  const result = await models.completeSimple(model, {
    systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() }]
  }, { maxTokens: options.maxTokens || 1024, reasoning: model.reasoning ? 'low' : undefined, signal: options.signal });
  if (result.stopReason === 'error' || result.errorMessage) throw new Error(result.errorMessage || 'Sin respuesta');
  const usage = result.usage || {};
  return { text: textOf(result, 'text'), cost: (usage.cost && usage.cost.total) || 0, usage: { input: (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0), output: usage.output || 0 } };
}

// What a web search costs on Anthropic's side ($10 per 1000), on top of tokens.
const CLAUDE_SEARCH_USD = 0.01;

/**
 * web_search for a Claude chat: Anthropic's own server-side search tool with
 * the chat's model and the user's key (OpenRouter is not involved).
 * Returns { results: [{ title, url, snippet }], digest, cost, usage }.
 */
export async function claudeWebSearch(id, query, options = {}) {
  const key = hooks.getAnthropicKey();
  if (!key) throw new Error('Para buscar en internet con Claude hace falta su API key.');
  const model = getModel(id);
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const dynamic = !/haiku/.test(model.id);
  const message = await client.messages.create({
    model: model.id,
    max_tokens: 4000,
    system: 'You are a web search engine. Search once for the query, then list what each relevant result says in 1-2 short sentences each, with its URL. Same language as the query. No introduction.',
    messages: [{ role: 'user', content: query }],
    tools: [{ type: dynamic ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    output_config: { effort: 'low' }
  }, { signal: options.signal });
  const seen = new Set();
  const results = [];
  const add = (url, title, snippet) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    results.push({ title: title || '', url, snippet: snippet || '' });
  };
  const blocks = Array.isArray(message.content) ? message.content : [];
  // Cited results first, with the sentence each one backs.
  blocks.forEach((block) => {
    if (block.type === 'text' && Array.isArray(block.citations)) block.citations.forEach((cite) => add(cite.url, cite.title, cite.cited_text));
  });
  blocks.forEach((block) => {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      block.content.slice(0, options.maxResults || 8).forEach((item) => add(item.url, item.title, ''));
    }
  });
  const digest = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('').trim().slice(0, 4000);
  const usage = message.usage || {};
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  const cost = ((usage.input_tokens || 0) * model.cost.input + (usage.output_tokens || 0) * model.cost.output +
    (usage.cache_read_input_tokens || 0) * (model.cost.cacheRead || 0) + (usage.cache_creation_input_tokens || 0) * (model.cost.cacheWrite || 0)) / 1e6 + searches * CLAUDE_SEARCH_USD;
  return { results, digest, cost, usage: { input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), output: usage.output_tokens || 0 } };
}

// ID que no está en el listado (escrito a mano): se trata como modelo genérico.
function fallbackModel(id) {
  return piModelFrom({ id, name: id, pricing: {}, images: true, reasoning: { efforts: [], defaultEnabled: true, mandatory: false }, context: 0, maxOutput: 0 });
}

export function getModel(id) {
  const entry = registered.get(id);
  if (entry) return entry.model;
  if (isClaudeApiModel(id)) {
    claudeApiModels();
    const claude = registered.get(id);
    if (claude) return claude.model;
  }
  return fallbackModel(id);
}

/** Niveles de razonamiento que la UI puede ofrecer para un modelo (vacío si no razona). */
export function thinkingLevels(id) {
  const model = getModel(id);
  if (!model.reasoning) return [];
  const supported = getSupportedThinkingLevels(model);
  const levels = UI_THINKING_LEVELS.filter((level) => supported.includes(level));
  return levels.includes('max') ? levels.filter((level) => level !== 'xhigh') : levels;
}

/** Nivel por defecto: el que OpenRouter dice que usa el modelo si no se pide otro. */
export function defaultThinkingLevel(id) {
  const levels = thinkingLevels(id);
  if (!levels.length) return '';
  const entry = registered.get(id);
  const reasoning = entry && entry.summary.reasoning;
  if (reasoning) {
    if (!reasoning.defaultEnabled && levels.includes('off')) return 'off';
    const fromEffort = reasoning.defaultEffort && LEVEL_FOR_EFFORT[reasoning.defaultEffort];
    if (fromEffort && levels.includes(fromEffort)) return fromEffort;
  }
  return ['medium', 'low', 'high', 'minimal', 'max', 'xhigh', 'off'].find((level) => levels.includes(level));
}

// ─── Agente ──────────────────────────────────────────

// What a tool call being written has so far (the model is billed for it too).
const toolCallChars = (message) => (message && Array.isArray(message.content) ? message.content : [])
  .filter((block) => block.type === 'toolCall')
  .reduce((sum, block) => sum + (typeof block.partialArgs === 'string' && block.partialArgs ? block.partialArgs.length : JSON.stringify(block.arguments || {}).length) + String(block.name || '').length, 0);

const textOf = (message, type) => (message && Array.isArray(message.content) ? message.content : [])
  .filter((block) => block.type === type)
  .map((block) => (type === 'text' ? block.text : block.thinking))
  .join('');

// Some models write their reasoning inside the answer, between <think> tags
// (sometimes only the closing one, or still open while streaming). The page
// drops unknown tags but keeps their text, so the reasoning showed up in the
// middle of the chat: move it to the thinking section.
const THINK_BLOCK = /<(think|thinking|reasoning)>([\s\S]*?)(?:<\/\1>|$)/gi;
const THINK_CLOSE_ONLY = /^([\s\S]*?)<\/(think|thinking|reasoning)>/i;
// options.finished: the message is complete. A tag still open then held no
// reasoning (the answer itself mentioned «<thinking>»), so nothing is moved.
export function splitReasoning(raw, options) {
  let text = String(raw || '');
  if (options && options.finished && /<(think|thinking|reasoning)>/i.test(text) && !/<\/(think|thinking|reasoning)>/i.test(text)) {
    return { text, thinking: '' };
  }
  const thoughts = [];
  if (!/<(think|thinking|reasoning)>/i.test(text)) {
    const closing = THINK_CLOSE_ONLY.exec(text);
    if (closing) {
      thoughts.push(closing[1].trim());
      text = text.slice(closing[0].length);
    }
  }
  text = text.replace(THINK_BLOCK, (match, tag, body) => { thoughts.push(body.trim()); return ''; });
  return { text: thoughts.length ? text.replace(/^\s+/, '') : text, thinking: thoughts.filter(Boolean).join('\n\n') };
}

// Claude (Anthropic's API) sends its reasoning in its own blocks: its text is
// all answer, even when it mentions a <thinking> tag.
const answerOf = (message, finished) => {
  const raw = textOf(message, 'text');
  const split = message && message.provider === 'anthropic' ? { text: raw, thinking: '' } : splitReasoning(raw, { finished });
  const thinking = [textOf(message, 'thinking'), split.thinking].filter((part) => part && part.trim()).join('\n\n');
  return { text: split.text, thinking };
};

// The coach's notes are for the model only: step.output (what the user sees) skips them.
const resultText = (result) => (result && Array.isArray(result.content) ? result.content : [])
  .filter((block) => block.type === 'text' && !String(block.text || '').startsWith(NOTE_MARK))
  .map((block) => block.text)
  .join('\n');

function abortError() {
  const error = new Error('Solicitud cancelada.');
  error.name = 'AbortError';
  return error;
}

// Failures worth repeating the same request for: the provider was busy, rate
// limited or the connection dropped. A bad request, a bad key or no credit
// (400/401/402) would only fail again.
const TRANSIENT_ERROR = /\b(408|425|429|500|502|503|504|529)\b|overloaded|rate.?limit|temporarily|timed? ?out|fetch failed|ECONNRESET|Provider returned error/i;
const NOT_TRANSIENT = /\b(400|401|402)\b/;
const OVERFLOW_ERROR = /context (length|window)|too many tokens|maximum context|prompt is too long/i;

export function isContextOverflow(message) {
  return OVERFLOW_ERROR.test(String(message || ''));
}

export function isTransientError(message) {
  const text = String(message || '');
  return TRANSIENT_ERROR.test(text) && !NOT_TRANSIENT.test(text) && !OVERFLOW_ERROR.test(text);
}

// Share of the context window the transcript may fill before old tool results
// are trimmed, and characters per token of the estimate.
const CONTEXT_SHARE = 0.55;
const CHARS_PER_TOKEN = 3.5;
const RETRY_BASE_MS = 1500;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done);
  });
}

// The next deeper reasoning level the model supports ('' when there is none).
// Never from off: a turn without reasoning was the user's choice.
function deeperLevel(model, level) {
  if (!level || level === 'off' || !model || !model.reasoning) return '';
  let supported;
  try { supported = getSupportedThinkingLevels(model); } catch (_) { return ''; }
  let levels = UI_THINKING_LEVELS.filter((item) => supported.includes(item));
  // Same ladder the picker offers (thinkingLevels): xhigh only without max.
  if (levels.includes('max')) levels = levels.filter((item) => item !== 'xhigh' || item === level);
  const index = levels.indexOf(level);
  return index >= 0 && index < levels.length - 1 ? levels[index + 1] : '';
}

/**
 * Ejecuta un turno completo del agente (puede encadenar varias llamadas al
 * modelo si usa herramientas).
 *
 * history: mensajes de pi anteriores (user / assistant / toolResult)
 * prompt: mensaje de usuario de pi
 * onUpdate({ text, thinking, steps, cost, liveChars, retry }) se llama con cada
 * avance; retry es { attempt, max } mientras se repite una petición que falló
 * por un error pasajero (hasta que llega su primer texto), y null si no.
 * steering (opcional): la función le pone steering.steer(userMessage), que mete
 * un mensaje del usuario en cuanto acaba la llamada al modelo o la herramienta
 * en curso, sin cancelar nada. Cuando entra se llama a
 * onSteer({ message, segment: { text, thinking, steps, messages } }) con lo
 * hecho hasta ahí, y el resto de la ejecución es un segmento nuevo.
 * maxRetries (2): cuántas veces se repite una petición tras un error pasajero
 * (429, 5xx, red cortada…), con espera 1.5 s, 3 s…; un desbordamiento del
 * contexto se repite una vez recortando más los resultados viejos.
 * escalate: tras 2 errores de herramientas seguidos, sube el razonamiento un
 * nivel (nunca desde off).
 * coach (por defecto sí; false lo quita): notas para el modelo en los
 * resultados de las herramientas (coach.js).
 * toolExecution: 'sequential' (por defecto) o 'parallel' (las herramientas sin
 * executionMode 'sequential' de una misma respuesta corren a la vez).
 * Cada paso lleva startedAt / endedAt (ms). La herramienta think no es un
 * paso: su texto va al razonamiento.
 * Devuelve { text, thinking, steps, messages, usage, retries, escalated } (del
 * último segmento) o lanza con el error del modelo. usage: { input (total,
 * caché incluida), output, cacheRead, cacheWrite, cost }.
 */
// What the Ultra code board (ultra.js) draws: the agents and the run's waves,
// budget, verification and touched files, copied from the tool's details.
function copyBoard(step, details) {
  step.agents = details.agents;
  ['waves', 'budget', 'verify', 'files', 'warnings'].forEach((key) => { if (details[key] !== undefined) step[key] = details[key]; });
}

// Coach notes help the model inside the turn; saved history never keeps them
// (a later turn would read «Llevas N errores en este turno» out of context).
function withoutCoachNotes(list) {
  return list.map((message) => (message && message.role === 'toolResult' && Array.isArray(message.content) && message.content.some((block) => block.type === 'text' && String(block.text || '').startsWith(NOTE_MARK))
    ? Object.assign({}, message, { content: message.content.filter((block) => !(block.type === 'text' && String(block.text || '').startsWith(NOTE_MARK))) })
    : message));
}

export async function runAgent(options) {
  const model = options.model;
  const maxRetries = Number.isFinite(Number(options.maxRetries)) ? Math.max(0, Math.floor(Number(options.maxRetries))) : 2;
  const coach = options.coach === false ? undefined : createToolCoach();

  // Context budget in characters; an overflow error lowers it and forces the trim.
  let budgetFactor = 1;
  let forceAging = false;
  const transformContext = async (messages) => {
    const budget = (model && model.contextWindow ? model.contextWindow : 128000) * CONTEXT_SHARE * CHARS_PER_TOKEN * budgetFactor;
    if (!forceAging && estimateContextChars(messages) <= budget) return messages;
    // After an overflow only the newest round stays whole.
    return ageToolResults(messages, { budget, keepRounds: forceAging ? 1 : 2 });
  };

  // Escalation: two tool errors in a row → one level deeper, once per run.
  let consecutiveToolErrors = 0;
  let escalated = '';
  const prepareRequest = async ({ thinkingLevel }) => {
    if (options.escalate && !escalated && consecutiveToolErrors >= 2) {
      const next = deeperLevel(model, thinkingLevel);
      if (next) {
        escalated = next;
        // continue() after a retry starts from the agent's own state.
        agent.state.thinkingLevel = next;
      }
    }
    return escalated ? { thinkingLevel: escalated } : undefined;
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model,
      thinkingLevel: options.thinkingLevel || 'off',
      tools: options.tools || [],
      messages: options.history || []
    },
    streamFn: (streamModel, context, streamOptions) => models.streamSimple(streamModel, context, streamModel.provider === 'openrouter'
      ? { ...streamOptions, headers: { ...(streamOptions && streamOptions.headers), ...hooks.openRouterHeaders } }
      : streamOptions),
    sessionId: options.sessionId,
    // pi runs a batch in parallel only if every tool in it lacks executionMode
    // 'sequential' (writes and questions keep their order).
    toolExecution: options.toolExecution === 'parallel' ? 'parallel' : 'sequential',
    afterToolCall: coach,
    transformContext,
    prepareRequest
  });

  let doneTexts = [];
  let doneThinking = [];
  let steps = [];
  let messages = [];
  const steered = new Set();
  if (options.steering) {
    options.steering.steer = (message) => {
      steered.add(message);
      agent.steer(message);
    };
  }
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let liveText = '';
  let liveThinking = '';
  let liveTools = 0;
  let failure = null;
  // Where the failed request's partial answer went, to take it back on a retry.
  let failureSlot = -1;
  let retry = null;
  let retries = 0;
  const thoughts = new Map();

  const join = (parts, live) => parts.concat(live ? [live] : []).filter((part) => part && part.trim()).join('\n\n');
  const emit = () => {
    if (typeof options.onUpdate === 'function') {
      // cost: what the finished requests cost; liveChars: what the current one has
      // written so far (the app estimates its price until the request ends).
      options.onUpdate({ text: join(doneTexts, liveText), thinking: join(doneThinking, liveThinking), steps: steps.slice(), cost: usage.cost, liveChars: liveText.length + liveThinking.length + liveTools, retry: retry ? { ...retry } : null });
    }
  };

  agent.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'user' && steered.has(event.message)) {
      steered.delete(event.message);
      const segment = { text: join(doneTexts, ''), thinking: join(doneThinking, ''), steps, messages: withoutCoachNotes(messages) };
      doneTexts = [];
      doneThinking = [];
      steps = [];
      messages = [];
      liveText = '';
      liveThinking = '';
      liveTools = 0;
      if (typeof options.onSteer === 'function') options.onSteer({ message: event.message, segment });
      emit();
      return;
    }
    if (event.type === 'message_update' && event.message.role === 'assistant') {
      const answer = answerOf(event.message);
      liveText = answer.text;
      liveThinking = answer.thinking;
      liveTools = toolCallChars(event.message);
      // The repeated request is answering: the "retrying" row can go.
      if (retry && (liveText || liveThinking || liveTools)) retry = null;
      emit();
    } else if (event.type === 'message_end' && event.message.role !== 'user') {
      const message = event.message;
      messages.push(message);
      if (message.role === 'assistant') {
        liveText = '';
        liveThinking = '';
        liveTools = 0;
        const answer = answerOf(message, true);
        doneTexts.push(answer.text);
        doneThinking.push(answer.thinking);
        if (message.usage) {
          // input stays the whole prompt (cache included); the cache parts are also kept apart.
          usage.input += (message.usage.input || 0) + (message.usage.cacheRead || 0) + (message.usage.cacheWrite || 0);
          usage.output += message.usage.output || 0;
          usage.cacheRead += message.usage.cacheRead || 0;
          usage.cacheWrite += message.usage.cacheWrite || 0;
          usage.cost += (message.usage.cost && message.usage.cost.total) || 0;
        }
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          failure = message;
          failureSlot = doneTexts.length - 1;
        } else {
          retry = null;
        }
        emit();
      }
    } else if (event.type === 'tool_execution_start') {
      // think is a private scratchpad: its thought joins the reasoning, never a step.
      if (event.toolName === 'think') {
        thoughts.set(event.toolCallId, String((event.args && event.args.thought) || ''));
        return;
      }
      steps.push({ id: event.toolCallId, name: event.toolName, args: event.args || {}, status: 'running', output: '', startedAt: Date.now() });
      emit();
    } else if (event.type === 'tool_execution_update') {
      // Long tools (the APK release) say what they are doing meanwhile.
      const step = steps.find((item) => item.id === event.toolCallId);
      if (step && step.status === 'running') {
        const output = resultText(event.partialResult);
        step.output = output.length > MAX_STEP_OUTPUT ? output.slice(-MAX_STEP_OUTPUT) : output;
        step.progress = output.split('\n').filter(Boolean).pop() || '';
        // Ultra code: what each parallel agent is doing and spending.
        if (event.partialResult && event.partialResult.details && Array.isArray(event.partialResult.details.agents)) copyBoard(step, event.partialResult.details);
        emit();
      }
    } else if (event.type === 'tool_execution_end') {
      if (thoughts.has(event.toolCallId)) {
        const details = event.result && event.result.details;
        const thought = String((details && details.thought) || thoughts.get(event.toolCallId) || '').trim();
        thoughts.delete(event.toolCallId);
        // Joined to the current request's reasoning (doneThinking has one entry per
        // assistant message; an extra entry would shift what a retry removes).
        if (thought) { if (doneThinking.length) doneThinking[doneThinking.length - 1] = [doneThinking[doneThinking.length - 1], thought].filter(Boolean).join('\n\n'); else liveThinking = [liveThinking, thought].filter(Boolean).join('\n\n'); }
        emit();
        return;
      }
      consecutiveToolErrors = event.isError ? consecutiveToolErrors + 1 : 0;
      const step = steps.find((item) => item.id === event.toolCallId);
      if (step) {
        step.status = event.isError ? 'error' : 'done';
        step.endedAt = Date.now();
        const output = resultText(event.result);
        step.output = output.length > MAX_STEP_OUTPUT ? output.slice(0, MAX_STEP_OUTPUT) + '\n…' : output;
        const details = event.result && event.result.details;
        // Web pages a tool found or read: the app lists them as the answer's sources.
        if (details && Array.isArray(details.sources)) step.sources = details.sources.slice(0, 12);
        if (details && Array.isArray(details.agents)) copyBoard(step, details);
        if (details && Array.isArray(details.plan)) step.plan = details.plan;
        // Documents a tool created or edited: the app shows them under the answer.
        if (details && Array.isArray(details.documents) && details.documents.length) step.documents = details.documents.slice(0, 12);
      }
      emit();
    }
  });

  // Take the failed request out of the transcript (and of what this run
  // shows) so continue() asks again from the user message or tool results
  // before it: tools that already ran are not run again.
  const dropFailure = () => {
    agent.state.messages = agent.state.messages.filter((message) => message !== failure);
    messages = messages.filter((message) => message !== failure);
    if (failureSlot >= 0 && failureSlot < doneTexts.length) {
      doneTexts.splice(failureSlot, 1);
      doneThinking.splice(failureSlot, 1);
    }
    failure = null;
    failureSlot = -1;
  };

  const signal = options.signal;
  const onAbort = () => agent.abort();
  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', onAbort);
  }
  let overflowRetried = false;
  try {
    let run = () => agent.prompt(options.prompt);
    let dropped = null;
    for (;;) {
      failure = null;
      failureSlot = -1;
      try {
        await run();
      } catch (error) {
        // continue() refused the transcript: report the error that led here.
        if (!dropped) throw error;
        failure = dropped;
        break;
      }
      dropped = null;
      if ((signal && signal.aborted) || !failure || failure.stopReason !== 'error') break;
      const reason = failure.errorMessage || '';
      if (isContextOverflow(reason) && !overflowRetried) {
        overflowRetried = true;
        budgetFactor = 0.3;
        forceAging = true;
        dropped = failure;
        dropFailure();
        run = () => agent.continue();
        continue;
      }
      if (!isTransientError(reason) || retries >= maxRetries) break;
      retries++;
      dropped = failure;
      dropFailure();
      retry = { attempt: retries, max: maxRetries };
      emit();
      await sleep(RETRY_BASE_MS * Math.pow(2, retries - 1), signal);
      if (signal && signal.aborted) break;
      run = () => agent.continue();
    }
  } catch (error) {
    // What the finished requests cost is spent even when the run fails.
    if (error && typeof error === 'object') error.usage = usage;
    throw error;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    // A steer that arrived too late for this run goes back to the app.
    if (options.steering) {
      options.steering.steer = null;
      options.steering.undelivered = Array.from(steered);
      agent.clearAllQueues();
    }
  }

  if ((signal && signal.aborted) || (failure && failure.stopReason === 'aborted')) throw Object.assign(abortError(), { usage });
  if (failure) {
    const error = new Error(failure.errorMessage || 'El modelo ha devuelto un error.');
    error.partial = { text: join(doneTexts, ''), steps };
    error.usage = usage;
    error.retries = retries;
    throw error;
  }
  // A turn that ends with no words and no tools would leave a blank answer
  // under «Razonamiento»: say what happened instead (what it cost is kept).
  if (!join(doneTexts, '').trim() && !steps.length) {
    const last = messages.filter((message) => message && message.role === 'assistant').pop();
    const error = new Error(last && last.stopReason === 'length'
      ? 'El modelo se ha quedado sin espacio de salida mientras pensaba y no ha llegado a escribir la respuesta. Prueba con menos razonamiento o vuelve a intentarlo.'
      : 'El modelo ha terminado sin escribir ninguna respuesta. Vuelve a intentarlo.');
    error.partial = { text: '', steps, thinking: join(doneThinking, '') };
    error.usage = usage;
    error.retries = retries;
    error.emptyAnswer = true;
    throw error;
  }
  return {
    text: join(doneTexts, ''),
    thinking: join(doneThinking, ''),
    steps,
    messages: withoutCoachNotes(messages),
    usage,
    retries,
    escalated
  };
}

// ─── ZIP ─────────────────────────────────────────────

export async function zipFiles(files) {
  const zip = new JSZip();
  for (const file of files) zip.file(file.path, file.content);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
