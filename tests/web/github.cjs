// GitHub connector against a fake GitHub API. Changes are PREPARED (no upload,
// no question), reads and grep see them, and they go up in ONE commit with ONE
// approval in the card above the composer; two pushes in a row chain their
// commits (the real API's Cache-Control: max-age=60 used to make the second one
// fail with "not a fast forward"; Playwright routes skip the HTTP cache, so this
// checks the parent chain, while the fix is cache: 'no-store' in github.js);
// search falls back to grep; CI status; rejecting keeps the prepared changes,
// and the pending card can upload or discard them.
const { chromium } = require('playwright');
const crypto = require('crypto');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

const sha = (text) => crypto.createHash('sha1').update(String(text) + Math.random()).digest('hex');
const blobs = new Map();
const trees = new Map(); // sha -> { path: blobSha }
const commits = new Map(); // sha -> { tree, parent }
const refs = new Map();
const pulls = [];
let commitPosts = 0;
let searchCalls = 0;
function seed() {
  const files = {
    'README.md': '# Demo\n\nHola mundo.\n',
    'src/app.js': 'function saludo() {\n  return "hola";\n}\nconsole.log(saludo());\n',
    'AGENTS.md': '# Reglas\n\nEscribe en español.\n'
  };
  const tree = {};
  Object.entries(files).forEach(([path, content]) => { const s = sha(content); blobs.set(s, content); tree[path] = s; });
  const treeSha = sha('tree'); trees.set(treeSha, tree);
  const commitSha = sha('commit'); commits.set(commitSha, { tree: treeSha, parent: null });
  refs.set('main', commitSha);
}
const filesAt = (ref) => { const commit = refs.get(ref) || ref; return trees.get((commits.get(commit) || {}).tree) || {}; };
const commitsOn = (branch) => { let n = 0; let c = refs.get(branch); while (c && c !== refs.get('main')) { n++; c = commits.get(c).parent; } return n; };

