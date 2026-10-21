// GitHub connector against a fake GitHub API: connect with a token, the model
// reads a file, edits it on a new branch (the user approves the commit and
// sees what changes), opens a PR; a rejected commit changes nothing.
const { chromium } = require('playwright');
const crypto = require('crypto');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

const sha = (text) => crypto.createHash('sha1').update(String(text) + Math.random()).digest('hex');
const blobs = new Map();
const trees = new Map(); // sha -> { path: blobSha }
const commits = new Map(); // sha -> treeSha
const refs = new Map();
const pulls = [];
function seed() {
  const files = { 'README.md': '# Demo\n\nHola mundo.\n', 'src/app.js': 'console.log(1);\n' };
  const tree = {};
  Object.entries(files).forEach(([path, content]) => { const s = sha(content); blobs.set(s, content); tree[path] = s; });
  const treeSha = sha('tree'); trees.set(treeSha, tree);
  const commitSha = sha('commit'); commits.set(commitSha, treeSha);
  refs.set('main', commitSha);
}
const filesAt = (ref) => { const commit = refs.get(ref) || ref; return trees.get(commits.get(commit)) || {}; };

async function github(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = decodeURIComponent(url.pathname);
  const json = (obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(obj) });
  const auth = req.headers().authorization;
  if (auth !== 'Bearer github_pat_test') return json({ message: 'Bad credentials' }, 401);
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  let m;
  if (p === '/user') return json({ login: 'tester' });
  if (p === '/user/repos') return json([{ full_name: 'tester/demo', default_branch: 'main', private: true, description: 'Demo' }]);
  if (p === '/repos/tester/demo') return json({ default_branch: 'main' });
  if ((m = /^\/repos\/tester\/demo\/git\/ref\/heads\/(.+)$/.exec(p))) return refs.has(m[1]) ? json({ object: { sha: refs.get(m[1]) } }) : json({ message: 'Not Found' }, 404);
  if ((m = /^\/repos\/tester\/demo\/git\/trees\/(.+)$/.exec(p)) && req.method() === 'GET') return json({ tree: Object.keys(filesAt(m[1])).map((path) => ({ path, type: 'blob', size: blobs.get(filesAt(m[1])[path]).length })), truncated: false });
  if ((m = /^\/repos\/tester\/demo\/contents\/(.+)$/.exec(p))) {
    const files = filesAt(url.searchParams.get('ref') || 'main');
    if (!files[m[1]]) return json({ message: 'Not Found' }, 404);
    return json({ type: 'file', encoding: 'base64', content: Buffer.from(blobs.get(files[m[1]])).toString('base64'), sha: files[m[1]], size: blobs.get(files[m[1]]).length });
  }
  if (p === '/repos/tester/demo/git/refs' && req.method() === 'POST') { refs.set(body.ref.replace('refs/heads/', ''), body.sha); return json({ ref: body.ref }); }
  if ((m = /^\/repos\/tester\/demo\/git\/commits\/(.+)$/.exec(p))) return json({ sha: m[1], tree: { sha: commits.get(m[1]) } });
  if (p === '/repos/tester/demo/git/blobs') { const s = sha(body.content); blobs.set(s, body.content); return json({ sha: s }); }
  if (p === '/repos/tester/demo/git/trees') {
    const tree = Object.assign({}, trees.get(body.base_tree));
    body.tree.forEach((item) => { if (item.sha === null) delete tree[item.path]; else tree[item.path] = item.sha; });
    const s = sha('tree'); trees.set(s, tree); return json({ sha: s });
  }
  if (p === '/repos/tester/demo/git/commits') { const s = sha('commit'); commits.set(s, body.tree); return json({ sha: s }); }
  if ((m = /^\/repos\/tester\/demo\/git\/refs\/heads\/(.+)$/.exec(p)) && req.method() === 'PATCH') { refs.set(m[1], body.sha); return json({ object: { sha: body.sha } }); }
  if ((m = /^\/repos\/tester\/demo\/compare\/(.+)\.\.\.(.+)$/.exec(p))) {
    const a = filesAt(m[1]); const b = filesAt(m[2]);
    return json({ files: Object.keys(b).filter((path) => a[path] !== b[path]).map((path) => ({ filename: path, status: a[path] ? 'modified' : 'added', additions: 1, deletions: a[path] ? 1 : 0 })) });
  }
  if (p === '/repos/tester/demo/pulls' && req.method() === 'POST') { pulls.push(body); return json({ number: pulls.length, html_url: 'https://github.com/tester/demo/pull/' + pulls.length }); }
  return json({ message: 'Not mocked: ' + req.method() + ' ' + p }, 404);
}

