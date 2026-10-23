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
const manifests = new Map();
const SECRET = 'miguelcoxcaballero/secret-site';
const SHOT_WORKFLOW = 'name: App screenshots\non: workflow_dispatch\n';
let installed = '';
let installedBlob = '';
const commits = [];
const privateImageReads = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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
  // Other repositories for the screenshots: one public, one private.
  if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p))) return json({ full_name: m[1], default_branch: 'main', private: m[1] === SECRET });
  if (p === '/repos/' + LEARN + '/contents/.github/workflows/screenshots.yml') return json({ type: 'file', encoding: 'base64', content: Buffer.from(SHOT_WORKFLOW).toString('base64'), sha: 'w', size: 10 });
  if (p === '/repos/' + SECRET + '/contents/.github/workflows/inhouse-screenshots.yml') return installed ? json({ type: 'file', encoding: 'base64', content: Buffer.from(installed).toString('base64'), sha: 'i', size: 10 }) : json({ message: 'Not Found' }, 404);
  if (p === '/repos/' + SECRET + '/contents/shots/1-a.png' && url.searchParams.get('ref') === 'screenshots') {
    privateImageReads.push(req.headers().accept);
    return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: PNG });
  }
  if (p === '/repos/' + SECRET + '/git/ref/heads/main') return json({ object: { sha: 'c'.repeat(40) } });
  if (p.startsWith('/repos/' + SECRET + '/git/commits/') && req.method() === 'GET') return json({ sha: 'c'.repeat(40), tree: { sha: 't'.repeat(40) } });
  if (p === '/repos/' + SECRET + '/git/blobs' && req.method() === 'POST') { installedBlob = body.content; return json({ sha: 'd'.repeat(40) }); }
  if (p === '/repos/' + SECRET + '/git/trees' && req.method() === 'POST') { commits.push(SECRET + ':' + body.tree.map((t) => t.path).join(',')); return json({ sha: 'e'.repeat(40) }); }
  if (p === '/repos/' + SECRET + '/git/commits' && req.method() === 'POST') return json({ sha: 'f'.repeat(40) });
  if (p === '/repos/' + SECRET + '/git/refs/heads/main' && req.method() === 'PATCH') { installed = installedBlob; return json({ object: { sha: body.sha } }); }
  if (p === '/repos/' + LEARN + '/contents/android/app/build.gradle.kts') return json({ type: 'file', encoding: 'base64', content: Buffer.from(gradle()).toString('base64'), sha: 'g', size: 10 });
  if ((m = /^\/repos\/[^/]+\/[^/]+\/contents\/(shot-[^/]+)\/manifest\.json$/.exec(p)) && url.searchParams.get('ref') === 'screenshots') {
    return manifests.has(m[1]) ? json({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(manifests.get(m[1]))).toString('base64'), sha: 'm', size: 10 }) : json({ message: 'Not Found' }, 404);
  }
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
      if (run.workflow === 'screenshots.yml' || run.workflow === 'inhouse-screenshots.yml') {
        const shots = JSON.parse(run.inputs.shots);
        manifests.set(run.inputs.id, { id: run.inputs.id, ref: run.inputs.ref, shots: shots.map((shot, i) => i === shots.length - 1 && /roto/i.test(shot.name)
          ? { name: shot.name, file: null, device: shot.device || 'phone', theme: shot.theme || 'light', error: 'page.click: Timeout 8000ms exceeded.' }
          : { name: shot.name, file: (i + 1) + '-' + i + '.png', device: shot.device || 'phone', theme: shot.theme || 'light' }) });
      }
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
  // 5. Real screenshots of a branch: in «Auto» they go ahead (no code changes),
  // the workflow gets the exact ref and shots, and the model gets the picture URLs.
  await page.evaluate(() => { getActiveChat().approvalMode = 'auto'; renderApprovalUi(); });
  const beforeShots = dispatches.length;
  const shots = [{ name: 'Menú +, oscuro', device: 'phone', theme: 'dark', steps: [{ click: '#plus-btn' }] }, { name: 'Roto', steps: [{ click: '#no-existe' }] }];
  await page.evaluate((args) => window.__replies.push({ text: '', tools: [{ name: 'github_screenshot', args }] }, { text: 'Aquí están.' }), { ref: 'feature/menu', shots });
  await send(page, 'Enséñame cómo queda el menú');
  await idle(page, 120000);
  const shotResult = await lastTool(page);
  const sent = dispatches.slice(beforeShots);
  const inputs = sent.length === 1 ? JSON.parse(sent[0].split(':').slice(2).join(':')) : {};
  check('screenshots: in «Auto» no card; the workflow gets the ref and the shots', sent.length === 1 && /^inhouselearn:screenshots\.yml:/.test(sent[0]) && inputs.ref === 'feature/menu' && /^shot-\d{8}-\d{6}-/.test(inputs.id) && JSON.parse(inputs.shots)[0].theme === 'dark', sent);
  check('…and the model gets real picture URLs and is told to show them; a failed shot says why', /1 de 2 capturas reales/.test(shotResult) && /https:\/\/raw\.githubusercontent\.com\/miguelcoxcaballero\/inhouselearn\/screenshots\/shot-[^/]+\/1-0\.png/.test(shotResult) && /no se pudo hacer \(page\.click/.test(shotResult) && /bloque visual image/.test(shotResult), shotResult.slice(0, 400));
  await page.evaluate(() => { getActiveChat().approvalMode = 'ask'; renderApprovalUi(); });
  await page.evaluate((args) => window.__replies.push({ text: '', tools: [{ name: 'github_screenshot', args }] }, { text: 'Vale.' }), { shots: [{ name: 'Inicio' }] });
  await send(page, 'Otra captura');
  const askCard = await page.waitForSelector('.dock-approve', { timeout: 20000 }).then(() => page.evaluate(() => document.querySelector('.dock-approve-head b').textContent), () => '');
  await page.click('.dock-approve [data-dock="reject"]').catch(() => {});
  await idle(page, 30000);
  check('in «Preguntar» it asks first', askCard === 'Hacer capturas', askCard);

  // 6. Any project: another public repository runs here with its setup and folder;
  // a public URL too.
  await page.evaluate(() => { getActiveChat().approvalMode = 'auto'; renderApprovalUi(); });
  let mark = dispatches.length;
  await page.evaluate((args) => window.__replies.push({ text: '', tools: [{ name: 'github_screenshot', args }] }, { text: 'Hechas.' }), { repo: 'someone/blog', ref: 'redesign', setup: 'npm ci && npm run build', serve: 'dist', shots: [{ name: 'Portada', path: 'about.html', device: 'desktop' }] });
  await send(page, 'Captura de mi blog');
  await idle(page, 120000);
  let other = dispatches.slice(mark);
  let otherInputs = other.length === 1 ? JSON.parse(other[0].split(':').slice(2).join(':')) : {};
  const otherResult = await lastTool(page);
  check('another public repository: runs here with repo, ref, setup and serve', other.length === 1 && /^inhouselearn:screenshots\.yml:/.test(other[0]) && otherInputs.repo === 'someone/blog' && otherInputs.ref === 'redesign' && otherInputs.setup === 'npm ci && npm run build' && otherInputs.serve === 'dist' && JSON.parse(otherInputs.shots)[0].path === 'about.html' && /capturas reales de someone\/blog@redesign/.test(otherResult), { other, otherResult: otherResult.slice(0, 200) });
  mark = dispatches.length;
  await page.evaluate((args) => window.__replies.push({ text: '', tools: [{ name: 'github_screenshot', args }] }, { text: 'Hechas.' }), { url: 'https://example.com/', shots: [{ name: 'Web' }] });
  await send(page, 'Captura de example.com');
  await idle(page, 120000);
  other = dispatches.slice(mark);
  otherInputs = other.length === 1 ? JSON.parse(other[0].split(':').slice(2).join(':')) : {};
  check('a public URL: runs here with url and no repo', other.length === 1 && otherInputs.url === 'https://example.com/' && !otherInputs.repo, other);
  await page.evaluate((args) => window.__replies.push({ text: '', tools: [{ name: 'github_screenshot', args }] }, { text: 'No.' }), { url: 'http://localhost:5173/', shots: [{ name: 'Local' }] });
  await send(page, 'Captura de mi localhost');
  await idle(page, 60000);
  check('…a localhost address is refused with the reason', /solo existe en tu ordenador/.test(await lastTool(page)));

  // 7. A private repository: the workflow is installed there (a commit, which
  // asks even in «Auto»), the shots run there, and the pictures stay there.
  mark = dispatches.length;
  await page.evaluate((args) => window.__replies.push({ text: '', tools: [{ name: 'github_screenshot', args }] }, { text: 'Hechas.' }), { repo: SECRET, shots: [{ name: 'Inicio' }] });
  await send(page, 'Captura de mi web privada');
  const installCard = await page.waitForSelector('.dock-approve', { timeout: 20000 }).then(() => page.evaluate(() => document.querySelector('.dock-approve').innerText), () => '');
  await page.click('.dock-approve [data-dock="approve"]');
  await idle(page, 120000);
  other = dispatches.slice(mark);
  const privateResult = await lastTool(page);
  check('private repository: asks to install the workflow there, once', /Instalar las capturas en/.test(installCard) && /inhouse-screenshots\.yml/.test(installCard) && commits.slice(-1)[0] === SECRET + ':.github/workflows/inhouse-screenshots.yml' && installed === SHOT_WORKFLOW, { installCard: installCard.slice(0, 300), commits });
  check('…and the shots run in the private repository, pictures on its own branch', other.length === 1 && /^secret-site:inhouse-screenshots\.yml:/.test(other[0]) && /raw\.githubusercontent\.com\/miguelcoxcaballero\/secret-site\/screenshots\//.test(privateResult), { other, privateResult: privateResult.slice(0, 300) });
  mark = dispatches.length;
  const commitsBefore = commits.length;
  await page.evaluate((args) => window.__replies.push({ text: '', tools: [{ name: 'github_screenshot', args }] }, { text: 'Hechas.' }), { repo: SECRET, shots: [{ name: 'Otra' }] });
  await send(page, 'Otra captura privada');
  await idle(page, 120000);
  check('…the second time nothing is installed and nothing asks in «Auto»', commits.length === commitsBefore && dispatches.length === mark + 1);
  // A private picture loads with the user's token (raw.githubusercontent.com refuses it).
  await page.route('https://raw.githubusercontent.com/**', (r) => r.fulfill({ status: 404, body: 'Not Found' }));
  await page.evaluate(() => window.__replies.push({ text: '```visual\n{"type":"image","src":"https://raw.githubusercontent.com/miguelcoxcaballero/secret-site/screenshots/shots/1-a.png","alt":"Inicio"}\n```' }));
  await send(page, 'Enséñamela');
  await idle(page);
  const shown = await page.waitForFunction(() => { const img = document.querySelector('#thread .message:last-child img.viz-photo-img'); return img && img.src.startsWith('blob:') && img.naturalWidth > 0 ? img.src : false; }, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => '');
  check('a private screenshot is shown in the chat, read with the token', !!shown && privateImageReads.length === 1 && /vnd\.github\.raw/.test(privateImageReads[0]), { shown, privateImageReads });

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
