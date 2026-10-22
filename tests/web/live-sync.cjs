// Live sync between two devices through a fake Google Drive: B sees A's answer
// grow while A is still receiving it, and ends with the same final chat.
const { chromium } = require('playwright');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));

// In-memory Drive v3: files with appProperties, multipart and media uploads.
const fallbackOnly = process.env.LIVE_SYNC_FALLBACK === '1';
const files = new Map();
let seq = 0;
let requests = 0;
function stamp() { return new Date(Date.now() + (seq++)).toISOString(); }
function parseMultipart(body, type) {
  const boundary = /boundary=([^;]+)/.exec(type)[1];
  const parts = body.split('--' + boundary).slice(1, -1).map((p) => p.replace(/^\r\n/, '').split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
  return { meta: JSON.parse(parts[0]), content: parts[1] };
}
async function drive(route) {
  requests++;
  const req = route.request();
  const url = new URL(req.url());
  const json = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  const id = (url.pathname.match(/\/files\/([^/]+)$/) || [])[1];
  if (req.method() === 'GET' && !id) {
    const q = url.searchParams.get('q') || '';
    const props = [...q.matchAll(/key='([^']+)' and value='([^']*)'/g)].map((m) => [m[1], m[2]]);
    const name = (/name='([^']+)'/.exec(q) || [])[1];
    const contains = (/name contains '([^']+)'/.exec(q) || [])[1];
    const parent = (/'([^']+)' in parents/.exec(q) || [])[1];
    const found = [...files.values()].filter((f) => props.every(([k, v]) => (f.appProperties || {})[k] === v) && (!name || f.name === name) && (!contains || (f.name || '').includes(contains)) && (!parent || (f.parents || []).includes(parent)));
    return json({ files: found.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime })) });
  }
  if (req.method() === 'GET' && id) {
    const f = files.get(decodeURIComponent(id));
    if (!f) return route.fulfill({ status: 404, body: '{}' });
    if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: 'application/json', body: f.content || '' });
    return json({ id: f.id, modifiedTime: f.modifiedTime });
  }
  if (req.method() === 'POST' && !url.pathname.includes('/upload/')) {
    const meta = JSON.parse(req.postData() || '{}');
    const f = Object.assign({ id: 'f' + files.size, modifiedTime: stamp() }, meta);
    files.set(f.id, f);
    return json({ id: f.id, name: f.name });
  }
  const type = req.headers()['content-type'] || '';
  const body = req.postData() || '';
  if (req.method() === 'POST') {
    const { meta, content } = parseMultipart(body, type);
    const f = Object.assign({ id: 'f' + files.size }, meta, { content, modifiedTime: stamp() });
    files.set(f.id, f);
    return json({ id: f.id, modifiedTime: f.modifiedTime });
  }
  const f = files.get(decodeURIComponent(id));
  if (/multipart/.test(type)) { const { meta, content } = parseMultipart(body, type); Object.assign(f, meta, { content }); } else f.content = body;
  f.modifiedTime = stamp();
  return json({ id: f.id, modifiedTime: f.modifiedTime });
}

async function device(browser) {
  const app = await openApp(browser, { viewport: { width: 1100, height: 850 } });
  await app.page.route('https://www.googleapis.com/**', drive);
  if (fallbackOnly) await app.page.evaluate(() => { window.RTCPeerConnection = undefined; });
  await app.page.evaluate(async () => {
    appState.profile = { email: 'test@example.com', name: 'Test' };
    appState.accessToken = 'token';
    appState.accessTokenExpiresAt = Date.now() + 3600 * 1000;
    await ensureDriveReady();
  });
  return app;
}

