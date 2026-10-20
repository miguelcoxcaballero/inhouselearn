// Saca del catálogo de pi-ai solo los modelos que usa la app, para no meter
// en el bundle los ~300 KB de catálogo de OpenRouter.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../node_modules/@earendil-works/pi-ai/dist/providers/data/', import.meta.url));
const outFile = fileURLToPath(new URL('../src/catalog.json', import.meta.url));

const OPENROUTER_IDS = [
  'deepseek/deepseek-v4.1-flash-1017',
  'z-ai/glm-5.3-flashx',
  'z-ai/glm-5.3-prime',
  'minimax/minimax-m3.1-flash:free',
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-opus-5.5',
  'openai/gpt-6-luna',
  'openai/gpt-6-sol',
  'moonshotai/kimi-k2.7-code'
];

const chatEntries = (file) => {
  const data = JSON.parse(readFileSync(dataDir + file, 'utf8'));
  return Object.values(data).flatMap((entries) => Object.values(entries)).filter((model) => (model.type || 'chat') === 'chat');
};

// OpenRouter no acepta las cabeceras anthropic-* en CORS, así que desde el
// navegador Claude va por chat completions como el resto.
const toCompletions = (model) => model.api === 'openai-completions' ? model : {
  ...model,
  api: 'openai-completions',
  baseUrl: 'https://openrouter.ai/api/v1',
  compat: { thinkingFormat: 'openrouter', supportsDeveloperRole: true, sendSessionAffinityHeaders: true }
};

const openrouter = chatEntries('openrouter.json')
  .filter((model) => OPENROUTER_IDS.includes(model.id))
  .map(toCompletions);

const gemini = chatEntries('google.json')
  .filter((model) => /^gemini-(2\.5|3)/.test(model.id) && !/image|live|computer-use|customtools/.test(model.id))
  .map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens
  }));

writeFileSync(outFile, JSON.stringify({ openrouter, gemini }, null, 1) + '\n');
const missing = OPENROUTER_IDS.filter((id) => !openrouter.some((model) => model.id === id));
console.log(`catalog.json: ${openrouter.length} de OpenRouter, ${gemini.length} de Gemini. Sin catálogo (se piden a OpenRouter al usarlos): ${missing.join(', ') || 'ninguno'}`);