async function github(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = decodeURIComponent(url.pathname);
  // Like the real API: GETs may be cached by the browser for 60 s.
  const json = (obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'cache-control': 'private, max-age=60', 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (req.headers().authorization !== 'Bearer github_pat_test') return json({ message: 'Bad credentials' }, 401);
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  let m;
  if (p === '/user') return json({ login: 'tester' });
  if (p === '/user/repos') return json([{ full_name: 'tester/demo', default_branch: 'main', private: true, description: 'Demo' }]);
  if (p === '/repos/tester/demo') return json({ default_branch: 'main' });
  if (p === '/search/code') { searchCalls++; return route.abort('failed'); }
  if ((m = /^\/repos\/tester\/demo\/git\/ref\/heads\/(.+)$/.exec(p))) return refs.has(m[1]) ? json({ object: { sha: refs.get(m[1]) } }) : json({ message: 'Not Found' }, 404);
  if ((m = /^\/repos\/tester\/demo\/git\/trees\/(.+)$/.exec(p)) && req.method() === 'GET') {
    const files = filesAt(m[1]);
    return json({ tree: Object.keys(files).map((path) => ({ path, type: 'blob', sha: files[path], size: blobs.get(files[path]).length })), truncated: false });
  }
  if ((m = /^\/repos\/tester\/demo\/git\/blobs\/(.+)$/.exec(p)) && req.method() === 'GET') return json({ content: Buffer.from(blobs.get(m[1])).toString('base64'), encoding: 'base64' });
  if ((m = /^\/repos\/tester\/demo\/contents\/(.+)$/.exec(p))) {
    const files = filesAt(url.searchParams.get('ref') || 'main');
    if (!files[m[1]]) return json({ message: 'Not Found' }, 404);
    return json({ type: 'file', encoding: 'base64', content: Buffer.from(blobs.get(files[m[1]])).toString('base64'), sha: files[m[1]], size: blobs.get(files[m[1]]).length });
  }
  if (p === '/repos/tester/demo/git/refs' && req.method() === 'POST') { refs.set(body.ref.replace('refs/heads/', ''), body.sha); return json({ ref: body.ref }); }
  if ((m = /^\/repos\/tester\/demo\/git\/commits\/(.+)$/.exec(p))) return json({ sha: m[1], tree: { sha: commits.get(m[1]).tree } });
  if (p === '/repos/tester/demo/git/blobs') { const s = sha(body.content); blobs.set(s, body.content); return json({ sha: s }); }
  if (p === '/repos/tester/demo/git/trees') {
    const tree = Object.assign({}, trees.get(body.base_tree));
    body.tree.forEach((item) => { if (item.sha === null) delete tree[item.path]; else tree[item.path] = item.sha; });
    const s = sha('tree'); trees.set(s, tree); return json({ sha: s });
  }
  if (p === '/repos/tester/demo/git/commits') { commitPosts++; const s = sha('commit'); commits.set(s, { tree: body.tree, parent: body.parents[0] }); return json({ sha: s }); }
  if ((m = /^\/repos\/tester\/demo\/git\/refs\/heads\/(.+)$/.exec(p)) && req.method() === 'PATCH') {
    if (commits.get(body.sha).parent !== refs.get(m[1])) return json({ message: 'Update is not a fast forward' }, 422);
    refs.set(m[1], body.sha); return json({ object: { sha: body.sha } });
  }
  if ((m = /^\/repos\/tester\/demo\/compare\/(.+)\.\.\.(.+)$/.exec(p))) {
    const a = filesAt(m[1]); const b = filesAt(m[2]);
    return json({ files: Object.keys(b).filter((path) => a[path] !== b[path]).map((path) => ({ filename: path, status: a[path] ? 'modified' : 'added', additions: 1, deletions: a[path] ? 1 : 0 })) });
  }
  if (p === '/repos/tester/demo/pulls' && req.method() === 'POST') { pulls.push(body); return json({ number: pulls.length, html_url: 'https://github.com/tester/demo/pull/' + pulls.length }); }
  if (p === '/repos/tester/demo/actions/runs') return json({ workflow_runs: [{ id: 7, workflow_id: 1, name: 'Tests', conclusion: 'failure', status: 'completed', head_sha: refs.get('main'), html_url: 'https://github.com/tester/demo/actions/runs/7' }] });
  if (p === '/repos/tester/demo/actions/runs/7/jobs') return json({ jobs: [{ id: 70, name: 'web', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] });
  if (p === '/repos/tester/demo/check-runs/70/annotations') return json([{ path: '.github', start_line: 1, message: 'FAIL queue: steer delivered' }]);
  return json({ message: 'Not mocked: ' + req.method() + ' ' + p }, 404);
}

const lastTools = (page) => page.evaluate(() => window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool').map((m) => String(m.content)));
const toolOutputs = (page, n) => page.evaluate((k) => window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool').slice(-k).map((m) => String(m.content)), n);

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
  const ui = await page.evaluate(() => ({ sub: document.getElementById('github-sub').textContent, active: document.getElementById('github-btn').classList.contains('active'), approval: !!document.querySelector('#plus-menu #approval-section .plus-approval-option.active') }));
  check('connect: token checked, chat switched on; approval mode lives in the + menu', /Activo en este chat · @tester/.test(ui.sub) && ui.active && ui.approval, ui);
  await page.screenshot({ path: SCRATCH + '/github-menu.png' });
  await page.keyboard.press('Escape');

  // Edit twice + a new file are only prepared; the PR uploads them in one commit, one approval.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'github_edit_file', args: { repo: 'tester/demo', branch: 'fix/saludo', path: 'README.md', old_text: 'Hola mundo.', new_text: 'Hola, mundo.', note: 'README: coma en el saludo' } }] },
    { text: '', tools: [{ name: 'github_edit_file', args: { repo: 'tester/demo', branch: 'fix/saludo', path: 'src/app.js', old_text: 'return "hola";', new_text: 'return "hola, mundo";' } }] },
    { text: '', tools: [{ name: 'github_write_files', args: { repo: 'tester/demo', branch: 'fix/saludo', files: [{ path: 'docs/saludo.md', content: 'Saluda con coma.\n' }] } }] },
    { text: '', tools: [{ name: 'github_grep', args: { repo: 'tester/demo', ref: 'fix/saludo', pattern: 'hola, mundo' } }] },
    { text: '', tools: [{ name: 'github_read_file', args: { repo: 'tester/demo', ref: 'fix/saludo', path: 'README.md' } }] },
    { text: '', tools: [{ name: 'github_create_pull_request', args: { repo: 'tester/demo', head: 'fix/saludo', title: 'Coma en el saludo', body: 'Arregla la puntuación.' } }] },
    { text: 'Listo: PR #1 https://github.com/tester/demo/pull/1' }
  ));
  await send(page, 'Pon una coma en los saludos de tester/demo y abre un PR');
  await page.waitForSelector('.dock-approve', { timeout: 20000 });
  const card = await page.evaluate(() => ({
    title: document.querySelector('.dock-approve-head b').textContent,
    msg: document.querySelector('.dock-approve-msg').textContent,
    files: document.querySelector('.dock-approve-files').innerText,
    fullscreen: !document.getElementById('confirm-backdrop').classList.contains('hidden'),
    aboveComposer: document.getElementById('composer-dock').getBoundingClientRect().bottom <= document.querySelector('.composer-shell').getBoundingClientRect().top + 1,
    live: document.querySelector('.live-now') ? document.querySelector('.live-now').innerText : ''
  }));
  const beforeApproval = { posts: commitPosts, refs: refs.has('fix/saludo') };
  await page.screenshot({ path: SCRATCH + '/github-dock-approve.png' });
  check('nothing uploaded and nothing asked until the PR; then ONE card above the composer, not fullscreen', beforeApproval.posts === 0 && !beforeApproval.refs && card.title === 'Subir y abrir pull request' && !card.fullscreen && card.aboveComposer, { card, beforeApproval });
  check('the card lists every prepared file with +/−, and the thread says it waits for approval', /README\.md\s*\+1\s*−1/.test(card.files) && /src\/app\.js/.test(card.files) && /docs\/saludo\.md/.test(card.files) && /Esperando tu aprobación/.test(card.live), card);
  const prepared = await toolOutputs(page, 5);
  check('reads and grep see the prepared version before it is uploaded', /\[preparado\] src\/app\.js:2:/.test(prepared[3] || '') && /versión preparada/.test(prepared[4] || '') && /Hola, mundo\./.test(prepared[4] || ''), prepared.slice(3).map((t) => t.slice(0, 160)));
  await page.click('.dock-approve [data-dock="approve"]');
  await idle(page, 30000);
  check('one commit on the new branch, main untouched, PR opened', commitsOn('fix/saludo') === 1 && commitPosts === 1 && blobs.get(filesAt('fix/saludo')['README.md']) === '# Demo\n\nHola, mundo.\n' && filesAt('fix/saludo')['docs/saludo.md'] && blobs.get(filesAt('main')['README.md']) === '# Demo\n\nHola mundo.\n' && pulls.length === 1, { commits: commitsOn('fix/saludo'), commitPosts, pulls: pulls.length });
  const finalSteps = await page.evaluate(() => document.querySelector('#thread .message:last-child .tool-steps-summary') ? document.querySelector('#thread .message:last-child .tool-steps-summary').innerText : '');
  check('finished steps keep readable titles', /pasos con herramientas/.test(finalSteps), finalSteps);

  // Two pushes in a row on the same branch (the cached ref used to break the second one).
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'github_edit_file', args: { repo: 'tester/demo', branch: 'fix/saludo', path: 'README.md', old_text: '# Demo', new_text: '# Demo 2' } }] },
    { text: '', tools: [{ name: 'github_push', args: { repo: 'tester/demo', branch: 'fix/saludo', message: 'Título 2' } }] },
    { text: '', tools: [{ name: 'github_edit_file', args: { repo: 'tester/demo', branch: 'fix/saludo', path: 'README.md', old_text: '# Demo 2', new_text: '# Demo 3' } }] },
    { text: '', tools: [{ name: 'github_push', args: { repo: 'tester/demo', branch: 'fix/saludo', message: 'Título 3' } }] },
    { text: 'Hecho.' }
  ));
  await page.evaluate(() => { getActiveChat().approvalMode = 'full'; renderApprovalUi(); });
  await send(page, 'Cambia el título dos veces');
  await idle(page, 30000);
  const pushes = await toolOutputs(page, 4);
  check('two pushes in a row to the same branch chain their commits', commitsOn('fix/saludo') === 3 && /^# Demo 3/.test(blobs.get(filesAt('fix/saludo')['README.md'])) && !pushes.some((t) => /fast forward/.test(t)), { commits: commitsOn('fix/saludo'), pushes: pushes.map((t) => t.slice(0, 80)) });

  // Search index down → direct search; CI status with the failing step and message.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'github_search_code', args: { repo: 'tester/demo', query: 'saludo()' } }] },
    { text: '', tools: [{ name: 'github_ci_status', args: { repo: 'tester/demo' } }] },
    { text: 'Visto.' }
  ));
  await send(page, 'Busca saludo y mira la CI');
  await idle(page, 30000);
  const found = await toolOutputs(page, 2);
  check('code search falls back to grep when GitHub search fails', searchCalls === 1 && /Búsqueda directa/.test(found[0]) && /src\/app\.js:1: function saludo\(\)/.test(found[0]), found[0].slice(0, 200));
  check('CI status shows the failing job, step and message', /Tests · failure/.test(found[1]) && /falla «Run tests»/.test(found[1]) && /FAIL queue: steer delivered/.test(found[1]), found[1].slice(0, 300));

  // Rejected upload: nothing changes, the change stays prepared, the card can discard it.
  await page.evaluate(() => { getActiveChat().approvalMode = 'auto'; renderApprovalUi(); });
  const before = refs.get('fix/saludo');
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'github_write_files', args: { repo: 'tester/demo', branch: 'fix/saludo', delete: ['src/app.js'] } }] },
    { text: '', tools: [{ name: 'github_push', args: { repo: 'tester/demo', branch: 'fix/saludo', message: 'Borrar app' } }] },
    { text: 'Vale, no lo borro.' }
  ));
  await send(page, 'Borra src/app.js');
  await page.waitForSelector('.dock-approve', { timeout: 20000 });
  await page.click('.dock-approve [data-dock="reject"]');
  await idle(page, 30000);
  const rejected = (await toolOutputs(page, 1))[0];
  const stageCard = await page.evaluate(() => document.querySelector('.dock-stage') ? document.querySelector('.dock-stage').innerText : '');
  check('rejected upload: branch untouched, the model hears it, the change stays prepared', refs.get('fix/saludo') === before && /no ha aprobado la subida/.test(rejected) && /1 cambio preparado/.test(stageCard) && /src\/app\.js \(borrar\)/.test(stageCard), { rejected: rejected.slice(0, 100), stageCard });
  await page.screenshot({ path: SCRATCH + '/github-stage-card.png' });
  await page.click('.dock-stage [data-dock="discard"]');
  const cleared = await page.evaluate(() => !document.querySelector('.dock-stage') && !githubStageStore(getActiveChat()).list().length);
  check('«Descartar» drops the prepared change', cleared);

  // Prepared and left by the model: «Subir en un commit» uploads it without asking again.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'github_edit_file', args: { repo: 'tester/demo', branch: 'fix/saludo', path: 'AGENTS.md', old_text: 'Escribe en español.', new_text: 'Escribe en español claro.', note: 'AGENTS: más claro' } }] },
    { text: 'Lo dejo preparado.' }
  ));
  await send(page, 'Prepara un cambio en AGENTS.md');
  await idle(page, 30000);
  await page.click('.dock-stage [data-dock="push"]');
  await page.waitForFunction(() => !document.querySelector('.dock-stage'), null, { timeout: 15000 });
  check('«Subir en un commit» uploads what was left prepared', /claro/.test(blobs.get(filesAt('fix/saludo')['AGENTS.md'])) && commitsOn('fix/saludo') === 4, commitsOn('fix/saludo'));

  // Prompt: tools and workflow.
  const prompt = await page.evaluate(() => { const r = window.__requests[0]; return { sys: (r.messages.find((m) => m.role === 'system') || {}).content || '', tools: (r.tools || []).map((t) => t.function.name).filter((n) => /^github_/.test(n)) }; });
  check('model gets the GitHub tools and the prepare → push workflow', prompt.tools.length === 14 && prompt.tools.includes('github_release_android') && /Prepara TODOS los cambios/.test(prompt.sys) && /github_grep/.test(prompt.sys) && /AGENTS\.md/.test(prompt.sys), prompt.tools);

  // A chat without the switch gets no GitHub tools.
  await page.click('#hamburger-btn'); await page.click('#new-chat-btn');
  await page.evaluate(() => window.__replies.push({ text: 'ok' }));
  await send(page, 'hola'); await idle(page);
  const plain = await page.evaluate(() => (window.__requests.slice(-1)[0].tools || []).map((t) => t.function.name).filter((n) => /^github_/.test(n)).length);
  check('chats without GitHub switched on do not get the tools', plain === 0, plain);
  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
