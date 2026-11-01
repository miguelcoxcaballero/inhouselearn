// The «Subir a GitHub» card above the composer (composer-dock.js): a commit
// shows repo, branch, a «Rama principal» flag, the model's short changelog
// (**bold** rendered, no raw message on screen), the files with N/M/B badges
// and +/−, and the raw commit message folded. An older engine that only sends
// the summary text still gets the same card, with its bullets shortened. The
// text of a main-branch or delete card is never red (it looked like an
// error). Nothing scrolls sideways at 390 px, in light and AMOLED dark.
const { chromium } = require('playwright');
const { openApp, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : '')); };
let failed = 0;

const ITEMS = [
  { path: 'engine/src/github.js', status: 'modificado', added: 230, removed: 6 },
  { path: '.github/workflows/run.yml', status: 'nuevo', added: 276, removed: 0 },
  { path: 'old/notes.md', status: 'borrado', added: 0, removed: 12 }
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 860 }, isMobile: true, hasTouch: true });

  // 1. New engine: structured fields through approveChange.
  const modern = await page.evaluate(async (items) => {
    const chat = getActiveChat();
    chat.approvalMode = 'ask';
    const pending = approveChange(chat, {
      title: 'Subir a GitHub', kind: 'commit', mainBranch: true, items,
      summary: 'me/app · rama main · ¡es la rama principal!\n«feat: compilar de verdad»',
      repo: 'me/app', branch: 'main', base: 'main', creating: false,
      commitMessage: 'feat: compilar de verdad\n\n- github_run: long technical detail that should stay folded away from the card',
      changelog: ['Puedo **compilar y ejecutar tests** en GitHub Actions.', 'Nuevo fork con un clic.'], extra: ''
    });
    await new Promise((r) => setTimeout(r, 30));
    const card = document.querySelector('#dock-approval .dock-approve');
    const msg = card.querySelector('.dock-approve-msg');
    const out = {
      title: card.querySelector('.dock-approve-head b').textContent,
      commit: card.classList.contains('dock-commit'), main: card.classList.contains('main'),
      repo: (card.querySelector('.dock-commit-repo') || {}).textContent,
      branch: (card.querySelector('.dock-commit-branch') || {}).textContent,
      flag: (card.querySelector('.dock-flag.main') || {}).textContent,
      bullets: Array.from(card.querySelectorAll('.dock-changelog li')).map((li) => li.textContent),
      strong: (card.querySelector('.dock-changelog li strong') || {}).textContent,
      rawVisible: /long technical detail/.test(msg.textContent),
      folded: !!card.querySelector('details.dock-commit-full:not([open])') && /long technical detail/.test(card.querySelector('.dock-commit-full pre').textContent),
      badges: Array.from(card.querySelectorAll('.dock-approve-files .st')).map((el) => el.textContent).join(''),
      files: card.querySelector('.dock-approve-files').innerText,
      msgColor: getComputedStyle(card.querySelector('.dock-changelog li')).color,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1 || card.scrollWidth > card.clientWidth + 1
    };
    window.__pending = pending;
    return out;
  }, ITEMS);
  await page.screenshot({ path: SCRATCH + '/approval-card-light.png' });
  check('commit card: title, repo, branch and the «Rama principal» flag', modern.title === 'Subir a GitHub' && modern.commit && modern.main && modern.repo === 'me/app' && modern.branch === 'main' && modern.flag === 'Rama principal', modern);
  check('the changelog is the model\'s short sentences, **bold** rendered; the raw message is folded', modern.bullets.length === 2 && modern.strong === 'compilar y ejecutar tests' && !/\*\*/.test(modern.bullets.join('')) && !modern.rawVisible && modern.folded, modern);
  check('files with N/M/B badges and +/−', modern.badges === 'MNB' && /engine\/src\/github\.js\s*\+230\s*−6/.test(modern.files) && /run\.yml\s*\+276/.test(modern.files), modern.files);
  const red = (color) => { const m = String(color).match(/\d+/g) || []; return Number(m[0]) > 120 && Number(m[1]) < 60 && Number(m[2]) < 60; };
  check('main branch: the text is not red, nothing scrolls sideways at 390 px', !red(modern.msgColor) && !modern.overflow, modern);

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(150);
  const dark = await page.evaluate(() => {
    const card = document.querySelector('#dock-approval .dock-approve');
    return { bg: getComputedStyle(card).backgroundColor, li: getComputedStyle(card.querySelector('.dock-changelog li')).color, overflow: card.scrollWidth > card.clientWidth + 1 };
  });
  await page.screenshot({ path: SCRATCH + '/approval-card-dark.png' });
  check('AMOLED dark: dark card, light readable text', Number((String(dark.bg).match(/\d+/) || [255])[0]) < 40 && !red(dark.li) && !dark.overflow, dark);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const answered = await page.evaluate(async () => { document.querySelector('#dock-approval [data-dock="approve"]').click(); return window.__pending; });
  check('approving still resolves true', answered === true, answered);

  // 2. Older engine: only the summary text, bullets shortened, PR line.
  const legacy = await page.evaluate(async (items) => {
    const long = 'github_run: ejecuta comandos en un runner de GitHub Actions (Linux, macOS o Windows) sobre una rama o commit subidos de cualquier repositorio que el token lea; devuelve código de salida';
    const pending = dockApprove({ title: 'Subir y abrir pull request', kind: 'commit', items: items.slice(0, 1), danger: false,
      message: 'me/app · rama feat/x (nueva, desde main)\n«feat: algo\n\n- ' + long + '\n- Arregla **el fallo** del login.»\nPull request: feat/x → main · «feat: algo»' });
    await new Promise((r) => setTimeout(r, 30));
    const card = document.querySelector('#dock-approval .dock-approve');
    const out = {
      commit: card.classList.contains('dock-commit'),
      flag: (card.querySelector('.dock-flag') || {}).textContent,
      pr: (card.querySelector('.dock-commit-pr') || {}).textContent,
      title: (card.querySelector('.dock-changelog-title') || {}).textContent,
      bullets: Array.from(card.querySelectorAll('.dock-changelog li')).map((li) => li.textContent),
      strong: (card.querySelector('.dock-changelog li strong') || {}).textContent,
      folded: !!card.querySelector('details.dock-commit-full')
    };
    dockApprovalAnswer(false);
    out.result = await pending;
    return out;
  }, ITEMS);
  check('older engine: same card from the summary (new branch flag, PR line, title)', legacy.commit && legacy.flag === 'nueva desde main' && /feat\/x → main/.test(legacy.pr) && legacy.title === 'feat: algo', legacy);
  check('older engine: long bullets shortened, bold kept, full message folded', legacy.bullets.length === 2 && legacy.bullets[0].length <= 100 && legacy.strong === 'el fallo' && legacy.folded && legacy.result === false, legacy);

  // 3. Any other approval keeps the plain card, and a danger card is not red text.
  const plain = await page.evaluate(async () => {
    const pending = dockApprove({ title: 'Borrar de la biblioteca', message: 'D3 · apuntes.pdf\nSe borra de este chat.', danger: true, confirmText: 'Borrar' });
    await new Promise((r) => setTimeout(r, 30));
    const card = document.querySelector('#dock-approval .dock-approve');
    const out = { commit: card.classList.contains('dock-commit'), msg: card.querySelector('.dock-approve-msg').textContent, color: getComputedStyle(card.querySelector('.dock-approve-msg')).color };
    dockApprovalAnswer(false);
    await pending;
    return out;
  });
  check('other approvals: plain card, message as written, not red', !plain.commit && /apuntes\.pdf/.test(plain.msg) && !red(plain.color), plain);

  check('no JavaScript errors', !errors.length, errors);
  await browser.close();
  console.log(failed ? 'approval-card: ' + failed + ' FAILED' : 'approval-card: all PASS');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
