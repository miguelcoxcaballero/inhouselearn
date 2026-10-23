// The user's Google Drive in the chat, against a fake Drive: connecting asks
// Google for read-only access (drive.readonly) and nothing else; the model
// searches and reads (Docs exported as text); every change is one call for one
// file and one action and is asked EVERY time, also in «Acceso total»; the
// first approved change asks Google for write access; a «No» changes nothing;
// Google refusing the permission leaves Drive disconnected.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

const READ = 'https://www.googleapis.com/auth/drive.readonly';
const WRITE = 'https://www.googleapis.com/auth/drive';
let granted = [];
let grantOnRequest = true;
const files = {
  doc1: { id: 'doc1', name: 'Apuntes de física', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T10:00:00Z', text: 'La energía cinética es ½·m·v².' },
  txt1: { id: 'txt1', name: 'lista.md', mimeType: 'text/markdown', modifiedTime: '2026-10-02T10:00:00Z', size: '40', text: '# Lista\n- leer tema 3\n- repasar tema 4\n' },
  txt2: { id: 'txt2', name: 'notas.txt', mimeType: 'text/plain', modifiedTime: '2026-10-03T10:00:00Z', size: '20', text: 'hola mundo\n' }
};
const queries = [];
const writes = [];

async function google(route) {
  const req = route.request();
  const url = new URL(req.url());
  const json = (obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (url.hostname === 'oauth2.googleapis.com') return json({ scope: granted.join(' ') });
  const p = url.pathname;
  let m;
  if (p === '/drive/v3/files' && req.method() === 'GET') {
    const q = url.searchParams.get('q') || '';
    queries.push(q);
    // Only the user's files: the app's own folder lookups get nothing here.
    if (!/fullText contains|'root' in parents|^trashed = false$/.test(q)) return json({ files: [] });
    const word = (/name contains '([^']+)'/.exec(q) || [])[1] || '';
    return json({ files: Object.values(files).filter((f) => !f.trashed && (!word || f.name.toLowerCase().includes(word.toLowerCase()) || f.text.toLowerCase().includes(word.toLowerCase()))).map(({ text, ...f }) => f) });
  }
  if ((m = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(p))) return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: files[m[1]].text });
  if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p)) && req.method() === 'PATCH') {
    if (!granted.includes(WRITE)) return json({ error: { message: 'Insufficient Permission' } }, 403);
    files[m[1]].text = req.postData();
    writes.push('content:' + m[1]);
    const { text, ...f } = files[m[1]];
    return json(f);
  }
  if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
    const file = files[m[1]];
    if (!file) return json({ error: { message: 'File not found' } }, 404);
    if (req.method() === 'PATCH') {
      if (!granted.includes(WRITE)) return json({ error: { message: 'Insufficient Permission' } }, 403);
      Object.assign(file, JSON.parse(req.postData() || '{}'));
      writes.push('meta:' + m[1] + ':' + req.postData());
    }
    if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: file.mimeType, headers: { 'access-control-allow-origin': '*' }, body: file.text });
    const { text, ...f } = file;
    return json(f);
  }
  return json({ files: [] });
}

