// API de pi para la API de Gemini (generativelanguage), la misma que usa el
// proveedor "google" de pi. Se llama con fetch en vez de con @google/genai para
// poder autenticar tanto con el token OAuth del login de Google como con una API
// key de AI Studio (eso lo resuelve la app en hooks().fetch). Reutiliza los
// conversores de mensajes y herramientas de pi, así que los turnos con
// herramientas y las firmas de razonamiento funcionan igual que en pi.
import {
  AssistantMessageEventStream,
  calculateCost,
  clampThinkingLevel,
  collapseSystemMessages,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText
} from '@earendil-works/pi-ai';
import {
  convertMessages,
  convertTools,
  getDisabledGoogleThinkingConfig,
  isThinkingPart,
  mapStopReasonString,
  resolveGoogleFunctionCallingMode,
  resolveGoogleThinkingLevel,
  retainThoughtSignature,
  supportsGoogleStrictToolSampling,
  toGoogleThinkingLevel,
  usesGoogleThinkingLevel
} from '@earendil-works/pi-ai/api/google-shared';

// Presupuestos de Gemini 2.5, los mismos que usa pi para la API de Google.
const THINKING_BUDGETS = {
  pro: { minimal: 128, low: 2048, medium: 8192, high: 32768 },
  'flash-lite': { minimal: 512, low: 2048, medium: 8192, high: 24576 },
  flash: { minimal: 128, low: 2048, medium: 8192, high: 24576 }
};

let toolCallCounter = 0;

function thinkingBudget(modelId, level) {
  const family = modelId.includes('pro') ? 'pro' : modelId.includes('flash-lite') ? 'flash-lite' : 'flash';
  return THINKING_BUDGETS[family][level] ?? -1;
}

function thinkingConfigFor(model, reasoning) {
  if (!model.reasoning) return undefined;
  const level = reasoning ? clampThinkingLevel(model, reasoning) : 'off';
  if (level === 'off') return getDisabledGoogleThinkingConfig(model);
  const resolved = resolveGoogleThinkingLevel(model, level);
  return usesGoogleThinkingLevel(model)
    ? { includeThoughts: true, thinkingLevel: toGoogleThinkingLevel(resolved) }
    : { includeThoughts: true, thinkingBudget: thinkingBudget(model.id, resolved) };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function buildRequest(model, context, options) {
  const initialSystemMessage = getInitialSystemMessage(context.messages);
  const systemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : '';
  const tools = getCurrentTools(context.messages);
  const strict = supportsGoogleStrictToolSampling(model.id);
  const mode = tools.length ? resolveGoogleFunctionCallingMode(tools, options.toolChoice, strict) : undefined;
  const generationConfig = { maxOutputTokens: options.maxTokens ?? model.maxTokens };
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.thinkingConfig) generationConfig.thinkingConfig = options.thinkingConfig;
  return {
    contents: convertMessages(model, context),
    ...(systemText && { systemInstruction: { parts: [{ text: systemText }] } }),
    ...(tools.length && { tools: convertTools(tools, false, strict) }),
    ...(mode !== undefined && { toolConfig: { functionCallingConfig: { mode } } }),
    generationConfig
  };
}

