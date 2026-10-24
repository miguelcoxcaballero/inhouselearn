// The screenshots script (.github/scripts/screenshots.cjs) fails fast and says
// why: a .html page that is not in the served folder fails before Chromium
// starts, naming the file and the pages that exist; a page that answers 404
// fails at once with the status; a page that loads but is not the app fails in
// seconds saying so (no #composer / runAssistantTurn, final URL, title); the
// same failed page is not waited for twice; reasons land in manifest.json, in
// ::error:: annotations with the shot's name and in the summary; a valid shot
// still works, alone or next to a broken one.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, '.github/scripts/screenshots.cjs');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));

function run(name, shots, env) {
  const id = 'shot-test-' + name;
  const started = Date.now();
  const result = spawnSync(process.execPath, process.execArgv.concat([SCRIPT]), {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ID: id, OUT, SHOTS: JSON.stringify(shots), TARGET: 'miguelcoxcaballero/inhouselearn', SERVE_DIR: ROOT, GITHUB_STEP_SUMMARY: '' }, env || {}),
    encoding: 'utf8',
    timeout: 120000
  });
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(OUT, id, 'manifest.json'), 'utf8')); } catch (_) {}
  return { seconds: (Date.now() - started) / 1000, code: result.status, out: (result.stdout || '') + (result.stderr || ''), manifest };
}

(async () => {
  // 1. A valid shot of the app.
  const ok = run('ok', [{ name: 'Inicio' }]);
  check('a valid shot of the app still works', ok.code === 0 && ok.manifest && ok.manifest.shots[0].file && fs.existsSync(path.join(OUT, 'shot-test-ok', ok.manifest.shots[0].file)), { code: ok.code, out: ok.out.slice(-300) });

  // 2. Six .html pages that do not exist: no Chromium, seconds, each one named.
  const six = run('six', ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => ({ name: 'Página ' + x, path: 'no-existe-' + x + '.html' })));
  const errs = (six.manifest ? six.manifest.shots : []).map((s) => s.error || '');
  check('6 .html pages that are not in the served folder fail in seconds, before Chromium', six.code === 1 && six.seconds < 5 && errs.length === 6 && errs.every((e, i) => e.includes('no-existe-' + 'abcdef'[i] + '.html') && /index\.html/.test(e)), { seconds: six.seconds, errs: errs.slice(0, 2) });
  check('…each reason is a ::error:: annotation with the shot\'s name, and the summary lists every one', (six.out.match(/::error title=Página [a-f]::/g) || []).length === 6 && /0 de 6 capturas hechas/.test(six.out) && (six.out.match(/^· Página [a-f]: /gm) || []).length === 6, six.out.slice(0, 400));

  // 3. A path without .html that answers 404: at once, with the status; the same page is not waited for twice.
  const notFound = run('404', [{ name: 'Carpeta', path: 'no-hay-nada/' }, { name: 'Otra vez', path: 'no-hay-nada/' }]);
  const nf = (notFound.manifest ? notFound.manifest.shots : []).map((s) => s.error || '');
  check('a page that answers 404 fails at once, saying the path and the HTTP status', notFound.code === 1 && notFound.seconds < 20 && /no-hay-nada\//.test(nf[0]) && /HTTP 404/.test(nf[0]) && /no se vuelve a esperar/.test(nf[1]), { seconds: notFound.seconds, nf });

  // 4. A page that exists but is not the app.
  const notApp = run('notapp', [{ name: 'Auth', path: 'app-auth.html' }]);
  const na = notApp.manifest ? notApp.manifest.shots[0].error || '' : '';
  check('a page that loads but is not the app fails in seconds, saying it has no #composer nor the global', notApp.code === 1 && notApp.seconds < 25 && /no tiene #composer ni el global runAssistantTurn/.test(na) && /URL final .*app-auth\.html/.test(na) && /título «/.test(na), { seconds: notApp.seconds, na });

  // 5. One valid and one broken shot: the run succeeds and the broken one says why.
  const mixed = run('mixed', [{ name: 'Bien', messages: [{ user: 'Hola', assistant: 'Hola, ¿qué estudiamos?' }] }, { name: 'Mal', path: 'falta.html' }]);
  const mx = mixed.manifest ? mixed.manifest.shots : [];
  check('a valid shot (with a replayed conversation) next to a broken one: the run succeeds, the broken one says why', mixed.code === 0 && mx[0] && mx[0].file && !mx[0].error && mx[1] && !mx[1].file && /falta\.html/.test(mx[1].error) && /1 de 2 capturas hechas/.test(mixed.out), { code: mixed.code, mx });

  // 6. Any other site (URL mode, no app checks): a page that exists works, a 404 says so.
  const site = new URL('./', process.env.BASE_URL || 'http://127.0.0.1:8765/index.html').href;
  const web = run('web', [{ name: 'Portada', path: 'app-auth.html' }, { name: 'Rota', path: 'nada.html' }], { TARGET: '', URL: site, SERVE_DIR: '' });
  const wb = web.manifest ? web.manifest.shots : [];
  check('any other site: a page that exists works and a 404 says the path and the status', web.code === 0 && wb[0] && wb[0].file && wb[1] && /nada\.html/.test(wb[1].error) && /HTTP 404/.test(wb[1].error), { code: web.code, wb, out: web.out.slice(-200) });

  fs.rmSync(OUT, { recursive: true, force: true });
})();
