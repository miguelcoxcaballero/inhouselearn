// Motor de inhouse learn sobre pi: pi-ai pone el proveedor (OpenRouter), el
// streaming y el coste, y pi-agent-core el bucle del agente con herramientas.
// Se empaqueta como window.InhousePi para que index.html lo use sin build propio.
//
// No hay catálogo fijo: los modelos salen en vivo de GET /models de OpenRouter,
// con sus precios, límites y niveles de razonamiento.
import { createModels, createProvider, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openRouterCost } from '@earendil-works/pi-ai/providers/openrouter-api';
import { Agent } from '@earendil-works/pi-agent-core';
import JSZip from 'jszip';
import { createWorkspaceTools, normalizePath, runInSandbox } from './tools.js';

export { createWorkspaceTools, normalizePath, runInSandbox };

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

// ID que no está en el listado (escrito a mano): se trata como modelo genérico.
function fallbackModel(id) {
  return piModelFrom({ id, name: id, pricing: {}, images: true, reasoning: { efforts: [], defaultEnabled: true, mandatory: false }, context: 0, maxOutput: 0 });
}

export function getModel(id) {
  const entry = registered.get(id);
  return entry ? entry.model : fallbackModel(id);
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

const textOf = (message, type) => (message && Array.isArray(message.content) ? message.content : [])
  .filter((block) => block.type === type)
  .map((block) => (type === 'text' ? block.text : block.thinking))
  .join('');

const resultText = (result) => (result && Array.isArray(result.content) ? result.content : [])
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n');

function abortError() {
  const error = new Error('Solicitud cancelada.');
  error.name = 'AbortError';
  return error;
}

/**
 * Ejecuta un turno completo del agente (puede encadenar varias llamadas al
 * modelo si usa herramientas).
 *
 * history: mensajes de pi anteriores (user / assistant / toolResult)
 * prompt: mensaje de usuario de pi
 * onUpdate({ text, thinking, steps }) se llama con cada avance.
 * Devuelve { text, thinking, steps, messages, usage } o lanza con el error del modelo.
 */
export async function runAgent(options) {
  const model = options.model;
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
    toolExecution: 'sequential'
  });

  const doneTexts = [];
  const doneThinking = [];
  const steps = [];
  const messages = [];
  const usage = { input: 0, output: 0, cost: 0 };
  let liveText = '';
  let liveThinking = '';
  let failure = null;

  const join = (parts, live) => parts.concat(live ? [live] : []).filter((part) => part && part.trim()).join('\n\n');
  const emit = () => {
    if (typeof options.onUpdate === 'function') {
      options.onUpdate({ text: join(doneTexts, liveText), thinking: join(doneThinking, liveThinking), steps: steps.slice() });
    }
  };

  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.message.role === 'assistant') {
      liveText = textOf(event.message, 'text');
      liveThinking = textOf(event.message, 'thinking');
      emit();
    } else if (event.type === 'message_end' && event.message.role !== 'user') {
      const message = event.message;
      messages.push(message);
      if (message.role === 'assistant') {
        liveText = '';
        liveThinking = '';
        doneTexts.push(textOf(message, 'text'));
        doneThinking.push(textOf(message, 'thinking'));
        if (message.usage) {
          usage.input += (message.usage.input || 0) + (message.usage.cacheRead || 0) + (message.usage.cacheWrite || 0);
          usage.output += message.usage.output || 0;
          usage.cost += (message.usage.cost && message.usage.cost.total) || 0;
        }
        if (message.stopReason === 'error' || message.stopReason === 'aborted') failure = message;
        emit();
      }
    } else if (event.type === 'tool_execution_start') {
      steps.push({ id: event.toolCallId, name: event.toolName, args: event.args || {}, status: 'running', output: '' });
      emit();
    } else if (event.type === 'tool_execution_end') {
      const step = steps.find((item) => item.id === event.toolCallId);
      if (step) {
        step.status = event.isError ? 'error' : 'done';
        const output = resultText(event.result);
        step.output = output.length > MAX_STEP_OUTPUT ? output.slice(0, MAX_STEP_OUTPUT) + '\n…' : output;
      }
      emit();
    }
  });

  const signal = options.signal;
  const onAbort = () => agent.abort();
  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', onAbort);
  }
  try {
    await agent.prompt(options.prompt);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if ((signal && signal.aborted) || (failure && failure.stopReason === 'aborted')) throw abortError();
  if (failure) {
    const error = new Error(failure.errorMessage || 'El modelo ha devuelto un error.');
    error.partial = { text: join(doneTexts, ''), steps };
    throw error;
  }
  return {
    text: join(doneTexts, ''),
    thinking: join(doneThinking, ''),
    steps,
    messages,
    usage
  };
}

// ─── ZIP ─────────────────────────────────────────────

export async function zipFiles(files) {
  const zip = new JSZip();
  for (const file of files) zip.file(file.path, file.content);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
