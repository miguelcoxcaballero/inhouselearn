// GitHub changes prepared but not uploaded live in IndexedDB (composer-dock.js),
// not in localStorage: several big files (index.html is ~0.6 MB) used to fill
// localStorage's ~5 MB, every write failed with «No caben más cambios…» and the
// change was lost. They survive a reload, old localStorage copies move over, and
// the app shows no floating notices at all (showToast only logs).
const { chromium } = require('playwright');
const { openApp } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 844 } });

  // An old page left a stage in localStorage: it moves to IndexedDB.
  const chatId = await page.evaluate(() => getActiveChat().id);
  await page.evaluate((id) => localStorage.setItem(STORAGE_KEY + '::githubStage::' + id, JSON.stringify({ 'yo/app@main': { repo: 'yo/app', branch: 'main', base: '', files: { 'viejo.txt': 'hola' }, deletes: [], notes: [] } })), chatId);
  await page.reload();
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(1500);
  const migrated = await page.evaluate((id) => ({ list: githubStageStore(getActiveChat()).list().map((e) => Object.keys(e.files)), ls: localStorage.getItem(STORAGE_KEY + '::githubStage::' + id) }), chatId);
  check('a stage an older page left in localStorage moves to IndexedDB (and frees localStorage)', JSON.stringify(migrated.list) === '[["viejo.txt"]]' && migrated.ls === null, migrated);

  // 8 big files (~5.6 MB): all kept, no notice.
  const big = await page.evaluate(() => {
    const store = githubStageStore(getActiveChat());
    const body = 'x'.repeat(700 * 1024);
    for (let i = 0; i < 8; i++) {
      const entry = store.get('yo/app', 'main') || { repo: 'yo/app', branch: 'main', base: '', files: {}, deletes: [], notes: [] };
      entry.files['big-' + i + '.html'] = body + i;
      store.put(entry);
    }
    return { files: Object.keys(store.get('yo/app', 'main').files).length, notices: document.querySelectorAll('.toast').length };
  });
  check('eight 700 KB files stay prepared (≈5.6 MB, more than localStorage holds) and nothing pops up', big.files === 9 && big.notices === 0, big);

  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => { const e = githubStageStore(getActiveChat()).get('yo/app', 'main'); return { files: e ? Object.keys(e.files).length : 0, last: e ? e.files['big-7.html'].slice(-1) : '', card: !!document.querySelector('#dock-stage .dock-stage-head') }; });
  check('after a reload every prepared change is still there', after.files === 9 && after.last === '7', after);

  // Deleting the chat drops its stage too.
  await page.evaluate((id) => githubStageDrop(id), chatId);
  await page.waitForTimeout(300);
  const dropped = await page.evaluate(() => githubStageStore(getActiveChat()).list().length);
  check('deleting the chat drops its prepared changes', dropped === 0, dropped);

  // No floating notices anywhere: showToast only logs.
  const quiet = await page.evaluate(() => { showToast('GitHub', 'prueba'); return { toasts: document.querySelectorAll('.toast').length, logged: (window.__inhouseNotices || []).some((n) => n.message === 'prueba') }; });
  check('the app shows no floating notices (showToast only logs them)', quiet.toasts === 0 && quiet.logged, quiet);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
