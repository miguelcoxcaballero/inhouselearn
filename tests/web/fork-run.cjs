// Contributing to someone else's project from the chat, against a fake GitHub:
// github_fork asks (a new repository), creates the fork and waits for it, and a
// second call reuses it and brings it up to date; github_run refuses prepared
// but unpushed changes, runs in «Auto» without a card through run.yml in
// inhouselearn (repo, ref, packages, submodules passed on) and reports the exit
// code, the error lines and where the whole log is; a pull request from the
// fork goes to the original with owner:branch, and when the token may not open
// it there the model gets a link that opens it already filled in.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

const LEARN = 'miguelcoxcaballero/inhouselearn';
const UP = 'boyko/AnyPS5';
const FORK = 'tester/AnyPS5';
let forked = false;
const forkPosts = [];
let merges = 0;
const runs = [];
const results = new Map();
const pulls = [];

async function github(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = decodeURIComponent(url.pathname);
  const json = (obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (req.headers().authorization !== 'Bearer github_pat_test') return json({ message: 'Bad credentials' }, 401);
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  let m;
  if (p === '/user') return json({ login: 'tester' });
  if (p === '/repos/' + UP) return json({ name: 'AnyPS5', full_name: UP, default_branch: 'main', private: false });
  if (p === '/repos/' + FORK) return forked ? json({ name: 'AnyPS5', full_name: FORK, default_branch: 'main', private: false, fork: true, parent: { full_name: UP }, source: { full_name: UP } }) : json({ message: 'Not Found' }, 404);
  if (p === '/repos/' + LEARN) return json({ name: 'inhouselearn', full_name: LEARN, default_branch: 'main', private: false });
  if (p === '/repos/' + UP + '/forks' && req.method() === 'POST') { forkPosts.push(body); forked = true; return json({ name: 'AnyPS5', full_name: FORK, default_branch: 'main' }, 202); }
  if (p === '/repos/' + FORK + '/merge-upstream' && req.method() === 'POST') { merges++; return json({ message: 'Successfully fetched and fast-forwarded from upstream', merge_type: 'fast-forward', base_branch: UP + ':main' }); }
  if ((m = /^\/repos\/tester\/AnyPS5\/git\/ref\/heads\/(.+)$/.exec(p))) return forked ? json({ object: { sha: 'a'.repeat(40) } }) : json({ message: 'Not Found' }, 404);
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/.exec(p)) && req.method() === 'POST') {
    const id = runs.length + 1;
    runs.push({ id, repo: m[1], workflow: m[2], inputs: body.inputs, ref: body.ref, status: 'in_progress', conclusion: null, polls: 0, created_at: new Date().toISOString(), head_sha: 'b'.repeat(40), html_url: 'https://github.com/' + m[1] + '/actions/runs/' + id });
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' });
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/runs$/.exec(p))) return json({ workflow_runs: runs.filter((run) => run.repo === m[1] && run.workflow === m[2]).reverse() });
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(p))) {
    const run = runs[Number(m[2]) - 1];
    return json({ jobs: [{ id: 700 + run.id, name: 'run', status: run.status, conclusion: run.conclusion, steps: [{ name: 'Run the command', status: run.status, conclusion: run.conclusion }] }] });
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)\/annotations$/.exec(p))) return json([{ annotation_level: 'failure', message: 'The command ended with: 1' }]);
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(p))) {
    const run = runs[Number(m[2]) - 1];
    // Each run finishes on its second look: the build fails, like a real compile error.
    if (run.status !== 'completed' && ++run.polls >= 2) {
      run.status = 'completed';
      run.conclusion = 'failure';
      results.set(run.inputs.id, {
        id: run.inputs.id, repo: run.inputs.repo, ref: run.inputs.ref, os: run.inputs.os, sha: 'b'.repeat(40), runner: 'Linux X64',
        exit_code: 1, seconds: 94, lines: 1200, truncated: false, errors_total: 2,
        errors: [{ line: 1180, text: 'src/libSceAudioIn/Export.cpp:42:5: error: expected \';\' before \'}\' token' }, { line: 1190, text: 'ninja: build stopped: subcommand failed.' }],
        tail: '[311/1200] Building CXX object src/libSceAudioIn/Export.cpp.o\nFAILED: src/libSceAudioIn/Export.cpp.o\nninja: build stopped: subcommand failed.'
      });
    }
    return json(run);
  }
  if ((m = /^\/repos\/miguelcoxcaballero\/inhouselearn\/contents\/(run-[^/]+)\/result\.json$/.exec(p)) && url.searchParams.get('ref') === 'runs') {
    return results.has(m[1]) ? json({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(results.get(m[1]))).toString('base64'), sha: 'r', size: 10 }) : json({ message: 'Not Found' }, 404);
  }
  if (p.startsWith('/repos/' + UP + '/compare/')) return json({ files: [{ filename: 'src/libSceAudioIn/Export.cpp', status: 'modified', additions: 12, deletions: 2 }] });
  if (p === '/repos/' + UP + '/pulls' && req.method() === 'POST') { pulls.push(body); return json({ message: 'Resource not accessible by personal access token' }, 403); }
  return json({ message: 'Not mocked: ' + req.method() + ' ' + p }, 404);
}

