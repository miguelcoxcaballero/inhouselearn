// Measures the live chat between two devices with the same chat open, over the
// direct WebRTC channel and over the Drive fallback (WebRTC disabled), on a fake
// Drive with real-world latency (120–350 ms a request) and a search index that
// lags 2 s behind (like Drive's files.list). Prints the numbers and checks them:
//  · latency: question and answer shown on the other device (ms behind the
//    answering device receiving each character);
//  · fluency: the longest stall of the text while it should be growing, frame gaps;
//  · reliability: reverse direction, steering, stop, switching chats mid-answer,
//    reload mid-answer, a dropped direct connection, same final chat everywhere;
//  · efficiency: bytes over the channel, Drive requests while answering and idle.
// LIVE_MODES=rtc or LIVE_MODES=drive runs one mode only.
const { chromium } = require('playwright');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');

let failures = 0;
const check = (label, ok, extra) => {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 600) : ''));
};
// Shared CI runners are slower and noisier: timing limits get 50 % more room there.
const T = (ms) => ms * (process.env.CI ? 1.5 : 1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (values, p) => { const v = values.slice().sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN; };

/* ─── Fake Drive v3 with latency and a lagging search index ─────────── */
function fakeDrive() {
  const files = new Map();
  const counts = new Map();
  let n = 0;
  let clock = 0;
  const INDEX_LAG = 2000;
  const stamp = () => new Date(Math.max(Date.now(), ++clock)).toISOString();
  const touch = (f) => { f.modifiedTime = stamp(); (f.history ||= []).push([Date.now(), f.modifiedTime]); };
  const indexed = (f) => { const h = (f.history || []).filter(([t]) => t <= Date.now() - INDEX_LAG); return h.length ? h[h.length - 1][1] : null; };
  function parseMultipart(body, type) {
    const boundary = /boundary=([^;]+)/.exec(type)[1];
    const parts = body.split('--' + boundary).slice(1, -1).map((p) => p.replace(/^\r\n/, '').split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
    return { meta: JSON.parse(parts[0]), content: parts[1] };
  }
  const kinds = new Map();
  async function handle(route, who) {
    counts.set(who, (counts.get(who) || 0) + 1);
    {
      const r = route.request(); const u = new URL(r.url()); const q = u.searchParams.get('q') || '';
      const f = files.get(decodeURIComponent((u.pathname.match(/\/files\/([^/]+)$/) || [])[1] || ''));
      const k = who + ' ' + r.method() + ' ' + (q ? 'list:' + (/peer-/.test(q) ? 'peer' : /Live/.test(q) ? 'live' : q.slice(0, 50)) : f ? (f.name || '').replace(/-[^.]+/, '-*') + (u.searchParams.get('alt') ? ':media' : '') : u.pathname.slice(0, 40));
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    await sleep(120 + Math.random() * 230);
    const req = route.request();
    const url = new URL(req.url());
    const json = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
    const id = decodeURIComponent((url.pathname.match(/\/files\/([^/]+)$/) || [])[1] || '');
    if (req.method() === 'DELETE') { files.delete(id); return route.fulfill({ status: 204, body: '' }); }
    if (req.method() === 'GET' && !id) {
      const q = url.searchParams.get('q') || '';
      const props = [...q.matchAll(/key='([^']+)' and value='([^']*)'/g)].map((m) => [m[1], m[2]]);
      const name = (/name='([^']+)'/.exec(q) || [])[1];
      const contains = (/name contains '([^']+)'/.exec(q) || [])[1];
      const parent = (/'([^']+)' in parents/.exec(q) || [])[1];
      const found = [...files.values()].filter((f) => indexed(f) && props.every(([k, v]) => (f.appProperties || {})[k] === v) && (!name || f.name === name) && (!contains || (f.name || '').includes(contains)) && (!parent || (f.parents || []).includes(parent)));
      return json({ files: found.map((f) => ({ id: f.id, name: f.name, modifiedTime: indexed(f) })) });
    }
    if (req.method() === 'GET') {
      const f = files.get(id);
      if (!f) return route.fulfill({ status: 404, body: '{}' });
      if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: 'application/json', body: f.content || '' });
      return json({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
    }
    if (req.method() === 'POST' && !url.pathname.includes('/upload/')) {
      const f = Object.assign({ id: 'f' + (++n) }, JSON.parse(req.postData() || '{}'));
      touch(f); files.set(f.id, f);
      return json({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
    }
    const type = req.headers()['content-type'] || '';
    const body = req.postData() || '';
    if (req.method() === 'POST') {
      const { meta, content } = parseMultipart(body, type);
      const f = Object.assign({ id: 'f' + (++n) }, meta, { content });
      touch(f); files.set(f.id, f);
      return json({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
    }
    const f = files.get(id);
    if (!f) return route.fulfill({ status: 404, body: '{}' });
    if (/multipart/.test(type)) { const { meta, content } = parseMultipart(body, type); Object.assign(f, meta, { content }); } else f.content = body;
    touch(f);
    return json({ id: f.id, modifiedTime: f.modifiedTime });
  }
  return { files, counts, handle, kinds };
}

// What each page records: the answer's characters as they arrive and as they
// are drawn, when each question appears, bytes sent over the direct channel.
function instrument() {
  window.__rtcBytes = 0;
  if (window.RTCDataChannel) {
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) { window.__rtcBytes += typeof data === 'string' ? data.length : (data.byteLength || 0); return send.call(this, data); };
  }
  window.__log = [];
  window.__frames = [];
  window.__seen = {};
  let last = '';
  let prevFrame = 0;
  const sample = (now) => {
    if (prevFrame) window.__frames.push([Date.now(), now - prevFrame]);
    prevFrame = now;
    if (window.__frames.length > 20000) window.__frames.splice(0, 10000);
    const chat = typeof getActiveChat === 'function' ? getActiveChat() : null;
    if (chat) {
      const answer = chat.messages.filter((m) => m.role === 'assistant').slice(-1)[0];
      if (answer) {
        const view = streamViews.get(answer.id);
        // A view whose element was redrawn is not on screen: the new element shows the whole text.
        const shown = view && view.attached() ? Math.floor(view.shown) : answer.content.length;
        const key = answer.id + ':' + answer.content.length + ':' + shown;
        if (key !== last) { last = key; window.__log.push([Date.now(), answer.id, answer.content.length, shown]); }
      }
      const thread = document.getElementById('thread');
      if (thread) thread.querySelectorAll('.message.user-msg').forEach((el) => {
        const bubble = el.querySelector('.bubble');
        const text = (bubble ? bubble.innerText : el.innerText).trim();
        if (!(text in window.__seen)) window.__seen[text] = Date.now();
      });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

async function device(browser, drive, name, rtc) {
  const app = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  await app.page.route('https://www.googleapis.com/**', (route) => drive.handle(route, name));
  if (!rtc) {
    await app.page.addInitScript(() => { window.RTCPeerConnection = undefined; });
    await app.page.evaluate(() => { window.RTCPeerConnection = undefined; });
  }
  await app.page.evaluate(instrument);
  await app.page.evaluate(async () => {
    appState.profile = { email: 'test@example.com', name: 'Test' };
    appState.accessToken = 'token';
    appState.accessTokenExpiresAt = Date.now() + 3600 * 1000;
    await ensureDriveReady();
  });
  app.name = name;
  return app;
}

async function openChat(app, chatId) {
  await app.page.waitForFunction((id) => appState.chats.some((c) => c.id === id), chatId, { timeout: 15000 });
  await app.page.evaluate((id) => { if (appState.activeChatId !== id) { appState.activeChatId = id; renderHistory(); renderThread(); } }, chatId);
}

const chatOf = (app) => app.page.evaluate(() => getActiveChat().messages.map((m) => m.role[0] + ':' + m.content).join('\n'));
// Both chats equal (and what differs, for the log).
async function same(A, B) {
  const [a, b] = await Promise.all([chatOf(A), chatOf(B)]);
  const al = a.split('\n'); const bl = b.split('\n');
  const at = al.findIndex((line, i) => line !== bl[i]);
  return { ok: a === b, diff: a === b ? null : { line: at, a: (al[at] || '').slice(0, 80), b: (bl[at] || '').slice(0, 80), lines: [al.length, bl.length] } };
}
const pendingOn = (app) => app.page.evaluate(() => getActiveChat().messages.some((m) => m.pending));

// Lag of what B draws (and receives) behind what A receives, for one answer.
async function measure(A, B, from) {
  const [logA, logB, framesB] = await Promise.all([
    A.page.evaluate((t) => window.__log.filter((r) => r[0] >= t), from),
    B.page.evaluate((t) => window.__log.filter((r) => r[0] >= t), from),
    B.page.evaluate((t) => window.__frames.filter((r) => r[0] >= t).map((r) => r[1]), from)
  ]);
  const id = logA.length ? logA[logA.length - 1][1] : '';
  const a = logA.filter((r) => r[1] === id);
  const b = logB.filter((r) => r[1] === id);
  const final = a.length ? a[a.length - 1][2] : 0;
  const arrivedA = (len) => { const row = a.find((r) => r[2] >= len); return row ? row[0] : NaN; };
  const shownLag = [];
  const recvLag = [];
  const ownLag = [];
  b.forEach((r) => { if (r[3] > 0 && r[3] < final) shownLag.push(r[0] - arrivedA(r[3])); if (r[2] > 0 && r[2] < final) recvLag.push(r[0] - arrivedA(r[2])); });
  a.forEach((r) => { if (r[3] > 0 && r[3] < final) ownLag.push(r[0] - arrivedA(r[3])); });
  // Stalls: B's text not moving while A had already received more.
  let stall = 0;
  let lastMove = 0;
  let lastShown = 0;
  const firstB = b.find((r) => r[3] > 0);
  const doneA = a.find((r) => r[2] >= final);
  if (firstB && doneA) {
    lastMove = firstB[0]; lastShown = firstB[3];
    for (const r of b) {
      if (r[0] > doneA[0]) break;
      if (r[3] > lastShown) { stall = Math.max(stall, r[0] - lastMove); lastMove = r[0]; lastShown = r[3]; }
    }
    stall = Math.max(stall, Math.min(doneA[0], b.length ? b[b.length - 1][0] : 0) - lastMove);
  }
  return {
    final,
    shown: { p50: pct(shownLag, 0.5), p95: pct(shownLag, 0.95) },
    received: { p50: pct(recvLag, 0.5), p95: pct(recvLag, 0.95) },
    ownDisplay: { p50: pct(ownLag, 0.5) },
    stall,
    frames: { p95: Math.round(pct(framesB, 0.95)), long: framesB.filter((f) => f > 50).length, count: framesB.length }
  };
}

async function run(mode) {
  const rtc = mode === 'rtc';
  const L = (label) => '[' + mode + '] ' + label;
  console.log('\n=== ' + (rtc ? 'Direct channel (WebRTC)' : 'Drive fallback (WebRTC disabled)') + ' ===');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const drive = fakeDrive();
  const A = await device(browser, drive, 'A', rtc);
  const B = await device(browser, drive, 'B', rtc);
  const started = Date.now();
  if (rtc) {
    const direct = await Promise.all([A, B].map((d) => d.page.waitForFunction(() => peerOpenCount() > 0, null, { timeout: 40000 }).then(() => true, () => false)));
    check(L('the devices connect directly'), direct.every(Boolean), { seconds: (Date.now() - started) / 1000 });
  } else {
    await Promise.all([A, B].map((d) => d.page.waitForFunction(() => appState.peerNet && appState.peerNet.recent.size > 0, null, { timeout: 30000 })));
    console.log('INFO presence known after ' + (Date.now() - started) / 1000 + ' s');
  }

  // A chat both devices have open.
  await A.page.evaluate(() => window.__replies.push({ text: 'Hola, ¿qué quieres aprender hoy?', delay: 5 }));
  await send(A.page, 'Hola');
  await idle(A.page);
  const chatId = await A.page.evaluate(() => appState.activeChatId);
  await openChat(B, chatId);
  await B.page.waitForFunction(() => getActiveChat().messages.length === 2 && !getActiveChat().messages.some((m) => m.pending), null, { timeout: 15000 });

  // 1. A long answer from A while B watches.
  const text = Array.from({ length: 9 }, (_, i) => 'Párrafo ' + (i + 1) + ': la fotosíntesis convierte la luz en energía química dentro del cloroplasto, paso a paso.').join('\n\n') + '\n\nFIN.';
  await A.page.evaluate((t) => window.__replies.push({ text: t, chunk: 5, delay: 45 }), text);
  const bytes0 = await Promise.all([A, B].map((d) => d.page.evaluate(() => window.__rtcBytes)));
  const req0 = { A: drive.counts.get('A') || 0, B: drive.counts.get('B') || 0 };
  // Someone types the question (a couple of seconds), then sends it.
  await A.page.type('#composer', 'Explícame', { delay: 60 });
  await sleep(1500);
  await A.page.fill('#composer', 'Explícame la fotosíntesis');
  const sentAt = Date.now();
  drive.kinds.clear();
  await A.page.click('#send-btn');
  const questionAt = await B.page.waitForFunction(() => window.__seen['Explícame la fotosíntesis'], null, { timeout: 15000 }).then((h) => h.jsonValue());
  await sleep(1800);
  await B.page.screenshot({ path: SCRATCH + '/live-' + mode + '-mid.png' });
  const live = await B.page.evaluate(() => ({ tag: !!document.querySelector('.message:last-child .remote-live'), pending: getActiveChat().messages.slice(-1)[0].pending }));
  await idle(A.page, 60000);
  const doneA = Date.now();
  await B.page.waitForFunction(() => !getActiveChat().messages.some((m) => m.pending) && /FIN\./.test(document.getElementById('thread').innerText) && !document.querySelector('.stream-caret'), null, { timeout: 20000 }).catch(() => {});
  const doneB = Date.now();
  const m = await measure(A, B, sentAt);
  const elapsed = (doneA - sentAt) / 1000;
  const bytes = (await Promise.all([A, B].map((d) => d.page.evaluate(() => window.__rtcBytes)))).map((v, i) => v - bytes0[i]);
  const reqs = { A: (drive.counts.get('A') || 0) - req0.A, B: (drive.counts.get('B') || 0) - req0.B };
  if (process.env.LIVE_DEBUG) console.log([...drive.kinds].sort().map(([k, v]) => k + ' ' + v).join('\n'));
  // Requests of the live path itself (live and peer files), apart from history saves.
  const liveReqs = { A: 0, B: 0 };
  const liveWrites = { A: 0, B: 0 };
  drive.kinds.forEach((v, k) => { if (/live|peer/.test(k)) liveReqs[k[0]] += v; if (/PATCH live/.test(k)) liveWrites[k[0]] += v; });
  console.log('METRIC ' + mode + ' ' + JSON.stringify({ questionMs: questionAt - sentAt, answerChars: m.final, seconds: elapsed, endMs: doneB - doneA, ...m, rtcBytes: bytes[0], rtcBytesPerChar: +(bytes[0] / m.final).toFixed(2), driveReqPerSec: { A: +(reqs.A / elapsed).toFixed(2), B: +(reqs.B / elapsed).toFixed(2) }, liveReqPerSec: { A: +(liveReqs.A / elapsed).toFixed(2), B: +(liveReqs.B / elapsed).toFixed(2) }, liveWritesPerSec: +(liveWrites.A / elapsed).toFixed(2) }));
  check(L('the question appears on B at once'), questionAt - sentAt <= T(rtc ? 300 : 1000), questionAt - sentAt);
  check(L('B draws the answer close behind A'), m.shown.p50 <= T(rtc ? 450 : 1500) && m.shown.p95 <= T(rtc ? 800 : 2600), m.shown);
  check(L('the text on B never stalls while it should be moving'), m.stall <= T(rtc ? 300 : 900), m.stall);
  check(L('B marks the answer as live while it is written'), live.tag && live.pending, live);
  check(L('B ends with exactly A\'s chat, nothing pending'), (await same(A, B)).ok && !(await pendingOn(B)));
  if (rtc) check(L('the channel stays light (under 3 KB/s while streaming)'), bytes[0] / elapsed < 3000, { perSecond: Math.round(bytes[0] / elapsed), perChar: +(bytes[0] / m.final).toFixed(1) });
  else check(L('live writes stay under Drive\'s pace (2/s) and live requests moderate'), liveWrites.A / elapsed <= 2 && liveReqs.A / elapsed <= 3.6 && liveReqs.B / elapsed <= 3, { writes: +(liveWrites.A / elapsed).toFixed(2), A: +(liveReqs.A / elapsed).toFixed(2), B: +(liveReqs.B / elapsed).toFixed(2) });

  // 2. The other way round: B asks, A watches.
  await B.page.evaluate(() => window.__replies.push({ text: 'Respuesta escrita desde B, que A ve mientras se escribe con calma.', chunk: 4, delay: 40 }));
  // Sent the instant it is typed: the worst case for the Drive path.
  const back = Date.now();
  await send(B.page, 'Pregunta desde B');
  const backAt = await A.page.waitForFunction(() => window.__seen['Pregunta desde B'], null, { timeout: 15000 }).then((h) => h.jsonValue());
  await idle(B.page, 30000);
  await A.page.waitForFunction(() => !getActiveChat().messages.some((m) => m.pending) && /con calma\./.test(document.getElementById('thread').innerText), null, { timeout: 15000 }).catch(() => {});
  check(L('reverse: B\'s question reaches A at once (even sent the instant it is typed) and the chats match'), backAt - back <= T(rtc ? 300 : 2200) && (await same(A, B)).ok, backAt - back);

  // 3. Steering on A: B shows the answer so far, the steer and the rest.
  await A.page.evaluate(() => window.__replies.push(
    { text: 'Empiezo a revisarlo todo con calma, paso a paso, sin prisa ninguna.', chunk: 3, delay: 40, tools: [{ name: 'run_js', args: { code: 'const t = Date.now(); while (Date.now() - t < 1200) {} return 1;' } }] },
    { text: 'Vale, resumido: luz, agua y CO2 dan azúcar y oxígeno.', chunk: 4, delay: 40 }));
  await send(A.page, 'Hazlo largo');
  await A.page.waitForFunction(() => appState.busy && getActiveChat().messages.slice(-1)[0].content.length > 10);
  await A.page.fill('#composer', 'Mejor corto');
  await A.page.press('#composer', 'Control+Enter');
  await idle(A.page, 30000);
  await B.page.waitForFunction(() => /azúcar y oxígeno\./.test(document.getElementById('thread').innerText) && !getActiveChat().messages.some((m) => m.pending), null, { timeout: 15000 }).catch(() => {});
  const steerA = await chatOf(A);
  const steerB = await chatOf(B);
  const caretsB = await B.page.evaluate(() => document.querySelectorAll('.stream-caret, .remote-live').length);
  check(L('steer: B ends with the same four messages, none left live'), steerA === steerB && !(await pendingOn(B)) && caretsB === 0, { a: steerA.split('\n').slice(-4).map((s) => s.slice(0, 24)), b: steerB.split('\n').slice(-4).map((s) => s.slice(0, 24)), caretsB });

  // 4. Stop on A: B keeps what was written, marked as stopped.
  await A.page.evaluate(() => window.__replies.push({ text: 'Una respuesta larguísima que se va a parar a medias porque sí, sin terminar.', chunk: 2, delay: 90 }));
  await send(A.page, 'Algo largo');
  await A.page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content.length > 20);
  await A.page.click('#send-btn');
  await idle(A.page);
  await B.page.waitForFunction(() => /\(Detenido\)/.test(document.getElementById('thread').innerText) && !getActiveChat().messages.some((m) => m.pending), null, { timeout: 15000 }).catch(() => {});
  check(L('stop: B shows the partial answer as stopped'), (await same(A, B)).ok && /\(Detenido\)/.test(await chatOf(B)));

  // 5. B leaves the chat mid-answer and comes back: it carries on, no retyping from zero.
  await A.page.evaluate(() => window.__replies.push({ text: 'Texto que sigue llegando mientras B mira otro chat y luego vuelve a este. '.repeat(5) + 'FIN.', chunk: 4, delay: 45 }));
  await send(A.page, 'Sigue');
  await A.page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content.length > 60);
  await B.page.waitForFunction(() => { const m = getActiveChat().messages.slice(-1)[0]; return m.role === 'assistant' && m.pending && m.content.length > 20; }, null, { timeout: 15000 });
  await B.page.evaluate(() => newChat());
  await sleep(900);
  const switchedAt = Date.now();
  const atSwitch = await B.page.evaluate((id) => { const chat = appState.chats.find((c) => c.id === id); appState.activeChatId = id; renderHistory(); renderThread(); const m = chat.messages.slice(-1)[0]; return { id: m.id, len: m.content.length, pending: m.pending }; }, chatId);
  await sleep(1000);
  const after = await B.page.evaluate(([t, id]) => window.__log.filter((r) => r[0] >= t && r[1] === id).map((r) => r[3]), [switchedAt, atSwitch.id]);
  const lowest = Math.min(...after);
  check(L('switching chats mid-answer: B carries on from what it had, never retyping'), atSwitch.pending && after.length > 0 && lowest >= atSwitch.len * 0.9 && after[after.length - 1] > atSwitch.len, { atSwitch, lowest, last: after[after.length - 1] });
  await idle(A.page, 30000);
  await B.page.waitForFunction(() => !getActiveChat().messages.some((m) => m.pending), null, { timeout: 15000 }).catch(() => {});
  const end5 = await same(A, B);
  check(L('…and ends equal'), end5.ok, end5.diff);

  // 6. B reloads mid-answer: it picks the turn up again.
  await A.page.evaluate(() => window.__replies.push({ text: 'Respuesta que B recoge después de recargar la página. '.repeat(16) + 'FIN.', chunk: 4, delay: 50 }));
  await send(A.page, 'Otra más');
  await A.page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content.length > 40);
  await B.page.reload({ waitUntil: 'load' });
  await B.page.waitForFunction(() => typeof appState === 'object' && appState.driveReady, null, { timeout: 20000 }).catch(() => {});
  await B.page.evaluate(instrument);

  const reloadedAt = Date.now();
  await openChat(B, chatId);
  const pickedUp = await B.page.waitForFunction(() => { const m = getActiveChat().messages.slice(-1)[0]; return m && m.role === 'assistant' && m.pending && m.content.length > 0; }, null, { timeout: 15000 }).then(() => true, () => false);
  const pickedAt = Date.now();
  await idle(A.page, 40000);
  await B.page.waitForFunction(() => !getActiveChat().messages.some((m) => m.pending) && /FIN\./.test(getActiveChat().messages.slice(-1)[0].content), null, { timeout: 20000 }).catch(() => {});
  const pickedMs = pickedAt - reloadedAt;
  const end6 = await same(A, B);
  check(L('reload mid-answer: B picks the live answer up again (≤ 4 s) and ends equal'), pickedUp && pickedMs <= T(4000) && end6.ok, { pickedUp, ms: pickedMs, diff: end6.diff });

  // 7. The direct channel drops mid-answer: Drive carries on, then it reconnects.
  if (rtc) {
    await B.page.waitForFunction(() => peerOpenCount() > 0, null, { timeout: 30000 }).catch(() => {});
    await A.page.evaluate(() => window.__replies.push({ text: 'Esta respuesta pierde la conexión directa a mitad y aun así llega entera. '.repeat(6) + 'FIN.', chunk: 4, delay: 50 }));
    await send(A.page, 'Con corte');
    await A.page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content.length > 40);
    const cutAt = Date.now();
    await A.page.evaluate(() => appState.peerNet.peers.forEach((peer) => peer.pc.close()));
    const lenAtCut = await B.page.evaluate(() => getActiveChat().messages.slice(-1)[0].content.length);
    await sleep(2500);
    const lenLater = await B.page.evaluate(() => getActiveChat().messages.slice(-1)[0].content.length);
    await idle(A.page, 40000);
    await B.page.waitForFunction(() => !getActiveChat().messages.some((m) => m.pending), null, { timeout: 20000 }).catch(() => {});
    const end7 = await same(A, B);
    check(L('dropped channel: B keeps receiving through Drive and ends equal'), lenLater > lenAtCut && end7.ok, { lenAtCut, lenLater, diff: end7.diff });
    const again = await A.page.waitForFunction(() => peerOpenCount() > 0, null, { timeout: 30000 }).then(() => true, () => false);
    check(L('…and the direct channel comes back by itself'), again, { seconds: (Date.now() - cutAt) / 1000 });
  }

  // 8. Idle cost: requests per second with nothing happening (once any reconnection is over).
  if (rtc) await Promise.all([A, B].map((d) => d.page.waitForFunction(() => peerOpenCount() > 0 && peersAllConnected(), null, { timeout: 30000 }).catch(() => {})));
  // The tail of the reconnection (reading the other side's peer file by id) can
  // outlast the channel opening on a slow CI runner: let it end before measuring.
  await sleep(8000);
  const idle0 = { A: drive.counts.get('A') || 0, B: drive.counts.get('B') || 0 };
  drive.kinds.clear();
  await sleep(20000);
  const idleAll = { A: ((drive.counts.get('A') || 0) - idle0.A) / 20, B: ((drive.counts.get('B') || 0) - idle0.B) / 20 };
  const idleRate = { A: 0, B: 0 };
  drive.kinds.forEach((v, k) => { if (/live|peer/.test(k)) idleRate[k[0]] += v / 20; });
  console.log('METRIC ' + mode + ' idle Drive requests/s ' + JSON.stringify({ live: idleRate, all: idleAll }));
  if (process.env.LIVE_DEBUG) console.log([...drive.kinds].sort().map(([k, v]) => k + ' ' + v).join('\n'));
  check(L('idle: few live Drive requests per second'), idleRate.A <= (rtc ? 0.6 : 1.2) && idleRate.B <= (rtc ? 0.6 : 1.2), idleRate);

  const snap = [...drive.files.values()].find((f) => f.name === 'conversations.json');
  check(L('conversations.json never holds pending or live-only fields'), snap && !/"pending":true|remoteLive/.test(snap.content));
  const errors = A.errors.concat(B.errors).filter((e) => !/initScript|Drive en directo|Conexión directa/.test(e));
  check(L('no page errors'), !errors.length, errors);
  await browser.close();
}

(async () => {
  const modes = (process.env.LIVE_MODES || 'rtc,drive').split(',');
  for (const mode of modes) await run(mode);
  console.log(failures ? failures + ' failed' : 'All live stream checks passed.');
  process.exit(failures ? 1 : 0);
})();
