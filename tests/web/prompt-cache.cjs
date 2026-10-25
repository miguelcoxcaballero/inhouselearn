// The system prompt stays byte-identical across the turns of a chat (providers
// with prompt caching reuse it); what changes each turn (time, files, library,
// memory, visual reminders) travels in a <contexto_app> block at the end of the
// user's message and is never saved. Normal chats carry «Cómo trabajar»;
// Guided Learning does not.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 800 } });
  await page.evaluate(() => {
    window.__bodies = [];
    const orig = window.fetch;
    window.fetch = (input, init) => {
      try { const body = JSON.parse((init && init.body) || '{}'); if (Array.isArray(body.messages) && body.messages[0] && body.messages[0].role === 'system' && /Herramientas de este chat/.test(body.messages[0].content)) window.__bodies.push(body); } catch (_) {}
      return orig(input, init);
    };
    getActiveChat().approvalMode = 'auto';
  });

  // Three turns; a new chat file between them changes the per-turn context.
  await page.evaluate(() => window.__replies.push({ text: 'Primera.' }));
  await send(page, 'Hola');
  await idle(page);
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'write_file', args: { path: 'notas.md', content: '# Notas' } }] }, { text: 'Guardado.' }));
  await send(page, 'Guarda unas notas');
  await idle(page);
  await page.evaluate(() => window.__replies.push({ text: 'Tercera.' }));
  await send(page, 'Y ahora qué');
  await idle(page);
  const r = await page.evaluate(() => {
    const bodies = window.__bodies;
    const sys = bodies.map((body) => body.messages[0].content);
    const lastUser = (body) => body.messages.filter((m) => m.role === 'user').pop();
    const tail = (body) => { const content = lastUser(body).content; return Array.isArray(content) ? (content[content.length - 1].text || '') : String(content); };
    return {
      n: bodies.length,
      sameSystem: sys.length >= 3 && sys.every((text) => text === sys[0]),
      method: /Cómo trabajar/.test(sys[0]),
      noVolatile: !/Ahora: /.test(sys[0]) && !/notas\.md/.test(sys[0]),
      tails: bodies.map((body) => tail(body).slice(0, 40)),
      lastTail: tail(bodies[bodies.length - 1]),
      saved: JSON.stringify(getActiveChat().messages).includes('<contexto_app>')
    };
  });
  check('the system prompt is byte-identical across the turns of a chat', r.sameSystem, { n: r.n });
  check('…and holds the work method, but no time or files (they change)', r.method && r.noVolatile);
  check('each turn ends with a <contexto_app> block with the time and the files of that turn', r.tails.every((t) => t.startsWith('<contexto_app>')) && /Ahora: /.test(r.lastTail) && /notas\.md/.test(r.lastTail), r.tails);
  check('the per-turn block is never saved in the chat', !r.saved);

  // A GitHub chat: what gets prepared between turns goes in the per-turn block,
  // the system prompt stays the same.
  const gh = await page.evaluate(async () => {
    window.githubToken = () => 'github_pat_test';
    window.githubLogin = () => 'tester';
    newChat();
    const chat = getActiveChat();
    chat.github = true;
    const first = stableSystemPrompt(chat);
    githubStageStore(chat).put({ repo: 'tester/demo', branch: 'main', files: { 'x.js': 'y' }, deletes: [], notes: [] });
    chat.githubRepo = 'tester/demo';
    const second = stableSystemPrompt(chat);
    return { same: first === second, github: /GitHub \(cuenta @tester\)/.test(first), tail: /preparados sin subir: tester\/demo@main \(x\.js\)/.test(turnContextText(chat, null)), agents: subAgentSystemPrompt(chat) === subAgentSystemPrompt(chat) };
  });
  check('a GitHub chat keeps its system prompt when changes are prepared (they go in the per-turn block)', gh.same && gh.github && gh.tail, gh);

  // Guided Learning: its own method, not «Cómo trabajar».
  await page.evaluate(() => { newChat(); getActiveChat().guidedLearning = true; window.__bodies = []; window.__replies.push({ text: '¿Qué quieres aprender?' }); });
  await send(page, 'Quiero aprender');
  await idle(page);
  const guided = await page.evaluate(() => { const b = window.__bodies[0]; return b ? /Cómo trabajar/.test(b.messages[0].content) : null; });
  check('Guided Learning does not get «Cómo trabajar»', guided === false, guided);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
