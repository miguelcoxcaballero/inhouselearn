// What the chat shows and what it does not: reasoning a model writes inside its
// answer (<think>…</think>, or only a closing tag) goes to the thinking section,
// not the message; a model stuck repeating the same lines is cut, keeping what
// came before, and the queue goes on; «Muéstramelo en visual» is only for
// Guided Learning; confirmations (copied, connected, approved…) show no dark
// notice: the copy button itself turns green.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  const last = () => page.evaluate(() => { const m = getActiveChat().messages.slice(-1)[0]; const el = document.querySelector('#thread .message:last-child .md-root'); return { content: m.content, thinking: m.thinking || '', shown: el ? el.innerText : '' }; });

  // 1. <think> blocks, and a lone closing tag, go to the thinking section.
  await page.evaluate(() => window.__replies.push({ text: '<think>Plan: explain the slope first, then the formula. Wait, keep it short.</think>La derivada es la pendiente de la función en un punto.' }));
  await send(page, '¿Qué es una derivada?');
  await idle(page);
  const one = await last();
  check('<think>…</think> leaves the answer and goes to the thinking section', one.content === 'La derivada es la pendiente de la función en un punto.' && /explain the slope/.test(one.thinking) && !/Plan:|Wait/.test(one.shown), one);
  await page.evaluate(() => window.__replies.push({ text: 'Then a short note about what they see. Let me check the JSON.</think>Una integral suma áreas muy pequeñas.' }));
  await send(page, '¿Y una integral?');
  await idle(page);
  const two = await last();
  check('reasoning closed by a lone </think> is moved too', two.content === 'Una integral suma áreas muy pequeñas.' && /short note/.test(two.thinking), two);
  const engine = await page.evaluate(() => [InhousePi.splitReasoning('<thinking>a</thinking>b'), InhousePi.splitReasoning('sin etiquetas, con <b>negrita</b>'), InhousePi.splitReasoning('Hola <think>todavía pensando')]);
  check('engine: <thinking>, plain text and an unclosed <think> while streaming', engine[0].text === 'b' && engine[0].thinking === 'a' && engine[1].text === 'sin etiquetas, con <b>negrita</b>' && !engine[1].thinking && engine[2].text === 'Hola ' && engine[2].thinking === 'todavía pensando', engine);

  // 2. A loop is cut: what came before stays, the repetition goes, the queue goes on.
  const loop = 'Aquí tienes la vista previa con el tema oscuro y el botón naranja.\n\n' + 'Emit.\nAlso ensure `data-th=light` unquoted ✓.\n'.repeat(80);
  await page.evaluate((r) => window.__replies.push({ text: r, chunk: 40, delay: 5 }, { text: 'Respuesta a lo que estaba en la cola.' }), loop);
  await send(page, 'Enséñamelo');
  await page.waitForFunction(() => appState.busy);
  await page.fill('#composer', 'Lo siguiente');
  await page.press('#composer', 'Enter');
  await idle(page, 30000);
  await page.waitForFunction(() => getActiveChat().messages.slice(-1)[0].content === 'Respuesta a lo que estaba en la cola.', null, { timeout: 15000 }).catch(() => {});
  const cut = await page.evaluate(() => getActiveChat().messages.slice(-4).map((m) => m.role[0] + ':' + m.content));
  const answer = cut[1] || '';
  check('a model repeating itself is cut, the useful part stays, with a note', /^a:Aquí tienes la vista previa/.test(answer) && (answer.match(/Emit\./g) || []).length <= 3 && /el modelo se había quedado repitiendo/.test(answer), answer.slice(0, 300));
  check('…and the queued message still goes out afterwards', cut[2] === 'u:Lo siguiente' && cut[3] === 'a:Respuesta a lo que estaba en la cola.', cut.map((m) => m.slice(0, 40)));

  // 3. A long answer in a normal chat: no «Muéstramelo en visual»; Guided Learning keeps its «Muéstramelo».
  await page.evaluate(() => window.__replies.push({ text: 'Una explicación larga. '.repeat(20) }));
  await send(page, 'Explícame algo largo');
  await idle(page);
  const normal = await page.evaluate(() => ({ ask: !!document.querySelector('[data-ask-visual]'), text: (document.querySelector('#thread .message:last-child .g-quick') || {}).innerText || '' }));
  check('normal chat: no «Muéstramelo en visual» button', !normal.ask && !/Muéstramelo/.test(normal.text), normal);
  const guided = await page.evaluate(() => guidedQuickRepliesMarkup.toString().includes("visual: 'Muéstramelo'"));
  // A new chat starts with Guided Learning off, even if the last chat had it on.
  const fresh = await page.evaluate(() => { appState.guidedLearning = true; return createChat().guidedLearning; });
  check('a new chat starts with Guided Learning off', fresh === false, fresh);
  check('Guided Learning keeps its «Muéstramelo» quick reply', guided);

  // 4. No dark notices for confirmations: copy marks the button instead.
  // As on CI and some WebViews: no clipboard permission, the fallback still copies.
  await page.evaluate(() => { if (navigator.clipboard) navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
  await page.hover('#thread .message:last-child');
  await page.click('#thread .message:last-child [data-copy-msg]').catch(() => page.evaluate(() => copyMessageContent(getActiveChat().messages.slice(-1)[0].id)));
  await page.waitForTimeout(200);
  const copied = await page.evaluate(() => ({ toasts: document.querySelectorAll('.toast').length, button: !!document.querySelector('[data-copy-msg].copied') }));
  await page.evaluate(() => { getActiveChat().approvalMode = 'ask'; setApprovalMode('full'); });
  const approved = await page.evaluate(async () => { const ok = await approveChange(getActiveChat(), { title: 'Subir a GitHub' }); return { ok, toasts: document.querySelectorAll('.toast').length }; });
  check('copy, changing the approval mode and «Acceso total» approvals show no dark notice', copied.toasts === 0 && copied.button && approved.ok && approved.toasts === 0, { copied, approved });

  // 5. Code blocks have a «Copiar» button in their top right corner that copies the whole block.
  await page.evaluate(() => window.__replies.push({ text: 'Así:\n\n```js\nconst a = 1;\nconsole.log(a + 1);\n```\n\nY listo.' }));
  await send(page, 'Dame un ejemplo de código');
  await idle(page);
  await page.waitForSelector('#thread .message:last-child pre .code-copy');
  const place = await page.evaluate(() => { const pre = document.querySelector('#thread .message:last-child pre'); const b = pre.querySelector('.code-copy').getBoundingClientRect(); const p = pre.getBoundingClientRect(); return { right: Math.round(p.right - b.right), top: Math.round(b.top - p.top) }; });
  await page.evaluate(() => { document.execCommand = (cmd) => { window.__copied = document.activeElement && document.activeElement.value; return cmd === 'copy'; }; });
  await page.click('#thread .message:last-child pre .code-copy');
  await page.waitForTimeout(200);
  const copiedCode = await page.evaluate(() => ({ text: window.__copied, label: document.querySelector('#thread .message:last-child pre .code-copy').innerText }));
  check('code blocks: a «Copiar» button top right copies the whole block', place.right <= 10 && place.top <= 10 && copiedCode.text === 'const a = 1;\nconsole.log(a + 1);' && /Copiado/.test(copiedCode.label), { place, copiedCode });

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