(async () => {
  // Two contexts of one browser reach each other through host candidates.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const A = await device(browser);
  const B = await device(browser);
  const direct = fallbackOnly ? [] : await Promise.all([A, B].map((d) => d.page.waitForFunction(() => peerOpenCount() > 0, null, { timeout: 30000 }).then(() => true, () => false)));
  if (!fallbackOnly) check('A and B connect directly (WebRTC, signalled through Drive)', direct.every(Boolean), direct);
  else console.log('INFO WebRTC disabled explicitly: testing Drive fallback');
  const text = 'Primera parte de una respuesta larga que se escribe poco a poco. '.repeat(14) + 'FIN.';
  await A.page.evaluate((t) => window.__replies.push({ text: t, chunk: 6, delay: 70 }), text);
  await send(A.page, 'Explícame algo despacio');
  // B: the chat appears and, once opened, grows while A is still answering.
  const chatId = await A.page.evaluate(() => appState.activeChatId);
  await B.page.waitForFunction((id) => appState.chats.some((c) => c.id === id), chatId, { timeout: 10000 });
  await B.page.click('#hamburger-btn'); await B.page.waitForTimeout(350);
  await B.page.click('.chat-item[data-chat-id="' + chatId + '"]');
  const lengths = [];
  const lags = [];
  for (let k = 0; k < 12; k++) {
    await B.page.waitForTimeout(300);
    const [a, b] = await Promise.all([
      A.page.evaluate(() => { const m = getActiveChat().messages.slice(-1)[0]; return m ? m.content.length : 0; }),
      B.page.evaluate((id) => { const c = appState.chats.find((x) => x.id === id); const m = c && c.messages.slice(-1)[0]; return m && m.role === 'assistant' ? m.content.length : 0; }, chatId)
    ]);
    lags.push(a - b);
    if (k % 3 === 2) lengths.push(await B.page.evaluate(() => { const el = [...document.querySelectorAll('#thread .message')].pop(); return el ? el.innerText.length : 0; }));
  }
  lags.sort((x, y) => x - y);
  check(fallbackOnly ? 'B follows A within two Drive polling intervals' : 'B is at most a few characters behind A (instant)', lags[Math.floor(lags.length / 2)] <= (fallbackOnly ? 180 : 20), lags);
  const aBusy = await A.page.evaluate(() => appState.busy);
  const userShown = await B.page.evaluate(() => /Explícame algo despacio/.test(document.getElementById('thread').innerText));
  check('B shows the question and the answer growing while A is still answering', aBusy && userShown && lengths[0] > 0 && lengths[3] > lengths[0], { aBusy, userShown, lengths });
  await B.page.screenshot({ path: SCRATCH + '/live-b-mid.png' });
  await idle(A.page, 60000);
  await B.page.waitForFunction(() => /FIN\./.test(document.getElementById('thread').innerText) && !getActiveChat().messages.some((m) => m.pending), null, { timeout: 15000 }).catch(() => {});
  const end = await B.page.evaluate(() => ({ text: getActiveChat().messages.map((m) => m.role + ':' + m.content.length).join(' '), pending: getActiveChat().messages.some((m) => m.pending), shown: /FIN\./.test(document.getElementById('thread').innerText) }));
  const endA = await A.page.evaluate(() => getActiveChat().messages.map((m) => m.role + ':' + m.content.length).join(' '));
  check('B ends with the same final chat as A', end.shown && !end.pending && end.text === endA, { b: end, a: endA });
  // A chat started on B reaches A without a reload (snapshot polling).
  await B.page.evaluate(() => window.__replies.push({ text: 'Respuesta en B.', delay: 5 }));
  await B.page.click('#hamburger-btn'); await B.page.waitForTimeout(350); await B.page.click('#new-chat-btn');
  await send(B.page, 'Chat nuevo desde B'); await idle(B.page);
  const newId = await B.page.evaluate(() => appState.activeChatId);
  const reached = await A.page.waitForFunction((id) => appState.chats.some((c) => c.id === id && c.messages.some((m) => m.content === 'Respuesta en B.')), newId, { timeout: 4000 }).then(() => true, () => false);
  check('a chat made on B reaches A within 4 s', reached);
  // A library document added on A is downloaded by B for the same chat.
  await A.page.evaluate(async (id) => {
    const file = new File(['Resumen: la meiosis produce cuatro células haploides.'], 'resumen.txt', { type: 'text/plain' });
    await InhouseLibrary.ingest(id, [{ file, path: 'resumen.txt' }]);
  }, chatId);
  await A.page.waitForFunction(() => true);
  for (let i = 0; i < 20 && ![...files.values()].some((f) => /^library-/.test(f.name)); i++) await A.page.waitForTimeout(250);
  const fromDrive = await B.page.evaluate(async (id) => {
    await InhouseLibrary.pullFromDrive(id);
    return (await InhouseLibrary.search(id, 'meiosis')).hits.map((h) => h.name);
  }, chatId);
  check('a library file added on A is found by B through Drive', fromDrive[0] === 'resumen.txt', fromDrive);
  // No pending message ever lands in conversations.json.
  const snap = [...files.values()].find((f) => f.name === 'conversations.json');
  check('conversations.json holds no pending messages', snap && !JSON.parse(snap.content).chats.some((c) => c.messages.some((m) => m.pending)));
  console.log('drive requests', requests);
  console.log('errors', JSON.stringify(A.errors.concat(B.errors).filter((e) => !/initScript|Drive en directo/.test(e))));
  await browser.close();
})();
