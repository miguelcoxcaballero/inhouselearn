// Claude with the user's own Anthropic API key (the monthly API credit of a
// Claude plan): the key field in the model picker, Claude's models first in the
// list, answers and tool calls straight from api.anthropic.com (mocked here),
// the cost from Anthropic's prices, Anthropic's own web search, a rejected key,
// and removing the key.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

const sse = (events) => events.map((event) => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
const start = (usage) => ({ type: 'message_start', message: { id: 'msg_' + Math.random().toString(36).slice(2), type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: Object.assign({ input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, usage || {}) } });
function textReply(text, usage) {
  return sse([
    start(usage),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...text.match(/.{1,6}/gs).map((part) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } },
    { type: 'message_stop' }
  ]);
}
function toolReply(name, input) {
  return sse([
    start(),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + Math.random().toString(36).slice(2), name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 80 } },
    { type: 'message_stop' }
  ]);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors, context } = await openApp(browser, { viewport: { width: 1000, height: 800 } });
  const seen = [];
  const replies = [];
  let keyStatus = 200;
  await context.route('https://api.anthropic.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const cors = { 'access-control-allow-origin': '*' };
    if (request.url().includes('/v1/models')) {
      seen.push({ url: request.url(), headers: request.headers() });
      return route.fulfill({ status: keyStatus, headers: cors, contentType: 'application/json', body: keyStatus === 200 ? '{"data":[{"id":"claude-opus-5-5"}]}' : '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' });
    }
    const body = JSON.parse(request.postData() || '{}');
    seen.push({ url: request.url(), headers: request.headers(), body });
    if (Array.isArray(body.tools) && body.tools.some((tool) => /^web_search_/.test(tool.type || ''))) {
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({
        id: 'msg_s', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'fotosíntesis' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://es.wikipedia.org/wiki/Fotos%C3%ADntesis', title: 'Fotosíntesis - Wikipedia', encrypted_content: 'x' }, { type: 'web_search_result', url: 'https://www.khanacademy.org/fotosintesis', title: 'Khan Academy', encrypted_content: 'y' }] },
          { type: 'text', text: 'La fotosíntesis convierte luz en energía química.', citations: [{ type: 'web_search_result_location', url: 'https://www.khanacademy.org/fotosintesis', title: 'Khan Academy', cited_text: 'convierte la energía de la luz', encrypted_index: 'z' }] }
        ],
        usage: { input_tokens: 3000, output_tokens: 100, server_tool_use: { web_search_requests: 1 } }
      }) });
    }
    // The chat's automatic name is a small request of its own.
    if (JSON.stringify(body.system || '').includes('You name chat')) return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'text/event-stream' }, cors), body: textReply('{"title": "Saludo con Claude", "changed": true}', { input_tokens: 300 }) });
    const next = replies.shift() || textReply('ok');
    return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'text/event-stream' }, cors), body: next });
  });

  // 1. The key field: saved, checked with GET /v1/models, Claude's models first.
  await page.evaluate(() => { toggleModelMenu(); });
  await page.waitForSelector('#claude-key-input', { state: 'visible' });
  await page.fill('#claude-key-input', 'sk-ant-api03-test');
  await page.click('#claude-key-btn');
  await page.waitForFunction(() => appState.claudeKeyCheck === 'ok');
  const listed = await page.evaluate(() => ({
    first: modelCatalog.entries.slice(0, 4).map((entry) => entry.id),
    chatModel: getActiveChat().model,
    level: getActiveChat().thinkingLevel,
    company: companyIdOf(getActiveChat().model),
    label: modelLabelFor(getActiveChat().model),
    stored: JSON.parse(localStorage.getItem(STORAGE_KEY + '::openrouterSettings')).anthropicKey,
    synced: buildSyncedSettings().openRouter.anthropicKey,
    state: document.getElementById('claude-key-state').textContent
  }));
  const check1 = seen.find((entry) => entry.url.includes('/v1/models'));
  check('saving the key checks it with Anthropic (free GET /v1/models, the key in x-api-key)', !!check1 && check1.headers['x-api-key'] === 'sk-ant-api03-test' && check1.headers['anthropic-dangerous-direct-browser-access'] === 'true', check1 && check1.headers);
  check('Claude\'s current models go first and the empty chat moves to Opus 5.5 at high effort', listed.first[0] === 'claude-api/claude-opus-5-5' && listed.first.includes('claude-api/claude-sonnet-5-5') && listed.chatModel === 'claude-api/claude-opus-5-5' && listed.level === 'high' && listed.company === 'anthropic' && listed.label === 'Opus 5.5', listed);
  check('the key is kept in this browser and travels with the Drive settings like OpenRouter\'s', listed.stored === 'sk-ant-api03-test' && listed.synced === 'sk-ant-api03-test' && /conectada/.test(listed.state), listed);

  // 2. A turn: streamed from api.anthropic.com with the bare model id, adaptive thinking and caching.
  await page.evaluate(() => { closeModelMenu(); getActiveChat().approvalMode = 'auto'; });
  replies.push(textReply('Hola, soy Claude con tu propia API.', { cache_read_input_tokens: 4000 }));
  await send(page, 'Hola Claude');
  await idle(page);
  const turn = await page.evaluate(() => {
    const last = getActiveChat().messages.filter((m) => m.role === 'assistant').pop();
    return { text: last.content, cost: last.cost, error: last.error || '', model: last.model || '' };
  });
  const turns = () => seen.filter((entry) => entry.body && entry.body.messages && !JSON.stringify(entry.body.system || '').includes('You name chat') && !(entry.body.tools || []).some((t) => /^web_search_/.test(t.type || '')));
  const request = turns().pop();
  const body = request && request.body;
  check('the answer comes from Claude through Anthropic\'s API', /soy Claude con tu propia API/.test(turn.text) && !turn.error, turn);
  check('…with the bare model id, streaming, adaptive thinking and the effort chosen', body && body.model === 'claude-opus-5-5' && body.stream === true && body.thinking && body.thinking.type === 'adaptive' && JSON.stringify(body).includes('"high"'), body && { model: body.model, thinking: body.thinking, output_config: body.output_config });
  check('…with prompt caching on the stable prefix (cache_control) and the app\'s tools', JSON.stringify(body || {}).includes('cache_control') && Array.isArray(body.tools) && body.tools.some((tool) => tool.name === 'write_file'), body && (body.tools || []).length);
  check('…and the key goes straight to Anthropic, never to OpenRouter', request && request.headers['x-api-key'] === 'sk-ant-api03-test' && request.url.startsWith('https://api.anthropic.com/v1/messages'));
  // Opus 5.5: $4 in / $20 out / $0.20 cache read per million → 1000·4 + 4000·0.2 + 200·20 = 0.0088.
  const titled = await page.evaluate(() => getActiveChat().autoTitle || getActiveChat().title);
  // The name (300 in, 200 out on Opus 5.5 = 0.0052) belongs to the conversation: added to the answer.
  check('the answer\'s cost uses Anthropic\'s prices (cache reads included), and Claude names the chat', Math.abs(turn.cost - 0.0088 - 0.0052) < 0.0005 && titled === 'Saludo con claude', { cost: turn.cost, titled });

  // 3. Tools: Claude calls write_file, the app runs it and Claude answers.
  replies.push(toolReply('write_file', { path: 'claude.md', content: '# Hecho con Claude' }), textReply('Guardado en claude.md.'));
  await send(page, 'Guarda una nota');
  await idle(page);
  const tool = await page.evaluate(() => ({ file: (chatWorkspace(getActiveChat()).files || {})['claude.md'] || (typeof chatWorkspace(getActiveChat()).read === 'function' ? chatWorkspace(getActiveChat()).read('claude.md') : null), text: getActiveChat().messages.filter((m) => m.role === 'assistant').pop().content }));
  const resultSent = turns().pop();
  const toolResult = resultSent && JSON.stringify(resultSent.body.messages).includes('tool_result');
  check('a tool call runs in the app and its result goes back to Claude', /Guardado/.test(tool.text) && toolResult, { text: tool.text, toolResult });

  // 4. web_search in a Claude chat: Anthropic's server-side search, its cost in the answer.
  const search = await page.evaluate(async () => {
    const found = await webSearchRequest(getActiveChat(), 'fotosíntesis', {});
    return found;
  });
  const searchBody = seen.filter((entry) => entry.body && Array.isArray(entry.body.tools) && entry.body.tools.some((t) => /^web_search_/.test(t.type || ''))).pop();
  check('web search in a Claude chat uses Anthropic\'s web_search tool (cited results first)', search.results.length === 2 && search.results[0].url.includes('khanacademy') && /luz/.test(search.results[0].snippet) && /convierte luz/.test(search.digest) && searchBody.body.tools[0].type === 'web_search_20260209', { search, tool: searchBody && searchBody.body.tools });

  // 5. Error wording from Anthropic.
  const wording = await page.evaluate(() => [
    describeAgentError('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
    describeAgentError('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}')
  ]);
  check('Anthropic\'s errors read in plain Spanish (bad key, no credit)', /rechaza la API key de Claude/.test(wording[0]) && /crédito en la API de Claude/.test(wording[1]), wording);

  // 6. A rejected key says so next to the field.
  keyStatus = 401;
  await page.evaluate(() => { toggleModelMenu(); });
  await page.fill('#claude-key-input', 'sk-ant-api03-mala');
  await page.click('#claude-key-btn');
  await page.waitForFunction(() => appState.claudeKeyCheck === 'rejected');
  const rejected = await page.evaluate(() => ({ text: document.getElementById('claude-key-state').textContent, error: document.getElementById('claude-key-state').classList.contains('error') }));
  check('a key Anthropic rejects is marked next to the field', /rechaza/.test(rejected.text) && rejected.error, rejected);

  // 7. Removing the key: Claude's models leave the list and an empty chat goes back to OpenRouter.
  await page.fill('#claude-key-input', '');
  await page.click('#claude-key-btn');
  const removed = await page.evaluate(() => { newChat(); return { claude: modelCatalog.entries.some((entry) => entry.id.startsWith('claude-api/')), model: getActiveChat().model }; });
  check('removing the key removes Claude\'s models; a new chat uses OpenRouter again', !removed.claude && !removed.model.startsWith('claude-api/'), removed);

  // 8. Without an OpenRouter key, a Claude key alone is enough to chat.
  const alone = await page.evaluate(() => {
    saveApiSettings({ apiKey: '', anthropicKey: 'sk-ant-api03-test' });
    applyClaudeModels();
    const chat = getActiveChat();
    chat.model = 'claude-api/claude-sonnet-5-5';
    return { ready: hasKeyFor(chat), other: hasKeyFor({ model: 'openai/gpt-5' }) };
  });
  check('a Claude key alone is enough for a Claude chat (not for OpenRouter\'s models)', alone.ready === true && alone.other === false, alone);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
