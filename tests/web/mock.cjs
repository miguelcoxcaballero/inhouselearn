// Shared mock for Inhouse Learn tests: OpenRouter chat completions streamed
// slowly from window.__replies (one entry per HTTP request).
const fs = require('fs');
const SCRATCH = process.env.OUT || require('os').tmpdir();
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/index.html';

function initScript() {
  // Mock the app's provider only. Sandboxed visuals deliberately remove fetch;
  // Playwright also injects init scripts there, sometimes after their shim.
  if (window !== window.top) return;
  try {
    localStorage.setItem('inhouseGeminiStandaloneV1::openrouterSettings', JSON.stringify({ apiKey: 'sk-or-test', updatedAt: new Date().toISOString() }));
  } catch (_) {}
  const origFetch = window.fetch.bind(window);
  window.__replies = [];
  window.__requests = [];
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url.includes('openrouter.ai/api/v1/chat/completions')) {
      let raw = init && init.body;
      if (!raw && input && typeof input.text === 'function') raw = await input.clone().text();
      const body = JSON.parse(raw || '{}');
      // Small non-streaming requests (the chat's automatic name) answer on their own.
      if (body.stream === false && !body.plugins) {
        window.__titleRequests = (window.__titleRequests || []).concat([body]);
        const title = window.__titleReply || { title: 'Conversación de prueba', changed: true };
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(title) } }], usage: { prompt_tokens: 200, completion_tokens: 10, cost: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      window.__requests.push(body);
      const reply = window.__replies.shift() || { text: 'ok' };
      if (reply.status) return new Response(JSON.stringify({ error: { message: reply.error || 'Provider returned error', code: reply.status } }), { status: reply.status, headers: { 'content-type': 'application/json' } });
      const signal = (init && init.signal) || (input && input.signal);
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(ctrl) {
          const send = (obj) => ctrl.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));
          const base = { id: 'gen-' + Math.random().toString(36).slice(2), object: 'chat.completion.chunk', created: 1, model: body.model };
          const thinking = reply.reasoning || '';
          for (let r = 0; r < thinking.length; r += 12) {
            send(Object.assign({}, base, { choices: [{ index: 0, delta: { reasoning: thinking.slice(r, r + 12) }, finish_reason: null }] }));
            await new Promise((res) => setTimeout(res, 15));
          }
          const text = reply.text || '';
          let i = 0;
          while (i < text.length) {
            if (signal && signal.aborted) { ctrl.error(new DOMException('aborted', 'AbortError')); return; }
            // As when Android pauses the page: the connection dies mid-answer.
            if (reply.networkError && i >= Math.min(text.length - 1, reply.networkError === true ? 30 : reply.networkError)) { ctrl.error(new TypeError('network error')); return; }
            const n = reply.chunk || (3 + Math.floor(Math.random() * 14));
            send(Object.assign({}, base, { choices: [{ index: 0, delta: { content: text.slice(i, i + n) }, finish_reason: null }] }));
            i += n;
            await new Promise((r) => setTimeout(r, reply.delay != null ? reply.delay : 22 + Math.random() * 30));
          }
          for (const [index, tool] of (reply.tools || []).entries()) {
            const args = JSON.stringify(tool.args);
            // toolChunk: the arguments arrive little by little, as a model writes a long file.
            const step = reply.toolChunk || args.length || 1;
            for (let k = 0; k < Math.max(1, args.length); k += step) {
              const head = k === 0 ? { id: 'call_' + index + Math.random().toString(36).slice(2, 7), type: 'function' } : {};
              send(Object.assign({}, base, { choices: [{ index: 0, delta: { tool_calls: [Object.assign({ index }, head, { function: Object.assign(k === 0 ? { name: tool.name } : {}, { arguments: args.slice(k, k + step) }) })] }, finish_reason: null }] }));
              if (reply.toolChunk) await new Promise((r) => setTimeout(r, reply.delay != null ? reply.delay : 25));
            }
          }
          send(Object.assign({}, base, { choices: [{ index: 0, delta: {}, finish_reason: reply.tools && reply.tools.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
          ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
          ctrl.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return origFetch(input, init);
  };
}

async function openApp(browser, device, options) {
  const context = await browser.newContext(Object.assign({}, device));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|gsi|accounts\.google/i.test(m.text())) errors.push('console: ' + m.text()); });
  const models = (process.env.MODELS_JSON ? fs.readFileSync(process.env.MODELS_JSON, 'utf8') : JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: V4.1 Flash', supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } }] }));
  await page.route('https://openrouter.ai/api/v1/models**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: models }));
  await page.route('https://openrouter.ai/api/v1/key**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{"limit":null,"usage":1}}' }));
  await page.route('https://openrouter.ai/api/v1/credits**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.addInitScript(initScript);
  // options.init: a script of the test that must run before the page (e.g. a fake Android shell).
  if (options && options.init) await page.addInitScript(options.init);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.InhousePi && typeof runAssistantTurn === 'function');
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    if (typeof closeModelMenu === 'function') closeModelMenu();
    const chat = getActiveChat();
    chat.model = 'deepseek/deepseek-v4.1-flash';
    saveState({ skipDrive: true });
  });
  return { page, errors, context };
}

async function send(page, text) {
  await page.fill('#composer', text);
  await page.click('#send-btn');
}

async function idle(page, timeout) {
  await page.waitForFunction(() => !appState.busy, null, { timeout: timeout || 30000 });
  await page.waitForTimeout(200);
}

module.exports = { openApp, send, idle, SCRATCH, BASE };
