// Several Ultra code agents committing to the same branch at once (each with
// its own GitHub tools, like the app builds them) against an in-memory GitHub
// whose ref reads can be stale right after an update: the commits of one
// branch go one at a time; a "not a fast forward" with other files is rebuilt
// on the new head (one 422, and the second commit's parent is the first); the
// same file is refused with «Otro agente cambió …»; a branch created meanwhile
// («Reference already exists») is committed on top of; and no more than 4
// requests are ever in flight.
const { chromium } = require('playwright');
const path = require('path');
const crypto = require('crypto');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

const sha = (text) => crypto.createHash('sha1').update(String(text) + Math.random()).digest('hex');
let blobs, trees, commits, refs, stale, hidden, stats;
function seed() {
  blobs = new Map(); trees = new Map(); commits = new Map(); refs = new Map();
  stale = new Map(); // branch -> previous sha, served once by the next ref read
  hidden = new Map(); // branch -> how many ref reads still answer 404
  stats = { patch422: 0, refExists: 0, inFlight: 0, peak: 0 };
  const files = { 'README.md': '# Demo\n', 'src/a.js': 'a\n', 'src/b.js': 'b\n' };
  for (let i = 0; i < 24; i++) files['lib/f' + i + '.js'] = 'const x' + i + ' = ' + i + ';\n';
  const tree = {};
  Object.entries(files).forEach(([p, content]) => { const s = sha(content); blobs.set(s, content); tree[p] = s; });
  const treeSha = sha('tree'); trees.set(treeSha, tree);
  const commitSha = sha('commit'); commits.set(commitSha, { tree: treeSha, parent: null });
  refs.set('main', commitSha);
}
const filesAt = (ref) => { const commit = refs.get(ref) || ref; return trees.get((commits.get(commit) || {}).tree) || {}; };