const lastTool = (page) => page.evaluate(() => { const tools = window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool'); return String(tools[tools.length - 1].content); });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  await page.route(/googleapis\.com/, google);
  // A signed-in session; Google's consent screen is the stub below.
  await page.exposeFunction('__grant', (scopes) => { if (grantOnRequest) granted = scopes; return granted; });
  await page.evaluate(() => {
    appState.accessToken = 'user-token';
    appState.accessTokenExpiresAt = Date.now() + 3600000;
    window.__scopeRequests = [];
    window.requestGoogleAccessToken = async (prompt) => {
      const scopes = googleOauthScopes();
      window.__scopeRequests.push(scopes.filter((s) => /drive/.test(s)).join(' '));
      await window.__grant(scopes);
      return { access_token: 'user-token', expires_in: 3600 };
    };
  });

  // 1. Google says no: nothing is connected.
  grantOnRequest = false;
  await page.click('#plus-btn');
  await page.click('#gdrive-btn');
  await page.waitForSelector('#confirm-ok');
  const intro = await page.evaluate(() => document.querySelector('#confirm-message, .confirm-message') ? document.querySelector('#confirm-message, .confirm-message').innerText : document.body.innerText);
  await page.click('#confirm-ok');
  await page.waitForTimeout(500);
  const refused = await page.evaluate(() => ({ access: localStorage.getItem(STORAGE_KEY + '::userDrive'), on: !!getActiveChat().userDrive }));
  check('if Google does not grant it, Drive stays disconnected', !refused.access && !refused.on, refused);
  check('the connect dialog says read-only and that every change asks', /Solo lectura/i.test(intro) && /cada archivo y cada acción/.test(intro));

  // 2. Connected: only drive.readonly is asked for.
  grantOnRequest = true;
  await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); });
  if (!(await page.isVisible('#gdrive-btn'))) await page.click('#plus-btn');
  await page.click('#gdrive-btn');
  await page.waitForSelector('#confirm-ok');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => getActiveChat().userDrive === true);
  const connected = await page.evaluate(() => ({ access: localStorage.getItem(STORAGE_KEY + '::userDrive'), asked: window.__scopeRequests.slice(-1)[0], sub: document.getElementById('gdrive-sub').textContent, prompt: userDrivePromptText(getActiveChat()) }));
  check('connecting asks Google only for drive.readonly', connected.access === 'read' && connected.asked.includes(READ) && !connected.asked.split(' ').includes(WRITE), connected);
  check('the + menu shows it on in this chat, read-only, and the model is told', /Activo en este chat · solo lectura/.test(connected.sub) && /drive_search/.test(connected.prompt), connected);
  await page.keyboard.press('Escape');

  // 3. Search and read.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'drive_search', args: { query: 'física' } }] }, { text: '', tools: [{ name: 'drive_read', args: { id: 'https://docs.google.com/document/d/doc1/edit' } }] }, { text: 'Ya lo he leído.' }));
  await send(page, '¿Qué pone en mis apuntes de física?');
  await idle(page, 30000);
  const reads = await page.evaluate(() => window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool').map((m) => String(m.content)));
  check('drive_search finds by name and content', /Apuntes de física · id doc1/.test(reads[0]) && queries.some((q) => /fullText contains 'física'/.test(q)), reads[0]);
  check('drive_read takes a link and exports a Google Doc as text', /energía cinética/.test(reads[1]), reads[1]);

  // 4. Every change asks, also in «Acceso total», once per file; the first
  // approved one asks Google for write access.
  await page.evaluate(() => { getActiveChat().approvalMode = 'full'; renderApprovalUi(); });
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'drive_edit_file', args: { id: 'txt1', find: '- leer tema 3', replace: '- leer tema 3 ✓' } }] }, { text: '', tools: [{ name: 'drive_edit_file', args: { id: 'txt2', find: 'hola mundo', replace: 'hola Drive' } }] }, { text: 'Hecho.' }));
  await send(page, 'Marca el tema 3 como leído y cambia notas.txt');
  const first = await page.waitForSelector('.dock-approve', { timeout: 20000 }).then(() => page.evaluate(() => document.querySelector('.dock-approve').innerText), () => '');
  const writesBeforeOk = writes.length;
  await page.click('.dock-approve [data-dock="approve"]');
  await page.waitForFunction(() => !document.querySelector('.dock-approve') || !/lista\.md/.test(document.querySelector('.dock-approve').innerText), null, { timeout: 20000 });
  const second = await page.waitForSelector('.dock-approve', { timeout: 20000 }).then(() => page.evaluate(() => document.querySelector('.dock-approve').innerText), () => '');
  await page.click('.dock-approve [data-dock="reject"]');
  await idle(page, 30000);
  const afterEdits = await page.evaluate(() => ({ access: localStorage.getItem(STORAGE_KEY + '::userDrive'), asked: window.__scopeRequests.slice(-1)[0], tool: String(window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool').slice(-1)[0].content) }));
  check('in «Acceso total» a Drive change still asks, naming the file and the lines', /Editar en Drive: lista\.md/.test(first) && /\+1/.test(first) && writesBeforeOk === 0, first.slice(0, 200));
  check('the first approved change asks Google for write access, then saves only that file', afterEdits.asked.split(' ').includes(WRITE) && afterEdits.access === 'write' && files.txt1.text.includes('leer tema 3 ✓') && writes.join() === 'content:txt1', { afterEdits, writes });
  check('the second file asks again, and «No» changes nothing', /Editar en Drive: notas\.txt/.test(second) && files.txt2.text === 'hola mundo\n' && !writes.includes('content:txt2') && /no ha dado permiso/.test(afterEdits.tool), { second: second.slice(0, 120), tool: afterEdits.tool });

  // 5. Organizing: one action, one file, asked even with write access granted.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'drive_organize', args: { action: 'rename', id: 'txt2', name: 'notas-viejas.txt' } }] }, { text: 'Renombrado.' }));
  await send(page, 'Renombra notas.txt');
  const renameCard = await page.waitForSelector('.dock-approve', { timeout: 20000 }).then(() => page.evaluate(() => document.querySelector('.dock-approve').innerText), () => '');
  await page.click('.dock-approve [data-dock="approve"]');
  await idle(page, 30000);
  check('rename asks again (write access is not a blank cheque) and then renames', /Renombrar en Drive: notas\.txt/.test(renameCard) && files.txt2.name === 'notas-viejas.txt', renameCard.slice(0, 120));

  // 6. Off in this chat: no Drive tools and nothing in the prompt.
  await page.evaluate(() => { getActiveChat().userDrive = false; });
  const off = await page.evaluate(() => ({ tools: userDriveToolsFor(getActiveChat(), null, true).length, prompt: userDrivePromptText(getActiveChat()) }));
  check('turned off in a chat: no Drive tools, nothing in the prompt', off.tools === 0 && off.prompt === '', off);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript|googleapis|accounts\.google/.test(e))));
  await browser.close();
})();