// hooks(): { fetch(modelId, body, signal) -> Response, describeError(status, payload, modelId) }
export function geminiApi(hooks) {
  const stream = (model, rawContext, options = {}) => {
    const out = new AssistantMessageEventStream();
    const context = collapseSystemMessages(rawContext);
    const output = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: 'pending',
      timestamp: Date.now()
    };
    (async () => {
      const api = hooks();
      try {
        const body = buildRequest(model, context, options);
        const response = await api.fetch(model.id, body, options.signal);
        if (!response.ok || !response.body) {
          const payload = await response.json().catch(() => null);
          throw new Error(api.describeError(response.status, payload, model.id));
        }
        out.push({ type: 'start', partial: output });

        const blocks = output.content;
        const index = () => blocks.length - 1;
        let current = null;
        const closeCurrent = () => {
          if (!current) return;
          if (current.type === 'text') {
            out.push({ type: 'text_end', contentIndex: index(), content: current.text, partial: output });
          } else {
            out.push({ type: 'thinking_end', contentIndex: index(), content: current.thinking, partial: output });
          }
          current = null;
        };

        const handleChunk = (payload) => {
          if (payload.error) {
            throw new Error(api.describeError(Number(payload.error.code) || 500, payload, model.id));
          }
          const chunk = payload;
          output.responseId ||= chunk.responseId;
          const candidate = chunk.candidates && chunk.candidates[0];
          for (const part of (candidate && candidate.content && candidate.content.parts) || []) {
            if (part.text !== undefined) {
              const thinking = isThinkingPart(part);
              if (!current || (thinking ? current.type !== 'thinking' : current.type !== 'text')) {
                closeCurrent();
                current = thinking ? { type: 'thinking', thinking: '', thinkingSignature: undefined } : { type: 'text', text: '' };
                blocks.push(current);
                out.push({ type: thinking ? 'thinking_start' : 'text_start', contentIndex: index(), partial: output });
              }
              if (current.type === 'thinking') {
                current.thinking += part.text;
                current.thinkingSignature = retainThoughtSignature(current.thinkingSignature, part.thoughtSignature);
                out.push({ type: 'thinking_delta', contentIndex: index(), delta: part.text, partial: output });
              } else {
                current.text += part.text;
                current.textSignature = retainThoughtSignature(current.textSignature, part.thoughtSignature);
                out.push({ type: 'text_delta', contentIndex: index(), delta: part.text, partial: output });
              }
            }
            if (part.functionCall) {
              closeCurrent();
              const providedId = part.functionCall.id;
              const duplicate = blocks.some((block) => block.type === 'toolCall' && block.id === providedId);
              const toolCall = {
                type: 'toolCall',
                id: !providedId || duplicate ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : providedId,
                name: part.functionCall.name || '',
                arguments: part.functionCall.args ?? {},
                ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature })
              };
              blocks.push(toolCall);
              out.push({ type: 'toolcall_start', contentIndex: index(), partial: output });
              out.push({ type: 'toolcall_delta', contentIndex: index(), delta: JSON.stringify(toolCall.arguments), partial: output });
              out.push({ type: 'toolcall_end', contentIndex: index(), toolCall, partial: output });
            }
          }
          if (candidate && candidate.finishReason) {
            output.rawStopReason = candidate.finishReason;
            output.stopReason = mapStopReasonString(candidate.finishReason);
            if (output.stopReason === 'stop' && blocks.some((block) => block.type === 'toolCall')) {
              output.stopReason = 'toolUse';
            }
          }
          const meta = chunk.usageMetadata;
          if (meta) {
            output.usage = {
              input: (meta.promptTokenCount || 0) - (meta.cachedContentTokenCount || 0),
              output: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0),
              cacheRead: meta.cachedContentTokenCount || 0,
              cacheWrite: 0,
              reasoning: meta.thoughtsTokenCount || 0,
              totalTokens: meta.totalTokenCount || 0,
              cost: emptyUsage().cost
            };
            calculateCost(model, output.usage);
          }
        };

        // SSE: líneas "data:" que forman un evento hasta la siguiente línea en blanco.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let dataLines = [];
        const flushEvent = () => {
          if (!dataLines.length) return;
          const raw = dataLines.join('\n');
          dataLines = [];
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch (_) {
            return;
          }
          handleChunk(payload);
        };
        const handleLine = (line) => {
          if (line === '') flushEvent();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            handleLine(buffer.slice(0, newline).replace(/\r$/, ''));
            buffer = buffer.slice(newline + 1);
          }
        }
        buffer += decoder.decode();
        if (buffer) handleLine(buffer.replace(/\r$/, ''));
        flushEvent();
        closeCurrent();

        if (options.signal && options.signal.aborted) throw new Error('Request was aborted');
        if (output.stopReason === 'pending') throw new Error('Gemini ha cortado la respuesta sin terminarla.');
        if (output.stopReason === 'error') {
          throw new Error('Gemini ha bloqueado la respuesta (' + (output.rawStopReason || 'error') + '). Reformula la pregunta o prueba otro modelo.');
        }
        out.push({ type: 'done', reason: output.stopReason, message: output });
        out.end();
      } catch (error) {
        output.stopReason = options.signal && options.signal.aborted ? 'aborted' : 'error';
        output.errorMessage = error instanceof Error ? error.message : String(error);
        out.push({ type: 'error', reason: output.stopReason, error: output });
        out.end();
      }
    })();
    return out;
  };

  return {
    stream,
    streamSimple: (model, context, options = {}) => stream(model, context, {
      ...options,
      thinkingConfig: thinkingConfigFor(model, options.reasoning)
    })
  };
}