(async () => {
  seed();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1100, height: 850 } });
  await page.route('https://api.github.com/**', github);

  // Connect from the + menu.
  await page.click('#plus-btn');
  await page.click('#github-btn');
  await page.waitForSelector('#confirm-input:not(.hidden)');
  await page.fill('#confirm-input', 'github_pat_test');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => getActiveChat().github === true);
  await page.click('#plus-btn');
  const ui = await page.evaluate(() => ({ sub: document.getElementById('github-sub').textContent, active: document.getElementById('github-btn').classList.contains('active'), account: !document.getElementById('github-account-btn').classList.contains('hidden') }));
  check('connect: token checked, chat switched on, account shown', /Activo en este chat · @tester/.test(ui.sub) && ui.active && ui.account, ui);
  await page.screenshot({ path: SCRATCH + '/github-menu.png' });
  await page.keyboard.press('Escape');

  // The model reads, edits on a new branch and opens a PR; the user approves twice.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'github_read_file', args: { repo: 'tester/demo', path: 'README.md' } }] },
    { text: '', tools: [{ name: 'github_edit_file', args: { repo: 'tester/demo', branch: 'fix/saludo', path: 'README.md', old_text: 'Hola mundo.', new_text: 'Hola, mundo.', message: 'README: coma en el saludo' } }] },
    { text: '', tools: [{ name: 'github_create_pull_request', args: { repo: 'tester/demo', head: 'fix/saludo', title: 'Coma en el saludo', body: 'Arregla la puntuación.' } }] },
    { text: 'Listo: PR #1 https://github.com/tester/demo/pull/1' }
  ));
  await send(page, 'Pon una coma en el saludo del README de tester/demo y abre un PR');
  await page.waitForSelector('#confirm-backdrop:not(.hidden)', { timeout: 20000 });
  const firstConfirm = await page.evaluate(() => ({ title: document.getElementById('confirm-title').textContent, message: document.getElementById('confirm-message').textContent, detail: document.getElementById('confirm-detail').innerText }));
  await page.screenshot({ path: SCRATCH + '/github-confirm.png' });
  check('commit approval shows repo, new branch, message and the file with +/−', firstConfirm.title === 'Commit en GitHub' && /tester\/demo · rama fix\/saludo \(nueva, desde main\)/.test(firstConfirm.message) && /README: coma en el saludo/.test(firstConfirm.message) && /modificado\s*README\.md\s*\+1\s*−1/.test(firstConfirm.detail), firstConfirm);
  await page.click('#confirm-ok');
  await page.waitForFunction(() => document.getElementById('confirm-title').textContent === 'Abrir pull request' && !document.getElementById('confirm-backdrop').classList.contains('hidden'), null, { timeout: 20000 });
  await page.click('#confirm-ok');
  await idle(page, 30000);
  const readme = blobs.get(filesAt('fix/saludo')['README.md']);
  const mainReadme = blobs.get(filesAt('main')['README.md']);
  check('commit lands on the new branch only; PR opened', readme === '# Demo\n\nHola, mundo.\n' && mainReadme === '# Demo\n\nHola mundo.\n' && pulls.length === 1 && pulls[0].head === 'fix/saludo' && pulls[0].base === 'main', { readme, mainReadme, pulls });
  const prompt = await page.evaluate(() => { const r = window.__requests[0]; return { sys: (r.messages.find((m) => m.role === 'system') || {}).content || '', tools: (r.tools || []).map((t) => t.function.name).filter((n) => /^github_/.test(n)) }; });
  check('model gets the GitHub tools and instructions', prompt.tools.length === 9 && /GitHub \(cuenta @tester\)/.test(prompt.sys), prompt.tools);

  // A rejected commit changes nothing and the model is told so.
  const before = refs.get('fix/saludo');
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'github_commit_files', args: { repo: 'tester/demo', branch: 'fix/saludo', message: 'Borrar app', delete: ['src/app.js'] } }] },
    { text: 'Vale, no lo borro.' }
  ));
  await send(page, 'Borra src/app.js');
  await page.waitForSelector('#confirm-backdrop:not(.hidden)', { timeout: 20000 });
  await page.click('#confirm-cancel');
  await idle(page, 30000);
  const rejected = await page.evaluate(() => (window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool').slice(-1)[0] || {}).content);
  check('rejected commit: branch untouched and the model hears it', refs.get('fix/saludo') === before && /no ha aprobado/.test(String(rejected)), String(rejected).slice(0, 120));

  // A chat without the switch gets no GitHub tools.
  await page.click('#hamburger-btn'); await page.click('#new-chat-btn');
  await page.evaluate(() => window.__replies.push({ text: 'ok' }));
  await send(page, 'hola'); await idle(page);
  const plain = await page.evaluate(() => (window.__requests.slice(-1)[0].tools || []).map((t) => t.function.name).filter((n) => /^github_/.test(n)).length);
  check('chats without GitHub switched on do not get the tools', plain === 0, plain);
  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
