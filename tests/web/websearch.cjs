// Internet in the chat: web_search goes to OpenRouter with its web plugin
// (the user's key, the chat's model) and comes back with the pages as
// url_citation annotations; web_fetch reads a page through r.jina.ai. While it
// searches the thread shows a turning globe, «Buscando en internet» and the
// query; afterwards a «Fuentes» row under the answer lists the pages (the cited
// ones first); the search's own cost counts in the answer's cost; the model is
// told it can search and must cite. Trailing zeros of the cost are grey.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { SCRATCH } = require('./mock.cjs');
const models = path.join(SCRATCH, 'models-priced-web.json');
fs.writeFileSync(models, JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: V4.1 Flash', supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000003', completion: '0.000004' } }] }));
process.env.MODELS_JSON = models;
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 900 } });
  await page.route('https://www.google.com/s2/favicons**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }));
  await page.evaluate(() => {
    window.__searches = [];
    window.__pages = [];
    const inner = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      if (url.includes('openrouter.ai/api/v1/chat/completions') && body && body.plugins) {
        window.__searches.push({ body, auth: init.headers.Authorization });
        await new Promise((r) => setTimeout(r, 1200));
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Reddit users praise its reasoning but complain about rate limits.', annotations: [
            { type: 'url_citation', url_citation: { url: 'https://www.reddit.com/r/LocalLLaMA/comments/abc/nemotron_3_ultra/', title: 'Nemotron 3 Ultra is great at reasoning', content: 'Tried it on OpenRouter: strong reasoning, slow at peak times.' } },
            { type: 'url_citation', url_citation: { url: 'https://www.reddit.com/r/OpenRouter/comments/def/free_tier_limits/', title: 'Free tier limits on Nemotron', content: 'The free endpoint hits 20 requests per minute quickly.' } },
            { type: 'url_citation', url_citation: { url: 'https://news.example.com/nemotron', title: 'NVIDIA ships Nemotron 3 Ultra', content: 'Launch coverage.' } }
          ] } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.0074 }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://r.jina.ai/')) {
        window.__pages.push(url);
        return new Response(JSON.stringify({ data: { title: 'Nemotron 3 Ultra is great at reasoning', url: url.slice(18), content: '# Nemotron 3 Ultra\n\nOP: It beats everything I tried on math. Top comment: free tier is rate-limited.' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return inner(input, init);
    };
  });

  const prompt = await page.evaluate(() => webPromptText());
  check('the model is told it can search and read pages, and must cite', /web_search/.test(prompt) && /web_fetch/.test(prompt) && /Nunca digas que no puedes navegar/.test(prompt));

  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'web_search', args: { query: 'Nemotron 3 Ultra site:reddit.com' } }] },
    { text: '', tools: [{ name: 'web_fetch', args: { url: 'https://www.reddit.com/r/LocalLLaMA/comments/abc/nemotron_3_ultra/' } }] },
    { text: 'En Reddit dicen que razona muy bien ([r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/abc/nemotron_3_ultra/)) pero que el nivel gratis tiene límites ([r/OpenRouter](https://www.reddit.com/r/OpenRouter/comments/def/free_tier_limits/)).' }));
  await send(page, 'Busca en Reddit qué dice la gente de Nemotron 3 Ultra');
  const during = await page.waitForSelector('.live-now.web .live-globe', { timeout: 15000 }).then(() => page.evaluate(() => document.querySelector('.live-now.web').innerText), () => '');
  check('while it searches, the thread shows a globe, «Buscando en internet» and the query', /Buscando en internet/.test(during) && /Nemotron 3 Ultra site:reddit\.com/.test(during), during);
  await idle(page, 30000);
  await page.waitForTimeout(1500);

  const search = await page.evaluate(() => window.__searches[0]);
  check('the search goes to OpenRouter with the web plugin, the user\'s key and the chat\'s model', search && search.body.plugins[0].id === 'web' && search.body.model === 'deepseek/deepseek-v4.1-flash' && search.auth === 'Bearer sk-or-test' && search.body.messages[1].content === 'Nemotron 3 Ultra site:reddit.com', search && search.body);
  const tools = await page.evaluate(() => window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool').map((m) => String(m.content)));
  check('web_search gives the model titles, URLs and excerpts', /\[1\] Nemotron 3 Ultra is great at reasoning\nhttps:\/\/www\.reddit\.com\/r\/LocalLLaMA/.test(tools[0]) && /20 requests per minute/.test(tools[0]), tools[0]);
  check('web_fetch reads the page through the reader', /beats everything I tried on math/.test(tools[1]) && await page.evaluate(() => window.__pages[0] === 'https://r.jina.ai/https://www.reddit.com/r/LocalLLaMA/comments/abc/nemotron_3_ultra/'), tools[1]);

  const sources = await page.evaluate(() => {
    const el = document.querySelector('#thread .message:last-child .msg-sources');
    if (!el) return null;
    return { summary: el.querySelector('summary').innerText.replace(/\s+/g, ' ').trim(), items: Array.from(el.querySelectorAll('li')).map((li) => ({ text: li.textContent.replace(/\s+/g, ' '), cited: li.classList.contains('cited'), href: li.querySelector('a').href, blank: li.querySelector('a').target })), faces: el.querySelectorAll('summary .msg-source-icon').length };
  });
  check('under the answer: «Fuentes» with the site icons and how many', sources && /Fuentes 3/.test(sources.summary) && sources.faces === 3, sources);
  check('…the cited pages first, each a link that opens apart', sources && sources.items[0].cited && sources.items[1].cited && !sources.items[2].cited && /news\.example\.com/.test(sources.items[2].text) && sources.items.every((i) => i.blank === '_blank'), sources && sources.items);

  const cost = await page.evaluate(() => { const m = getActiveChat().messages.slice(-1)[0]; const el = document.querySelector('#thread .message:last-child .msg-cost'); return { stored: m.cost, text: el.textContent }; });
  // 3 model requests (0.0005 each) + the search (0.0074).
  check('the search\'s own cost counts in the answer\'s cost', Math.abs(cost.stored - 0.0089) < 1e-9, cost);

  // Grey trailing zeros: $0.0500 → "$0.05" + grey "00".
  const zeros = await page.evaluate(() => [costCounterHtml(0.05), costCounterHtml(0.0089), costCounterHtml(0.001), costCounterHtml(0)]);
  check('the last two decimals, when zeros, are grey', zeros[0] === '$0.05<span class="msg-cost-zeros">00</span>' && zeros[1] === '$0.0089' && zeros[2] === '$0.00<span class="msg-cost-zeros">10</span>'.replace('<span class="msg-cost-zeros">10</span>', '1<span class="msg-cost-zeros">0</span>') && zeros[3] === '$0.00<span class="msg-cost-zeros">00</span>', zeros);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