async function github(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = decodeURIComponent(url.pathname);
  stats.inFlight++; stats.peak = Math.max(stats.peak, stats.inFlight);
  const json = (obj, status) => {
    stats.inFlight--;
    return route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  };
  // A little latency, so concurrent requests really overlap.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  let m;
  if (p === '/repos/tester/demo') return json({ default_branch: 'main' });
  if ((m = /^\/repos\/tester\/demo\/git\/ref\/heads\/(.+)$/.exec(p))) {
    const branch = m[1];
    if (hidden.get(branch) > 0) { hidden.set(branch, hidden.get(branch) - 1); return json({ message: 'Not Found' }, 404); }
    if (stale.has(branch)) { const old = stale.get(branch); stale.delete(branch); return json({ object: { sha: old } }); }
    return refs.has(branch) ? json({ object: { sha: refs.get(branch) } }) : json({ message: 'Not Found' }, 404);
  }
  if ((m = /^\/repos\/tester\/demo\/git\/trees\/(.+)$/.exec(p)) && req.method() === 'GET') {
    const files = filesAt(m[1]);
    return json({ tree: Object.keys(files).map((file) => ({ path: file, type: 'blob', sha: files[file], size: blobs.get(files[file]).length })), truncated: false });
  }
  if ((m = /^\/repos\/tester\/demo\/git\/blobs\/(.+)$/.exec(p)) && req.method() === 'GET') return json({ content: Buffer.from(blobs.get(m[1])).toString('base64'), encoding: 'base64' });
  if ((m = /^\/repos\/tester\/demo\/contents\/(.+)$/.exec(p))) {
    const files = filesAt(url.searchParams.get('ref') || 'main');
    if (!files[m[1]]) return json({ message: 'Not Found' }, 404);
    return json({ type: 'file', encoding: 'base64', content: Buffer.from(blobs.get(files[m[1]])).toString('base64'), sha: files[m[1]], size: blobs.get(files[m[1]]).length });
  }
  if (p === '/repos/tester/demo/git/refs' && req.method() === 'POST') {
    const branch = body.ref.replace('refs/heads/', '');
    if (refs.has(branch)) { stats.refExists++; return json({ message: 'Reference already exists' }, 422); }
    refs.set(branch, body.sha); return json({ ref: body.ref });
  }
  if ((m = /^\/repos\/tester\/demo\/git\/commits\/(.+)$/.exec(p))) return json({ sha: m[1], tree: { sha: commits.get(m[1]).tree } });
  if (p === '/repos/tester/demo/git/blobs') { const s = sha(body.content); blobs.set(s, body.content); return json({ sha: s }); }
  if (p === '/repos/tester/demo/git/trees') {
    const tree = Object.assign({}, trees.get(body.base_tree));
    body.tree.forEach((item) => { if (item.sha === null) delete tree[item.path]; else tree[item.path] = item.sha; });
    const s = sha('tree'); trees.set(s, tree); return json({ sha: s });
  }
  if (p === '/repos/tester/demo/git/commits') { const s = sha('commit'); commits.set(s, { tree: body.tree, parent: body.parents[0], message: body.message }); return json({ sha: s }); }
  if ((m = /^\/repos\/tester\/demo\/git\/refs\/heads\/(.+)$/.exec(p)) && req.method() === 'PATCH') {
    const branch = m[1];
    if (commits.get(body.sha).parent !== refs.get(branch)) { stats.patch422++; return json({ message: 'Update is not a fast forward' }, 422); }
    // Like a replica that has not caught up: the next read of this ref still says the old head.
    stale.set(branch, refs.get(branch));
    refs.set(branch, body.sha);
    return json({ object: { sha: body.sha } });
  }
  if ((m = /^\/repos\/tester\/demo\/compare\/(.+)\.\.\.(.+)$/.exec(p))) {
    const a = filesAt(m[1]); const b = filesAt(m[2]);
    const names = new Set(Object.keys(a).concat(Object.keys(b)));
    return json({ files: Array.from(names).filter((file) => a[file] !== b[file]).map((file) => ({ filename: file, status: !a[file] ? 'added' : !b[file] ? 'removed' : 'modified' })) });
  }
  stats.inFlight--;
  return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ message: 'Not Found (mock): ' + req.method() + ' ' + p }) });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route('https://api.github.com/**', github);
  await page.route('http://127.0.0.1:8765/__github-concurrent.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>t</title>' }));
  await page.goto('http://127.0.0.1:8765/__github-concurrent.html');
  await page.addScriptTag({ path: path.join(__dirname, '..', '..', 'vendor', 'pi-engine.js') });
  await page.evaluate(() => {
    // One set of tools per agent, like runSubAgent builds them, all approving.
    window.pushAs = async (files, branch) => {
      const tools = InhousePi.createGithubTools({ token: () => 'github_pat_test', confirm: async () => true });
      const tool = (name) => tools.find((item) => item.name === name);
      await tool('github_write_files').execute('w', { repo: 'tester/demo', branch, files });
      try {
        const result = await tool('github_push').execute('p', { repo: 'tester/demo', branch, message: 'cambio ' + files.map((file) => file.path).join(', ') });
        return { ok: true, sha: result.details.sha, text: result.content[0].text };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    };
  });

  // 1. Two agents, other files, same branch, at the same time.
  seed();
  const main0 = refs.get('main');
  let out = await page.evaluate(() => Promise.all([
    window.pushAs([{ path: 'src/a.js', content: 'a cambiado\n' }], 'main'),
    window.pushAs([{ path: 'src/b.js', content: 'b cambiado\n' }], 'main')
  ]));
  check('disjoint files: both commit', out.every((item) => item.ok), out);
  const head = refs.get('main');
  const first = out.map((item) => item.sha).find((s) => s !== head);
  check('the second commit\'s parent is the first, whose parent is the old head', commits.get(head) && commits.get(head).parent === first && commits.get(first).parent === main0, { head, first, main0 });
  check('one stale-head 422 was seen and recovered', stats.patch422 === 1, stats);
  const final = filesAt('main');
  check('the branch has both changes', blobs.get(final['src/a.js']) === 'a cambiado\n' && blobs.get(final['src/b.js']) === 'b cambiado\n');

  // 2. Two agents, the same file: the second one is refused, nothing is overwritten.
  seed();
  out = await page.evaluate(() => Promise.all([
    window.pushAs([{ path: 'README.md', content: '# Uno\n' }], 'main'),
    window.pushAs([{ path: 'README.md', content: '# Dos\n' }], 'main')
  ]));
  const failed = out.filter((item) => !item.ok);
  check('same file: one commits, the other is refused', out.filter((item) => item.ok).length === 1 && failed.length === 1, out);
  check('the refusal says «Otro agente cambió README.md en main…»', failed[0] && /^Otro agente cambió README\.md en main mientras tanto; lee la versión nueva y repite el cambio\.$/.test(failed[0].error), failed[0]);
  const readme = blobs.get(filesAt('main')['README.md']);
  check('the first version stays', readme === '# Uno\n' || readme === '# Dos\n', readme);

  // 3. A branch created by someone else between the reads and the commit.
  seed();
  refs.set('feat/x', refs.get('main'));
  const base = refs.get('feat/x');
  hidden.set('feat/x', 2); // the pre-approval read and the one inside the lock miss it
  out = await page.evaluate(() => window.pushAs([{ path: 'src/a.js', content: 'rama\n' }], 'feat/x'));
  check('«Reference already exists» → commit on top of the existing branch', out.ok && stats.refExists === 1 && commits.get(refs.get('feat/x')).parent === base, { out, stats });

  // 4. Never more than 4 requests in flight (a grep reads 27 blobs, 8 at a time).
  seed();
  stats.peak = 0;
  const grep = await page.evaluate(async () => {
    const tools = InhousePi.createGithubTools({ token: () => 'github_pat_test', confirm: async () => true });
    const result = await tools.find((item) => item.name === 'github_grep').execute('g', { repo: 'tester/demo', pattern: 'const x' });
    return result.content[0].text;
  });
  check('grep works under the limit', /24 coincidencias/.test(grep), grep.slice(0, 120));
  check('at most 4 GitHub requests at once', stats.peak <= 4 && stats.peak >= 2, stats);

  await browser.close();
})().catch((error) => { console.log('FAIL crashed — ' + error.stack); process.exit(1); });