const lastTool = (page) => page.evaluate(() => { const tools = window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool'); return String(tools[tools.length - 1].content); });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  await page.route('https://api.github.com/**', github);
  await page.click('#plus-btn');
  await page.click('#github-btn');
  await page.waitForSelector('#confirm-input:not(.hidden)');
  await page.fill('#confirm-input', 'github_pat_test');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => getActiveChat().github === true);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { getActiveChat().approvalMode = 'auto'; renderApprovalUi(); });

  await page.evaluate(() => window.__replies.push({ text: 'Hola.' }));
  await send(page, 'hola');
  await idle(page);
  const tools = await page.evaluate(() => (window.__requests.slice(-1)[0].tools || []).map((t) => t.function.name));
  if (!tools.includes('github_fork')) {
    // The commit that adds the tools runs before the Engine workflow rebuilds vendor/pi-engine.js.
    console.log('SKIP vendor/pi-engine.js does not have github_fork yet (rebuilt by the Engine workflow)');
    await browser.close();
    return;
  }
  const prompt = await page.evaluate(() => githubPromptText(getActiveChat()));
  check('the model knows how to build, test and contribute through a fork', /github_run/.test(prompt) && /github_fork/.test(prompt) && /head_repo/.test(prompt) && tools.includes('github_run'));

  // 1. Fork: a card (a new repository), nothing created before «Hacer fork».
  await page.evaluate((up) => window.__replies.push({ text: '', tools: [{ name: 'github_fork', args: { repo: up } }] }, { text: 'Fork hecho.' }), UP);
  await send(page, 'Haz un fork de AnyPS5');
  await page.waitForSelector('.dock-approve', { timeout: 20000 });
  const card = await page.evaluate(() => ({ title: document.querySelector('.dock-approve-head b').textContent, msg: document.querySelector('.dock-approve-msg').textContent }));
  check('github_fork asks first, even in «Auto», and creates nothing before', card.title === 'Hacer fork' && /boyko\/AnyPS5 → tester\/AnyPS5/.test(card.msg) && forkPosts.length === 0, { card, forkPosts });
  await page.click('.dock-approve [data-dock="approve"]');
  await idle(page, 40000);
  let out = await lastTool(page);
  check('the fork is created with the default branch only and reported with the next steps', forkPosts.length === 1 && forkPosts[0].default_branch_only === true && /Fork creado: tester\/AnyPS5/.test(out) && /head_repo = tester\/AnyPS5/.test(out), { forkPosts, out: out.slice(0, 300) });

  // 2. Again: the existing fork is reused and brought up to date, without a card.
  await page.evaluate((up) => window.__replies.push({ text: '', tools: [{ name: 'github_fork', args: { repo: up } }] }, { text: 'Al día.' }), UP);
  await send(page, 'Pon al día el fork');
  await idle(page, 30000);
  out = await lastTool(page);
  check('an existing fork is reused and synced with the original', forkPosts.length === 1 && merges === 1 && /Ya tienes el fork tester\/AnyPS5/.test(out) && /al día/.test(out), { merges, out: out.slice(0, 300) });

  // 3. Prepared but not pushed: github_run refuses (it runs what is on GitHub).
  await page.evaluate((fork) => window.__replies.push(
    { text: '', tools: [{ name: 'github_write_files', args: { repo: fork, branch: 'feat/audio', files: [{ path: 'src/a.cpp', content: 'int a;\n' }] } }] },
    { text: '', tools: [{ name: 'github_run', args: { repo: fork, ref: 'feat/audio', command: 'cmake -S . -B build' } }] },
    { text: '', tools: [{ name: 'github_discard', args: { repo: fork, branch: 'feat/audio' } }] },
    { text: 'Primero lo subo.' }
  ), FORK);
  await send(page, 'Compila sin subir');
  await idle(page, 30000);
  const refused = await page.evaluate(() => { const tools = window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool'); return String(tools[tools.length - 2].content); });
  check('github_run refuses prepared changes that are not pushed, and runs nothing', /sin subir/.test(refused) && runs.length === 0, refused.slice(0, 200));

  // 4. A real run in «Auto»: no card, run.yml in inhouselearn, the failure reported with its errors.
  const command = 'cmake -S . -B build -G Ninja -DCMAKE_CXX_COMPILER_LAUNCHER=ccache && cmake --build build -j4';
  await page.evaluate((args) => window.__replies.push({ text: '', tools: [{ name: 'github_run', args }] }, { text: 'Falla al compilar.' }), { repo: FORK, ref: 'feat/audio', command, packages: 'ninja-build ccache libsdl2-dev', submodules: 'recursive' });
  await send(page, 'Compila la rama feat/audio');
  await page.waitForTimeout(1500);
  const asked = await page.evaluate(() => !!document.querySelector('.dock-approve'));
  await idle(page, 90000);
  out = await lastTool(page);
  const run = runs[0] || {};
  const inputs = run.inputs || {};
  check('github_run goes ahead in «Auto» and dispatches run.yml in inhouselearn with every input', !asked && runs.length === 1 && run.repo === LEARN && run.workflow === 'run.yml' && run.ref === 'main' && inputs.repo === FORK && inputs.ref === 'feat/audio' && inputs.command === command && inputs.packages === 'ninja-build ccache libsdl2-dev' && inputs.submodules === 'recursive' && inputs.os === 'ubuntu-24.04' && inputs.minutes === '30' && /^run-\d{8}-\d{6}-/.test(inputs.id), { asked, run });
  check('a failed build reports the exit code, the error lines, the tail and where the whole log is', /FALLÓ con código 1/.test(out) && /1 min 34 s/.test(out) && /Export\.cpp:42:5: error/.test(out) && /FAILED: src\/libSceAudioIn/.test(out) && /ref=runs path=run-[^ ]+\/log\.txt/.test(out), out.slice(0, 700));
  const live = await page.evaluate(() => { const last = document.querySelector('#thread .message:last-child'); return last ? last.textContent : ''; });
  check('the thread names the step in Spanish', /Compilado y probado/.test(live), live.slice(0, 300));

  // 5. Pull request from the fork: owner:branch on the original; refused token → a filled-in link.
  const prBody = '## Tested\nBuilt with github_run.\n\nAI-assisted: yes';
  await page.evaluate((args) => window.__replies.push({ text: '', tools: [{ name: 'github_create_pull_request', args }] }, { text: 'Aquí tienes el enlace.' }), { repo: UP, head: 'feat/audio', head_repo: FORK, title: 'feat(libSceAudioIn): implement sceAudioInSetUsbGain', body: prBody });
  await send(page, 'Abre el PR');
  await page.waitForSelector('.dock-approve', { timeout: 20000 });
  const prCard = await page.evaluate(() => ({ title: document.querySelector('.dock-approve-head b').textContent, msg: document.querySelector('.dock-approve-msg').textContent, files: document.querySelector('.dock-approve-files') ? document.querySelector('.dock-approve-files').innerText : '' }));
  check('the PR card shows fork → original and the files that change', prCard.title === 'Abrir pull request' && /tester\/AnyPS5 feat\/audio → boyko\/AnyPS5 main/.test(prCard.msg) && /Export\.cpp/.test(prCard.files), prCard);
  await page.click('.dock-approve [data-dock="approve"]');
  await idle(page, 30000);
  out = await lastTool(page);
  check('the PR is asked of the original with owner:branch and maintainers allowed to edit', pulls.length === 1 && pulls[0].head === 'tester:feat/audio' && pulls[0].base === 'main' && pulls[0].maintainer_can_modify === true, pulls);
  const link = (out.match(/https:\/\/github\.com\/boyko\/AnyPS5\/compare\/\S+/) || [''])[0];
  check('a token that may not open it there gets a link with the title and the description', link.startsWith('https://github.com/boyko/AnyPS5/compare/main...tester:feat/audio?expand=1&title=feat') && decodeURIComponent(link).includes('AI-assisted: yes'), link);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
