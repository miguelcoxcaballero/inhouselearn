// Motor de inhouse learn sobre pi: pi-ai pone los proveedores y el streaming, y
// pi-agent-core el bucle del agente con herramientas. Se empaqueta como
// window.InhousePi para que index.html lo use sin build propio.
import { createModels, createProvider, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openRouterCost } from '@earendil-works/pi-ai/providers/openrouter-api';
import { Agent } from '@earendil-works/pi-agent-core';
import JSZip from 'jszip';
import catalog from './catalog.json';
import { codeAssistApi } from './code-assist-api.js';
import { createWorkspaceTools, normalizePath, runInSandbox } from './tools.js';

export { createWorkspaceTools, normalizePath, runInSandbox };

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
export const UI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MAX_STEP_OUTPUT = 4000;

// Lo que pone la app: key de OpenRouter, cabeceras propias y el acceso a Code Assist.
const hooks = {
  getOpenRouterKey: () => '',
  openRouterHeaders: {},
  codeAssist: null
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
  models: catalog.openrouter,
  api: openAICompletionsApi()
}));
models.setProvider(createProvider({
  id: 'gemini',
  name: 'Gemini (cuenta de Google)',
  baseUrl: CODE_ASSIST_BASE_URL,
  auth: { apiKey: { name: 'Cuenta de Google', resolve: async () => ({ auth: {} }) } },
  models: [],
  api: codeAssistApi(() => {
    if (!hooks.codeAssist) throw new Error('Entra con Google para usar Gemini.');
    return hooks.codeAssist;
  })
}));

// ─── Modelos ─────────────────────────────────────────

const catalogOpenRouter = new Map(catalog.openrouter.map((model) => [model.id, model]));
const listedOpenRouter = new Map();
let listingPromise = null;

function openRouterModelFromListing(entry) {
  const params = entry.supported_parameters || [];
  const modalities = (entry.architecture && entry.architecture.input_modalities) || ['text'];
  return {
    id: entry.id,
    name: entry.name || entry.id,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: params.includes('reasoning'),
    input: modalities.filter((kind) => kind === 'text' || kind === 'image'),
    cost: entry.pricing ? openRouterCost(entry.pricing) : ZERO_COST,
    contextWindow: (entry.top_provider && entry.top_provider.context_length) || entry.context_length || 128000,
    maxTokens: (entry.top_provider && entry.top_provider.max_completion_tokens) || 32768,
    compat: { thinkingFormat: 'openrouter', supportsDeveloperRole: false, sendSessionAffinityHeaders: true }
  };
}

// Modelo sin datos todavía (ID personalizado antes de consultar el listado).
function openRouterFallback(id) {
  return openRouterModelFromListing({ id, supported_parameters: ['reasoning', 'tools'], architecture: { input_modalities: ['text', 'image'] } });
}

/** Trae del listado público de OpenRouter los modelos que no están en el catálogo de pi. */
export async function prepareOpenRouterModel(id) {
  if (!id || catalogOpenRouter.has(id) || listedOpenRouter.has(id)) return;
  if (!listingPromise) {
    listingPromise = fetch(OPENROUTER_BASE_URL + '/models')
      .then((response) => (response.ok ? response.json() : { data: [] }))
      .then((body) => {
        for (const entry of body.data || []) {
          if (entry && entry.id && !catalogOpenRouter.has(entry.id)) {
            listedOpenRouter.set(entry.id, openRouterModelFromListing(entry));
          }
        }
      })
      .catch(() => {
        listingPromise = null;
      });
  }
  await listingPromise;
}

const geminiTemplates = new Map(catalog.gemini.map((model) => [model.id, model]));

function geminiTemplate(id) {
  if (geminiTemplates.has(id)) return geminiTemplates.get(id);
  // Nombres que solo existen en Code Assist (p. ej. gemini-3-flash): se toman
  // los controles de razonamiento de su familia.
  if (/^gemini-([3-9]|\d{2})/.test(id)) {
    return geminiTemplates.get(id.includes('pro') ? 'gemini-3.1-pro-preview' : 'gemini-3-flash-preview') || {};
  }
  return {};
}

export function getGeminiModel(id) {
  const template = geminiTemplate(id);
  return {
    id,
    name: id,
    api: 'gemini-code-assist',
    provider: 'gemini',
    baseUrl: CODE_ASSIST_BASE_URL,
    reasoning: template.reasoning !== false,
    // 2.5 Pro no deja apagar el razonamiento (presupuesto mínimo 128).
    thinkingLevelMap: template.thinkingLevelMap || (id.includes('2.5-pro') ? { off: null } : undefined),
    input: template.input || ['text', 'image'],
    cost: ZERO_COST,
    contextWindow: template.contextWindow || 1048576,
    maxTokens: Math.min(template.maxTokens || 65536, 65536)
  };
}

export function getModel(provider, id) {
  if (provider === 'gemini') return getGeminiModel(id);
  return catalogOpenRouter.get(id) || listedOpenRouter.get(id) || openRouterFallback(id);
}

/** Niveles de razonamiento que la UI puede ofrecer para un modelo. */
export function thinkingLevels(provider, id) {
  const supported = getSupportedThinkingLevels(getModel(provider, id));
  return UI_THINKING_LEVELS.filter((level) => supported.includes(level));
}

export function modelInfo(provider, id) {
  const model = getModel(provider, id);
  return {
    id: model.id,
    name: model.name,
    images: model.input.includes('image'),
    reasoning: !!model.reasoning,
    thinkingLevels: thinkingLevels(provider, id),
    cost: model.cost,
    contextWindow: model.contextWindow,
    known: provider === 'gemini' || catalogOpenRouter.has(id) || listedOpenRouter.has(id)
  };
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
