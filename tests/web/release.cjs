// The app publishes its own APK (github_release_android) against a fake GitHub:
// it asks even in «Acceso total», nothing runs before the user approves, then
// a build of main's exact commit, the signature in youtube-calma with that sha
// and the publish on channel A run in that order, the thread shows what is
// happening, and the result is checked in updates/A.json. A versionCode that
// does not go up, or a «No», stops before any workflow runs; a failing build
// stops before the signature.
const { chromium } = require('playwright');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

const LEARN = 'miguelcoxcaballero/inhouselearn';
const SIGN = 'miguelcoxcaballero/youtube-calma';
let MAIN = 'a'.repeat(7) + '1234567890123456789012345678901234567'.slice(0, 33);
let versionCode = 6;
let channel = { latest: { version: '1.0.4', versionCode: 5 } };
const releases = new Set(['android-v1.0.4']);
const runs = [];
const dispatches = [];
let failBuild = false;

function gradle() {
  return 'android {\n  defaultConfig {\n    applicationId = "com.inhouse.learn"\n    versionCode = ' + versionCode + '\n    versionName = "1.0.' + (versionCode - 1) + '"\n  }\n}\n';
}

async function github(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = decodeURIComponent(url.pathname);
  const json = (obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (req.headers().authorization !== 'Bearer github_pat_test') return json({ message: 'Bad credentials' }, 401);
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  let m;
  if (p === '/user') return json({ login: 'tester' });
  if (p === '/repos/' + LEARN + '/git/ref/heads/main') return json({ object: { sha: MAIN } });
  if (p === '/repos/' + LEARN + '/contents/android/app/build.gradle.kts') return json({ type: 'file', encoding: 'base64', content: Buffer.from(gradle()).toString('base64'), sha: 'g', size: 10 });
  if (p === '/repos/' + LEARN + '/contents/updates/A.json') return json({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(channel)).toString('base64'), sha: 'c', size: 10 });
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/.exec(p))) {
    return releases.has(m[1] + '#' + m[2]) || (m[1] === LEARN && releases.has(m[2])) ? json({ tag_name: m[2], html_url: 'https://github.com/' + m[1] + '/releases/tag/' + m[2] }) : json({ message: 'Not Found' }, 404);
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/.exec(p)) && req.method() === 'POST') {
    const run = { id: runs.length + 1, repo: m[1], workflow: m[2], inputs: body.inputs, status: 'in_progress', conclusion: null, polls: 0, created_at: new Date().toISOString(), head_sha: m[1] === LEARN ? MAIN : 'b'.repeat(40), html_url: 'https://github.com/' + m[1] + '/actions/runs/' + (runs.length + 1) };
    runs.push(run);
    dispatches.push(m[1].split('/')[1] + ':' + m[2] + ':' + JSON.stringify(body.inputs));
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' });
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/runs$/.exec(p))) {
    const list = runs.filter((run) => run.repo === m[1] && run.workflow === m[2] && (!url.searchParams.get('head_sha') || run.head_sha === url.searchParams.get('head_sha'))).reverse();
    return json({ workflow_runs: list });
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(p))) {
    const run = runs[Number(m[2]) - 1];
    if (run.status === 'completed') return json({ jobs: [{ id: 900 + run.id, name: 'build', status: 'completed', conclusion: run.conclusion, steps: [{ name: 'Build the minified release', status: 'completed', conclusion: run.conclusion }] }] });
    return json({ jobs: [{ id: 900 + run.id, name: run.workflow === 'sign-inhouse-learn.yml' ? 'sign' : 'build', status: 'in_progress', steps: [{ name: 'Build the minified release', status: 'in_progress' }] }] });
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)\/annotations$/.exec(p))) return json([{ annotation_level: 'failure', message: 'Task :app:mergeReleaseResources FAILED' }]);
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(p))) {
    const run = runs[Number(m[2]) - 1];
    // Each run finishes on its second look; finishing has the real side effects.
    if (run.status !== 'completed' && ++run.polls >= 2) {
      run.status = 'completed';
      const isBuild = run.workflow === 'android.yml' && run.inputs.publish === 'false';
      run.conclusion = isBuild && failBuild ? 'failure' : 'success';
      if (run.workflow === 'sign-inhouse-learn.yml') releases.add(SIGN + '#learn-signed-1.0.' + (versionCode - 1) + '-' + MAIN.slice(0, 7));
      if (run.workflow === 'android.yml' && run.inputs.publish === 'true') {
        const version = '1.0.' + (versionCode - 1);
        releases.add('android-v' + version);
        channel = { latest: { version, versionCode, apkUrl: 'https://github.com/' + LEARN + '/releases/download/android-v' + version + '/inhouse-learn-' + version + '.apk', apkSha256: 'f'.repeat(64) } };
      }
    }
    return json(run);
  }
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
  const prompt = await page.evaluate(() => githubPromptText(getActiveChat()));
  check('the model knows this app is its own repository and how to ship an APK', /miguelcoxcaballero\/inhouselearn/.test(prompt) && /github_release_android/.test(prompt) && /Nunca el canal B/.test(prompt));

  // 1. «Acceso total» still asks; nothing runs before «Publicar».
  await page.evaluate(() => { getActiveChat().approvalMode = 'full'; renderApprovalUi(); });
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'github_release_android', args: { changelog: 'Faster live chat on every device.' } }] },
    { text: 'Publicada la 1.0.5.' }
  ));
  await send(page, 'Publica la APK');
  await page.waitForSelector('.dock-approve', { timeout: 20000 });
  const card = await page.evaluate(() => ({ title: document.querySelector('.dock-approve-head b').textContent, msg: document.querySelector('.dock-approve-msg').textContent, button: document.querySelector('.dock-approve [data-dock="approve"]').textContent }));
  await page.screenshot({ path: SCRATCH + '/release-approve.png' });
  check('publishing asks even in «Acceso total», and nothing has run yet', /Publicar la APK 1\.0\.5 en el canal A/.test(card.title) && /versionCode 6/.test(card.msg) && /Faster live chat/.test(card.msg) && dispatches.length === 0, { card, dispatches });
  await page.click('.dock-approve [data-dock="approve"]');
  await page.waitForFunction(() => /Firmando|firma/.test((document.querySelector('.live-now') || {}).innerText || ''), null, { timeout: 60000 }).catch(() => {});
  const live = await page.evaluate(() => (document.querySelector('.live-now') || {}).innerText || '');
  await page.screenshot({ path: SCRATCH + '/release-live.png' });
  check('the thread says what the release is doing', /Publicando la APK/.test(live) && /firma|Firmando/i.test(live), live);
  await idle(page, 180000);
  const result = await lastTool(page);
  check('build of main, then signature of that exact sha, then publish on A, in order', JSON.stringify(dispatches) === JSON.stringify([
    'inhouselearn:android.yml:{"publish":"false"}',
    'youtube-calma:sign-inhouse-learn.yml:{"ref":"' + MAIN + '"}',
    'inhouselearn:android.yml:{"publish":"true","changelog":"Faster live chat on every device."}'
  ]), dispatches);
  check('the result is checked in updates/A.json and reported with the release', /APK 1\.0\.5 \(versionCode 6\) publicada en el canal A/.test(result) && /android-v1\.0\.5/.test(result) && /SHA-256: f{64}/.test(result), result.slice(0, 300));

  // 2. Same versionCode as channel A: stops before asking or running anything.
  const before = dispatches.length;
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'github_release_android', args: { changelog: 'Same version again please.' } }] }, { text: 'No se pudo.' }));
  await send(page, 'Publica otra vez');
  await idle(page, 30000);
  const same = await lastTool(page);
  check('a versionCode that does not go up stops before asking or running anything', /Sube versionCode/.test(same) && dispatches.length === before && !(await page.$('.dock-approve')), same.slice(0, 200));

  // 3. «No» runs nothing.
  versionCode = 7;
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'github_release_android', args: { changelog: 'Something the user does not want.' } }] }, { text: 'Vale.' }));
  await send(page, 'Publica la 1.0.6');
  await page.waitForSelector('.dock-approve', { timeout: 20000 });
  await page.click('.dock-approve [data-dock="reject"]');
  await idle(page, 30000);
  check('«No» runs no workflow', dispatches.length === before && /no ha aprobado/.test(await lastTool(page)));

  // 4. A failing build stops before the signature, with the error.
  failBuild = true;
  MAIN = 'c'.repeat(40); // a new commit on main, never built
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'github_release_android', args: { changelog: 'This build is broken today.' } }] }, { text: 'Falló.' }));
  await send(page, 'Publica la 1.0.6');
  await page.waitForSelector('.dock-approve', { timeout: 20000 });
  await page.click('.dock-approve [data-dock="approve"]');
  await idle(page, 120000);
  const failed = await lastTool(page);
  check('a failing build stops before signing and shows the error', /Ha fallado el build de Android/.test(failed) && /mergeReleaseResources FAILED/.test(failed) && !dispatches.slice(before).some((d) => /youtube-calma/.test(d)), { failed: failed.slice(0, 300), after: dispatches.slice(before) });
  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
