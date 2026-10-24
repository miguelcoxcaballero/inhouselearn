// Two things around each answer:
// 1. What it cost: "$X.XXXX" in green next to the model, per version (a
//    regenerated answer keeps each version's own cost), dark-mode green too.
// 2. Another Google account linked for a question (+ menu → Otra cuenta de
//    Google): a pill in the composer with its email that stays across messages
//    until it is removed; the model reads that account's Gmail and Drive
//    (shared drives included) with extra_* tools, read-only; removing the pill
//    revokes the token at Google and the tools go away.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { SCRATCH } = require('./mock.cjs');
// Paid prices, so the cost is not 0: 100 prompt + 50 completion tokens per request.
const models = path.join(SCRATCH, 'models-priced.json');
fs.writeFileSync(models, JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: V4.1 Flash', supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000003', completion: '0.000004' } }] }));
process.env.MODELS_JSON = models;
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

const revoked = [];
let gmailDisabled = 0; // how many more Gmail calls answer SERVICE_DISABLED (just turned on in Google Cloud)
const disabled = (route) => route.fulfill({ status: 403, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { code: 403, message: 'Gmail API has not been used in project 435784295430 before or it is disabled.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } }) });
const seenTokens = new Set();
const b64url = (text) => Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function google(route) {
  const req = route.request();
  const url = new URL(req.url());
  const json = (obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') { revoked.push(url.searchParams.get('token')); return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' }); }
  if (url.pathname === '/oauth2/v3/userinfo') return json({ email: req.headers().authorization === 'Bearer extra-token' ? 'club@example.org' : 'me@example.com' });
  if (url.hostname === 'gmail.googleapis.com' || url.pathname.startsWith('/drive/v3/') && req.headers().authorization === 'Bearer extra-token') seenTokens.add(req.headers().authorization);
  if (url.hostname === 'gmail.googleapis.com') {
    if (req.headers().authorization !== 'Bearer extra-token') return json({ error: { message: 'wrong account' } }, 401);
    if (gmailDisabled > 0) { gmailDisabled--; return disabled(route); }
    if (url.pathname.endsWith('/profile')) return json({ emailAddress: 'club@example.org' });
    if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'm1' }] });
    if (url.pathname.endsWith('/messages/m1') && url.searchParams.get('format') === 'metadata') return json({ id: 'm1', snippet: 'El presupuesto aprobado es 420 €', payload: { headers: [{ name: 'From', value: 'Tesorería <tesoreria@example.org>' }, { name: 'Subject', value: 'Presupuesto del taller' }, { name: 'Date', value: 'Tue, 3 Feb 2026 10:00:00 +0100' }] } });
    if (url.pathname.endsWith('/messages/m1')) return json({ id: 'm1', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Tesorería <tesoreria@example.org>' }, { name: 'To', value: 'club@example.org' }, { name: 'Subject', value: 'Presupuesto del taller' }, { name: 'Date', value: 'Tue, 3 Feb 2026 10:00:00 +0100' }], parts: [{ mimeType: 'text/plain', body: { data: b64url('Hola,\nel presupuesto aprobado para el taller es de 420 €.\nUn saludo') } }, { filename: 'factura.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 20480 } }] } });
  }
  if (url.pathname === '/drive/v3/drives') return json({ drives: [{ id: 'sd1', name: 'Club Aeroespacial' }] });
  return json({ files: [] });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  await page.route(/googleapis\.com/, google);
  await page.evaluate(() => { appState.profile = { email: 'me@example.com' }; });

  // 1. Cost of each answer.
  await page.evaluate(() => window.__replies.push({ text: 'Primera respuesta.' }));
  await send(page, 'Hola');
  await idle(page);
  const first = await page.evaluate(() => {
    const el = document.querySelector('#thread .message:last-child .msg-cost');
    return { text: el ? el.textContent : '', color: el ? getComputedStyle(el).color : '', stored: getActiveChat().messages.slice(-1)[0].cost };
  });
  check('each answer shows its cost as $X.XXXX in green next to the model', first.text === '$0.0005' && first.color === 'rgb(21, 128, 61)' && Math.abs(first.stored - 0.0005) < 1e-9, first);
  // A tool turn is two requests: both count.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'list_files', args: {} }] }, { text: 'Hecho.' }));
  await send(page, 'Mira mis archivos');
  await idle(page);
  const settle = () => page.waitForFunction(() => { const el = document.querySelector('#thread .message:last-child .msg-cost'); return el && !el.classList.contains('ticking'); }, null, { timeout: 10000 });
  await settle();
  const twoCalls = await page.evaluate(() => document.querySelector('#thread .message:last-child .msg-cost').textContent);
  check('a turn with a tool call adds up every request', twoCalls === '$0.0010', twoCalls);
  // Regenerate: the new version has its own cost and the old one keeps its own.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'list_files', args: {} }] }, { text: '', tools: [{ name: 'list_files', args: {} }] }, { text: 'Otra versión.' }));
  await page.evaluate(() => regenerateMessage(getActiveChat().messages.slice(-1)[0].id));
  await idle(page);
  await settle();
  const versions = await page.evaluate(() => { const m = getActiveChat().messages.slice(-1)[0]; return { now: (document.querySelector('#thread .message:last-child .msg-cost') || {}).textContent, old: m.alternatives.map((a) => a.cost), content: m.content }; });
  check('«Regenerar» works again, the new version has its own cost and the old one keeps its own', versions.now === '$0.0015' && Math.abs(versions.old[0] - 0.001) < 1e-9 && versions.content === 'Otra versión.', versions);
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
  await page.waitForTimeout(400);
  const dark = await page.evaluate(() => getComputedStyle(document.querySelector('#thread .message:last-child .msg-cost')).color);
  check('in dark mode the cost is a light green', dark === 'rgb(52, 211, 153)', dark);
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); });

  // Model, logo and price stay under the answer while it is written, and the
  // price counts up live (animated) before the request ends.
  await page.evaluate(() => window.__replies.push({ text: Array.from({ length: 70 }, (_, i) => 'La idea número ' + i + ' se explica con un ejemplo distinto' + (i % 7 === 0 ? '.\n\n' : ', ')).join(''), chunk: 30, delay: 25 }));
  await send(page, 'Escribe algo largo');
  await page.waitForFunction(() => { const m = getActiveChat().messages.slice(-1)[0]; return m.pending && m.content.length > 600; });
  const live1 = await page.evaluate(() => { const el = document.querySelector('#thread .message:last-child .msg-attribution'); const cost = el && el.querySelector('.msg-cost'); return { shown: !!el && getComputedStyle(el).opacity, model: el ? el.innerText : '', cost: cost ? cost.textContent : '', target: cost ? Number(cost.dataset.cost) : 0 }; });
  await page.waitForTimeout(700);
  const live2 = await page.evaluate(() => { const cost = document.querySelector('#thread .message:last-child .msg-cost'); return { cost: cost ? cost.textContent : '', target: cost ? Number(cost.dataset.cost) : 0, ticking: cost ? cost.classList.contains('ticking') : false, pending: getActiveChat().messages.slice(-1)[0].pending }; });
  check('while it is written, the model and its price are under the answer, always visible', Number(live1.shown) >= 0.8 && /V4\.1 Flash/.test(live1.model) && /^\$0\.\d{4}$/.test(live1.cost), live1);
  check('…and the price goes up live before the request ends', live2.pending && live2.target > live1.target && live1.target > 0, { live1, live2 });
  await idle(page, 30000);
  await settle();
  const settled = await page.evaluate(() => { const m = getActiveChat().messages.slice(-1)[0]; const cost = document.querySelector('#thread .message:last-child .msg-cost'); return { text: cost.textContent, real: m.cost, live: m.liveCost }; });
  check('when it ends the counter settles on the real cost', settled.text === '$' + settled.real.toFixed(4) && settled.live === undefined, settled);
  // The conversation's total, small, right above the send button: every answer and old version.
  const total = await page.evaluate(() => { const el = document.getElementById('chat-cost'); const send = document.getElementById('send-btn').getBoundingClientRect(); const box = el.getBoundingClientRect(); return { text: el.textContent, html: el.innerHTML, expected: chatTotalCost(getActiveChat()), above: box.bottom <= send.top + 1 && Math.abs(box.right - send.right) < 2 && box.right <= innerWidth, size: parseFloat(getComputedStyle(el).fontSize), box: [box.left, box.right, box.top, box.bottom], send: [send.left, send.right, send.top] }; });
  check('right above the send button: the whole conversation\'s cost, small, last two decimals grey', total.text === '$' + total.expected.toFixed(4) && Math.abs(total.expected - 0.0035) < 1e-9 && /<span class="msg-cost-zeros">\d\d<\/span>$/.test(total.html) && total.above && total.size < 11, total);

  // 2. Another account for a question.
  await page.evaluate(() => {
    window.__extraScopes = [];
    window.requestExtraGoogleToken = async () => ({ access_token: 'extra-token', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly' });
  });
  await page.click('#plus-btn');
  await page.click('#extra-google-btn');
  await page.waitForSelector('.extra-google-pill');
  const pill = await page.evaluate(() => document.querySelector('.extra-google-pill').innerText);
  check('linking it shows a pill with its email in the composer', /club@example\.org/.test(pill), pill);
  const tools = await page.evaluate(() => extraGoogleToolsFor(null, true).map((t) => t.name).sort());
  check('the model gets read-only Gmail and Drive tools for it (shared drives too), no write tool (drive_import only copies into the chat)', JSON.stringify(tools) === JSON.stringify(['extra_drive_import', 'extra_drive_list', 'extra_drive_read', 'extra_drive_search', 'extra_drive_shared_drives', 'extra_gmail_read', 'extra_gmail_search']), tools);
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'extra_gmail_search', args: { query: 'presupuesto taller' } }] },
    { text: '', tools: [{ name: 'extra_gmail_read', args: { id: 'm1' } }] },
    { text: '', tools: [{ name: 'extra_drive_shared_drives', args: {} }] },
    { text: 'El presupuesto aprobado es de 420 €.' }));
  await send(page, '¿Qué presupuesto nos aprobaron para el taller?');
  await idle(page, 30000);
  const results = await page.evaluate(() => {
    const req = window.__requests.slice(-1)[0];
    return { tools: req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).slice(-3), system: String((req.messages.find((m) => m.role === 'system') || {}).content || '') };
  });
  check('the model is told which account it is and what it can read', /club@example\.org/.test(results.system) && /extra_gmail_search/.test(results.system) && /no es la cuenta con la que el usuario ha entrado/.test(results.system), results.system.slice(-400));
  check('extra_gmail_search finds the email with that account\'s token', /id m1 · .*Tesorería.*Presupuesto del taller/s.test(results.tools[0]) && seenTokens.has('Bearer extra-token'), results.tools[0]);
  check('extra_gmail_read reads it whole with its attachments', /420 €/.test(results.tools[1]) && /Adjuntos: factura\.pdf \(20 KB\)/.test(results.tools[1]), results.tools[1]);
  check('extra_drive_shared_drives lists its shared drives', /Club Aeroespacial · id sd1/.test(results.tools[2]), results.tools[2]);
  const stays = await page.evaluate(() => !!document.querySelector('.extra-google-pill'));
  check('the pill stays after sending, until it is removed', stays);

  // 3. Removing it: revoked at Google, no tools, nothing in the prompt.
  await page.click('.extra-google-pill [data-remove-extra-google]');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ pill: !!document.querySelector('.extra-google-pill'), tools: extraGoogleToolsFor(null, true).length, prompt: extraGooglePromptText(), stored: JSON.stringify(localStorage).includes('extra-token') }));
  check('removing the pill revokes the token and the tools go away', !after.pill && after.tools === 0 && after.prompt === '' && revoked.includes('extra-token'), { after, revoked });
  check('the extra token is never written to storage', !after.stored);

  // Gmail API not turned on yet in Google Cloud: linking says so on the pill and
  // in a notice; once it is on, a search works (the app retries a just-enabled API).
  gmailDisabled = 1;
  await page.evaluate(() => { window.requestExtraGoogleToken = async () => ({ access_token: 'extra-token', expires_in: 3600 }); });
  await page.click('#plus-btn');
  await page.click('#extra-google-btn');
  await page.waitForSelector('.extra-google-pill');
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => ({ pill: document.querySelector('.extra-google-pill').innerText, title: document.querySelector('.extra-google-pill').title, toast: (window.__inhouseNotices || []).map((t) => t.message).join(' '), prompt: extraGooglePromptText() }));
  check('Gmail API off in Google Cloud: the pill says Gmail ✕ and why, and a notice explains it', /Gmail ✕/.test(off.pill) && /Drive ✓/.test(off.pill) && /no está activada en el proyecto de Google Cloud/.test(off.title) && /Google tarda unos minutos/.test(off.toast) && /no hace falta volver a vincular/.test(off.prompt), off);
  gmailDisabled = 2;
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'extra_gmail_search', args: { query: 'presupuesto' } }] }, { text: 'Encontrado.' }));
  await send(page, 'Mira en el correo');
  await idle(page, 40000);
  const retried = await page.evaluate(() => { const tools = window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool'); return String(tools[tools.length - 1].content); });
  check('…a just-enabled API is retried: the search works after two SERVICE_DISABLED answers', /id m1 · /.test(retried), retried.slice(0, 200));
  gmailDisabled = 5;
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'extra_gmail_search', args: { query: 'presupuesto' } }] }, { text: 'No.' }));
  await send(page, 'Otra vez el correo');
  await idle(page, 40000);
  const still = await page.evaluate(() => { const tools = window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool'); return String(tools[tools.length - 1].content); });
  check('…if it is still off, the model gets the plain reason: turn it on in Google Cloud, wait, no need to re-link', /no está activada en el proyecto de Google Cloud/.test(still) && /no hace falta volver a vincular/.test(still), still.slice(0, 300));
  gmailDisabled = 0;
  await page.click('.extra-google-pill [data-remove-extra-google]');

  // The same account as the session is refused.
  await page.evaluate(() => { window.requestExtraGoogleToken = async () => ({ access_token: 'same-token', expires_in: 3600 }); });
  await page.click('#plus-btn');
  await page.click('#extra-google-btn');
  await page.waitForTimeout(500);
  const same = await page.evaluate(() => ({ pill: !!document.querySelector('.extra-google-pill') }));
  check('linking the account you are already signed in with is refused', !same.pill && revoked.includes('same-token'), { same, revoked });

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript|googleapis|accounts\.google/.test(e))));
  await browser.close();
})();
