// What sits in the composer belongs to its chat: attachments waiting to be sent
// and the other Google account linked for questions. Another chat shows its own
// (not the previous chat's), and they survive a reload until the user removes
// them. Deleting a chat forgets them.
const { chromium } = require('playwright');
const { openApp } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pills = () => page.evaluate(() => ({ files: [...document.querySelectorAll('#composer-attachments .composer-attachment:not(.extra-google-pill) .composer-attachment-name')].map((e) => e.textContent), account: !!document.querySelector('#composer-attachments .extra-google-pill') }));

  // Chat A: a file and another Google account.
  const chatA = await page.evaluate(async () => {
    const chat = getActiveChat();
    chat.messages.push({ id: 'u1', role: 'user', content: 'Hola', createdAt: new Date().toISOString() });
    await addFilesToComposer([new File(['apuntes de física'], 'apuntes.txt', { type: 'text/plain' })]);
    extraGoogle = { email: 'otra@example.com', token: 'tok-otra', expiresAt: Date.now() + 3600e3, gmail: true, drive: true, status: { gmail: { kind: 'ok', text: '' }, drive: { kind: 'ok', text: '' } } };
    renderComposerAttachments();
    saveState({ skipDrive: true });
    return chat.id;
  });
  const inA = await pills();
  check('chat A shows its attachment and its linked account', inA.files.length === 1 && /apuntes\.txt/.test(inA.files[0]) && inA.account, inA);

  // Another chat: none of A's things.
  await page.evaluate(() => { newChat(); });
  await page.waitForTimeout(200);
  const inB = await pills();
  check('a new chat does not carry chat A\'s attachments or account', inB.files.length === 0 && !inB.account, inB);
  await page.evaluate(async () => { await addFilesToComposer([new File(['b'], 'solo-b.txt', { type: 'text/plain' })]); });
  const chatB = await page.evaluate(() => getActiveChat().id);

  // Back to A: its own things again.
  await page.evaluate((id) => window.inhouseLearnOpenChat(id), chatA);
  await page.waitForTimeout(200);
  const backA = await pills();
  check('back in chat A, its attachment and account are there (and not B\'s file)', backA.files.length === 1 && /apuntes\.txt/.test(backA.files[0]) && backA.account, backA);

  // Reload (like closing and opening the app): they stay.
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(1800);
  const reloaded = await pills();
  const active = await page.evaluate(() => appState.activeChatId);
  check('after a reload chat A still has its attachment and its account', active === chatA && reloaded.files.length === 1 && reloaded.account, { active, reloaded });
  await page.evaluate((id) => window.inhouseLearnOpenChat(id), chatB);
  await page.waitForTimeout(200);
  const reloadedB = await pills();
  check('…and chat B its own file, without A\'s account', reloadedB.files.length === 1 && /solo-b\.txt/.test(reloadedB.files[0]) && !reloadedB.account, reloadedB);

  // Removing them: gone, also after a reload.
  await page.evaluate((id) => window.inhouseLearnOpenChat(id), chatA);
  await page.waitForTimeout(200);
  await page.click('#composer-attachments [data-remove-attachment-id]');
  await page.click('#composer-attachments [data-remove-extra-google]');
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(1800);
  const removed = await pills();
  check('what the user removes stays removed after a reload', removed.files.length === 0 && !removed.account, removed);

  // Deleting chat B forgets its attachment.
  await page.evaluate(async (id) => { forgetChatComposer(id); }, chatB);
  await page.waitForTimeout(400);
  const gone = await page.evaluate(async (id) => { const db = await draftsDb(); return new Promise((r) => { const q = db.transaction('attachments').objectStore('attachments').get(id); q.onsuccess = () => r(q.result || null); }); }, chatB);
  check('deleting a chat forgets its attachments', gone === null, gone);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
