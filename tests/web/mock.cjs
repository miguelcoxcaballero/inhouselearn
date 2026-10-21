// Shared mock for Inhouse Learn tests: OpenRouter chat completions streamed
// slowly from window.__replies (one entry per HTTP request).
const fs = require('fs');
const SCRATCH = process.env.OUT || require('os').tmpdir();
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765/index.html';

function initScript() {
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
            const n = reply.chunk || (3 + Math.floor(Math.random() * 14));
            send(Object.assign({}, base, { choices: [{ index: 0, delta: { content: text.slice(i, i + n) }, finish_reason: null }] }));
            i += n;
            await new Promise((r) => setTimeout(r, reply.delay != null ? reply.delay : 22 + Math.random() * 30));
          }
          (reply.tools || []).forEach((tool, index) => {
            send(Object.assign({}, base, { choices: [{ index: 0, delta: { tool_calls: [{ index, id: 'call_' + index + Math.random().toString(36).slice(2, 7), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, finish_reason: null }] }));
          });
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
