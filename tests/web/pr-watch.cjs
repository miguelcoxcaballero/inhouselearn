// Autonomous follow-up of pull requests (pr-watch.js + github_watch_prs,
// github_pr_activity, github_comment reply_to, github_update_pull_request),
// against a fake GitHub: the model follows a PR; a reviewer's request becomes
// ONE automatic turn in «Acceso total» (no card), which answers in the code
// thread; the model's own comment never starts another turn; a merge leaves a
// note in the chat and stops following without any model request; in «Auto»
// a review only leaves a note.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

const UP = 'boyko/AnyPS5';
const pr = { number: 7, title: 'feat(libc): implement x', state: 'open', merged: false, html_url: 'https://github.com/boyko/AnyPS5/pull/7', head: { label: 'tester:feat/x', sha: 'c'.repeat(40) }, base: { ref: 'main' } };
const codeComments = [];
const issueComments = [];
const reviews = [];
const replies = [];
const patches = [];

async function github(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = decodeURIComponent(url.pathname);
  const json = (obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, body: '' });
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  let m;
  if (p === '/user') return json({ login: 'tester' });
  if (p === '/repos/' + UP) return json({ name: 'AnyPS5', full_name: UP, default_branch: 'main', private: false });
  if (p === '/repos/' + UP + '/pulls/7' && req.method() === 'PATCH') { patches.push(body); Object.assign(pr, body); return json(pr); }
  if (p === '/repos/' + UP + '/pulls/7') return json(pr);
  if (p === '/repos/' + UP + '/pulls/7/reviews') return json(reviews);
  if ((m = /^\/repos\/boyko\/AnyPS5\/pulls\/7\/comments\/(\d+)\/replies$/.exec(p)) && req.method() === 'POST') {
    const comment = { id: 900 + replies.length, user: { login: 'tester', type: 'User' }, path: 'src/x.cpp', line: 3, in_reply_to_id: Number(m[1]), body: body.body, created_at: new Date().toISOString(), html_url: pr.html_url + '#r' + (900 + replies.length) };
    replies.push({ to: Number(m[1]), body: body.body });
    codeComments.push(comment);
    return json(comment, 201);
  }
  if (p === '/repos/' + UP + '/pulls/7/comments') return json(codeComments);
  if (p === '/repos/' + UP + '/issues/7/comments') return json(issueComments);
  if (p.startsWith('/repos/' + UP + '/commits/') && p.endsWith('/check-runs')) return json({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
  return json({ message: 'Not mocked: ' + req.method() + ' ' + p }, 404);
}

const userTexts = (page) => page.evaluate(() => window.__requests.map((r) => r.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).pop() || ''));
const lastTool = (page) => page.evaluate(() => { const tools = window.__requests.slice(-1)[0].messages.filter((m) => m.role === 'tool'); return String(tools[tools.length - 1].content); });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  await page.route('https://api.github.com/**', github);
  await page.click('#plus-btn');
  await page.click('#github-btn');
  await page.waitForSelector('#confirm-input:not(.hidden)');
  await page.fill('#confirm-input', 'ghp_classic_test');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => getActiveChat().github === true);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { getActiveChat().approvalMode = 'full'; renderApprovalUi(); });

  await page.evaluate(() => window.__replies.push({ text: 'Hola.' }));
  await send(page, 'hola');
  await idle(page);
  const tools = await page.evaluate(() => (window.__requests.slice(-1)[0].tools || []).map((t) => t.function.name));
  if (!tools.includes('github_watch_prs')) {
    console.log('SKIP vendor/pi-engine.js does not have github_watch_prs yet (rebuilt by the Engine workflow)');
    await browser.close();
    return;
  }
  check('the model gets the follow-up tools and is told how to use them', ['github_pr_activity', 'github_update_pull_request', 'github_comment'].every((name) => tools.includes(name)) && await page.evaluate(() => /github_watch_prs/.test(githubPromptText(getActiveChat()))));

  // 1. Follow the PR.
  await page.evaluate((up) => window.__replies.push({ text: '', tools: [{ name: 'github_watch_prs', args: { add: [{ repo: up, number: 7 }] } }] }, { text: 'Lo sigo.' }), UP);
  await send(page, 'Sigue el PR 7');
  await idle(page);
  let out = await lastTool(page);
  const stored = await page.evaluate(() => InhousePrWatch.list());
  check('github_watch_prs stores the PR for this chat and says it will work on its own', stored.length === 1 && stored[0].repo === UP && stored[0].number === 7 && /En seguimiento \(1\): boyko\/AnyPS5#7/.test(out) && /Acceso total/.test(out), { stored, out });
  const turnCtx = await page.evaluate(() => githubTurnText(getActiveChat()));
  check('each turn knows which PRs are followed', /PR en seguimiento desde este chat: boyko\/AnyPS5#7/.test(turnCtx), turnCtx);

  // 2. Nothing new: a look starts no turn.
  const before = await page.evaluate(() => window.__requests.length);
  await page.evaluate(() => InhousePrWatch.tick());
  await page.waitForTimeout(800);
  check('a look with nothing new costs no model request', await page.evaluate(() => window.__requests.length) === before);

  // 3. A reviewer asks for a change: one automatic turn, answered in the code thread, no card.
  const now = new Date(Date.now() + 1000).toISOString();
  reviews.push({ id: 31, user: { login: 'maint', type: 'User' }, state: 'CHANGES_REQUESTED', body: 'Please drop the two assertions.', submitted_at: now, html_url: pr.html_url + '#pr-31' });
  codeComments.push({ id: 55, user: { login: 'maint', type: 'User' }, path: 'src/x.cpp', line: 12, body: 'This check is not implemented yet.', created_at: now, html_url: pr.html_url + '#r55' });
  await page.evaluate((up) => window.__replies.push(
    { text: '', tools: [{ name: 'github_pr_activity', args: { repo: up, number: 7 } }] },
    { text: '', tools: [{ name: 'github_comment', args: { repo: up, number: 7, reply_to: 55, body: 'Done, removed in abc1234.' } }, { name: 'github_update_pull_request', args: { repo: up, number: 7, body: 'Updated description' } }] },
    { text: 'Pedían quitar dos comprobaciones; hecho y respondido.' }
  ), UP);
  await page.evaluate(() => InhousePrWatch.tick());
  await page.waitForFunction(() => appState.busy, null, { timeout: 15000 }).catch(() => {});
  const asked = await page.evaluate(() => !!document.querySelector('.dock-approve'));
  await idle(page, 40000);
  const texts = await userTexts(page);
  const auto = texts.filter((text) => /Seguimiento automático de PR/.test(text));
  check('a review becomes one automatic turn with the reviewer, the request and the comment id', auto.length >= 1 && /@maint/.test(auto[0]) && /CHANGES_REQUESTED/.test(auto[0]) && /drop the two assertions/.test(auto[0]) && /id 55/.test(auto[0]) && /no lo ha escrito el usuario/.test(auto[0]), auto[0] && auto[0].slice(0, 600));
  const activity = await page.evaluate(() => { const r = window.__requests.find((req) => req.messages.some((m) => m.role === 'tool' && /Comentarios en el código/.test(String(m.content)))); return r ? String(r.messages.filter((m) => m.role === 'tool').pop().content) : ''; });
  check('github_pr_activity reads the review, the code comment with its id and the checks', /CHANGES_REQUESTED/.test(activity) && /id 55/.test(activity) && /src\/x\.cpp:12/.test(activity) && /build: success/.test(activity), activity.slice(0, 500));
  check('in «Acceso total» the reply goes to the code thread and the description is updated without a card', !asked && replies.length === 1 && replies[0].to === 55 && patches.length === 1 && patches[0].body === 'Updated description', { asked, replies, patches });

  // 4. The model's own reply never starts another turn.
  const afterTurn = await page.evaluate(() => window.__requests.length);
  await page.evaluate(() => InhousePrWatch.tick());
  await page.waitForTimeout(1000);
  check('the user\'s own comments (the model\'s replies) start no new turn', await page.evaluate(() => window.__requests.length) === afterTurn);

  // 5. Merged: a note in the chat, no model request, no longer followed.
  pr.merged = true; pr.state = 'closed'; pr.merged_by = { login: 'maint' };
  await page.evaluate(() => InhousePrWatch.tick());
  await page.waitForTimeout(800);
  const merged = await page.evaluate(() => ({ list: InhousePrWatch.list().length, note: (getActiveChat().messages.filter((m) => m.prWatch).pop() || {}).content || '', thread: document.getElementById('thread').innerText }));
  check('a merge leaves a note in its chat and stops following it, with no model request', merged.list === 0 && /PR fusionado/.test(merged.note) && /@maint/.test(merged.note) && /PR fusionado/.test(merged.thread) && await page.evaluate(() => window.__requests.length) === afterTurn, merged);

  // 6. In «Auto» a review only leaves a note.
  pr.merged = false; pr.state = 'open';
  await page.evaluate((up) => { getActiveChat().approvalMode = 'auto'; InhousePrWatch.add(getActiveChat().id, up, 7); }, UP);
  issueComments.push({ id: 77, user: { login: 'other', type: 'User' }, body: 'Could you rebase?', created_at: new Date(Date.now() + 2000).toISOString(), html_url: pr.html_url + '#c77' });
  await page.evaluate(() => { const list = JSON.parse(localStorage.getItem('inhouse-learn-pr-watch')); list[0].since = new Date(Date.now() - 600000).toISOString(); localStorage.setItem('inhouse-learn-pr-watch', JSON.stringify(list)); });
  await page.evaluate(() => InhousePrWatch.tick());
  await page.waitForTimeout(800);
  const plain = await page.evaluate(() => (getActiveChat().messages.filter((m) => m.prWatch).pop() || {}).content || '');
  check('outside «Acceso total» a comment only leaves a note that says how to make it automatic', /Novedades en tu PR/.test(plain) && /@other/.test(plain) && /Acceso total/.test(plain) && await page.evaluate(() => window.__requests.length) === afterTurn, plain);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
