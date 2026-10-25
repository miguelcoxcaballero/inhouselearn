// The model's working tools (harness audit, round 1): read_file by line ranges
// with numbers, search_files (grep/glob), write_file never overwrites a file the
// model has not seen, edit_file replace_all, run_js keeps its console when a path
// is refused, library tools even with an empty library (delete_library asks),
// docx through destructuring, ask_user (answers to tap above the composer),
// update_plan (a checklist in the thread) and the date in the system prompt.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 700) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1100, height: 900 } });
  const prompts = [];
  await page.exposeFunction('__seenPrompt', (text) => prompts.push(text));
  await page.evaluate(() => {
    const orig = window.fetch;
    window.fetch = (input, init) => {
      try { const body = JSON.parse((init && init.body) || '{}'); if (body.messages && body.messages[0] && body.messages[0].role === 'system') { const last = body.messages.filter((m) => m.role === 'user').pop(); window.__seenPrompt(String(body.messages[0].content) + '\n' + (last ? JSON.stringify(last.content) : '')); } } catch (_) {}
      return orig(input, init);
    };
    getActiveChat().approvalMode = 'auto';
    const lines = Array.from({ length: 3000 }, (_, i) => 'línea ' + (i + 1) + (i === 2499 ? ' MARCA' : ''));
    getActiveChat().files = {
      'largo.txt': { content: lines.join('\n'), updatedAt: new Date().toISOString() },
      'apuntes/tema1.md': { content: '# Tema 1\nLa mitosis da dos células.\nfin', updatedAt: new Date().toISOString() },
      'apuntes/tema2.md': { content: '# Tema 2\nLa meiosis da cuatro células.\nMeiosis otra vez', updatedAt: new Date().toISOString() },
      'codigo.js': { content: 'const a = 1;\nconst b = 2;\nconsole.log(a);\n', updatedAt: new Date().toISOString() }
    };
  });
  const steps = () => page.evaluate(() => getActiveChat().messages.slice(-1)[0].toolSteps.map((s) => ({ name: s.name, status: s.status, output: s.output })));

  // 1. read_file: numbered lines, a range, and where to go on.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [
    { name: 'read_file', args: { path: 'largo.txt' } },
    { name: 'read_file', args: { path: 'largo.txt', offset: 2498, limit: 3 } },
    { name: 'read_file', args: { path: 'informe.pdf' } }
  ] }, { text: 'Leído.' }));
  await send(page, 'Lee el archivo');
  await idle(page);
  let s = await steps();
  check('read_file numbers the lines (and stops under its limit)', /^largo\.txt · líneas 1-\d+ de 3000/.test(s[0].output) && /\n\s*1→línea 1\n/.test(s[0].output), s[0].output.slice(0, 120) + ' … ' + s[0].output.slice(-90));
  check('read_file with offset/limit returns exactly those lines', /líneas 2498-2500 de 3000/.test(s[1].output) && /2500→línea 2500 MARCA/.test(s[1].output) && !/2501→/.test(s[1].output), s[1].output);
  check('a document name in read_file points to the library', s[2].status === 'error' && /biblioteca/.test(s[2].output) && /apuntes\/tema1\.md/.test(s[2].output), s[2].output);

  // 2. search_files: plain text, regex, glob, context; listing by glob.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [
    { name: 'search_files', args: { pattern: 'meiosis' } },
    { name: 'search_files', args: { pattern: 'c[eé]lulas', regex: true, path: 'apuntes/*.md', context: 1 } },
    { name: 'search_files', args: { pattern: '', path: '*.md' } },
    { name: 'search_files', args: { pattern: 'a.1', path: '*.js' } }
  ] }, { text: 'Buscado.' }));
  await send(page, 'Busca');
  await idle(page);
  s = await steps();
  check('search_files finds every line, case-insensitive, with file:line', /^2 coincidencias en 1 archivo/.test(s[0].output) && /apuntes\/tema2\.md:2: La meiosis/.test(s[0].output) && /apuntes\/tema2\.md:3: Meiosis/.test(s[0].output), s[0].output);
  check('…a regex limited by a glob, with context lines', /2 coincidencias en 2 archivos/.test(s[1].output) && /tema1\.md:1- # Tema 1/.test(s[1].output) && !/largo/.test(s[1].output), s[1].output);
  check('…an empty pattern lists the files the glob matches', /2 archivos/.test(s[2].output) && /tema1\.md/.test(s[2].output) && !/codigo/.test(s[2].output), s[2].output);
  check('…plain text is not a regex («a.1» does not match «a = 1»)', /^Nada/.test(s[3].output), s[3].output);

  // 3. write_file over a file never seen → refused; after reading or with overwrite → fine.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [
    { name: 'write_file', args: { path: 'codigo.js', content: 'nuevo' } },
    { name: 'write_file', args: { path: 'nuevo.md', content: 'uno' } },
    { name: 'write_file', args: { path: 'nuevo.md', content: 'dos' } },
    { name: 'write_file', args: { path: 'codigo.js', content: 'sustituido', overwrite: true } }
  ] }, { text: 'Escrito.' }));
  await send(page, 'Escribe');
  await idle(page);
  s = await steps();
  const files = await page.evaluate(() => ({ code: getActiveChat().files['codigo.js'].content, nuevo: getActiveChat().files['nuevo.md'].content }));
  check('write_file refuses to overwrite a file the model has not read', s[0].status === 'error' && /no lo has leído/.test(s[0].output), s[0].output);
  check('…but rewrites its own file and accepts overwrite: true', s[2].status === 'done' && /Sustituido nuevo\.md/.test(s[2].output) && files.nuevo === 'dos' && files.code === 'sustituido', { s, files });
  await page.evaluate(() => { getActiveChat().files['nuevo.md'].content = 'cambiado por el usuario'; window.__replies.push({ text: '', tools: [{ name: 'write_file', args: { path: 'nuevo.md', content: 'tres' } }] }, { text: 'Vale.' }); });
  await send(page, 'Otra vez');
  await idle(page);
  s = await steps();
  check('…and refuses when the file changed since the model saw it', s[0].status === 'error' && await page.evaluate(() => getActiveChat().files['nuevo.md'].content) === 'cambiado por el usuario', s[0].output);

  // 4. edit_file replace_all; run_js keeps its console when a write is refused.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [
    { name: 'edit_file', args: { path: 'apuntes/tema2.md', old_text: 'eiosis', new_text: 'EIOSIS' } },
    { name: 'edit_file', args: { path: 'apuntes/tema2.md', old_text: 'eiosis', new_text: 'EIOSIS', replace_all: true } },
    { name: 'run_js', args: { code: 'console.log("antes"); writeFile("../fuera.txt", "x"); writeFile("ok.txt", "bien"); return 42;' } }
  ] }, { text: 'Editado.' }));
  await send(page, 'Edita');
  await idle(page);
  s = await steps();
  check('edit_file suggests replace_all when the text repeats, and replace_all changes every one', /replace_all/.test(s[0].output) && /\(2 sitios\)/.test(s[1].output) && await page.evaluate(() => getActiveChat().files['apuntes/tema2.md'].content) === '# Tema 2\nLa mEIOSIS da cuatro células.\nMEIOSIS otra vez', [s[0].output, s[1].output]);
  check('run_js: a refused path keeps the console, the return and the good file', /console:\nantes/.test(s[2].output) && /return:\n42/.test(s[2].output) && /archivos guardados: ok\.txt/.test(s[2].output) && /no guardados:\n\.\.\/fuera\.txt/.test(s[2].output), s[2].output);

  // 5. Library tools with an empty library; docx via destructuring; delete_library asks.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [
    { name: 'list_library', args: {} },
    { name: 'doc_edit', args: { code: 'const { Document, Paragraph, TextRun } = docx;\nconst d = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("Hola desde docx")] })] }] });\nsaveDocument("prueba.docx", d);' } },
    { name: 'list_library', args: {} },
    { name: 'delete_library', args: { ref: 'D1' } }
  ] }, { text: 'Biblioteca.' }));
  await send(page, 'Biblioteca');
  await page.waitForSelector('.dock-approve', { timeout: 60000 });
  const card = await page.evaluate(() => document.querySelector('.dock-approve').innerText);
  await page.click('.dock-approve [data-dock="approve"]');
  await idle(page, 60000);
  s = await steps();
  const left = await page.evaluate(async () => (await InhouseLibrary.list(getActiveChat().id)).length);
  check('library tools exist with an empty library', s[0].status === 'done' && /vacía/.test(s[0].output), s[0]);
  check('doc_edit loads docx when the code destructures it (const { Document } = docx)', s[1].status === 'done' && /guardado en la biblioteca: D1 prueba\.docx/.test(s[1].output) && /D1 · prueba\.docx/.test(s[2].output), [s[1].output, s[2].output]);
  check('delete_library asks first and deletes the document', /Borrar de la biblioteca/.test(card) && /D1 · prueba\.docx/.test(card) && s[3].status === 'done' && left === 0, { card, out: s[3].output, left });

  // 6. ask_user: a card above the composer, the answer goes back to the model.
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'ask_user', args: { question: '¿Qué formato prefieres?', options: ['PDF con LaTeX', 'Word', 'Solo en el chat'] } }] }, { text: 'Hecho en PDF.' }));
  await send(page, 'Hazme un resumen');
  await page.waitForSelector('.dock-ask', { timeout: 15000 });
  const ask = await page.evaluate(() => ({ q: document.querySelector('.dock-ask b').textContent, options: [...document.querySelectorAll('.dock-ask-option')].map((b) => b.textContent), live: (document.querySelector('.live-now-text') || {}).textContent }));
  await page.click('.dock-ask-option[data-i="0"]');
  await idle(page);
  s = await steps();
  check('ask_user shows the question and its answers above the composer', ask.q === '¿Qué formato prefieres?' && ask.options.join('|') === 'PDF con LaTeX|Word|Solo en el chat' && /Esperando tu respuesta/.test(ask.live || ''), ask);
  check('…and a tap answers the model', s[0].status === 'done' && /El usuario responde: PDF con LaTeX/.test(s[0].output) && !(await page.$('.dock-ask')), s[0].output);
  await page.evaluate(() => window.__replies.push({ text: '', tools: [{ name: 'ask_user', args: { question: '¿Qué temas?', options: ['Mitosis', 'Meiosis'], multiple: true } }] }, { text: 'Vale.' }));
  await send(page, 'Repaso');
  await page.waitForSelector('.dock-ask', { timeout: 15000 });
  await page.click('.dock-ask-option[data-i="1"]');
  await page.click('.dock-ask-option[data-i="0"]');
  await page.fill('.dock-ask-input', 'y la célula');
  await page.click('.dock-ask [data-dock="ask-send"]');
  await idle(page);
  s = await steps();
  check('…several answers plus their own words', /El usuario responde: Mitosis; Meiosis; y la célula/.test(s[0].output), s[0].output);

  // 7. update_plan: a checklist in the thread, the latest version.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'update_plan', args: { items: [{ text: 'Leer los apuntes', status: 'in_progress' }, { text: 'Escribir el resumen', status: 'pending' }, { text: 'Revisarlo', status: 'pending' }] } }] },
    { text: '', tools: [{ name: 'update_plan', args: { items: [{ text: 'Leer los apuntes', status: 'done' }, { text: 'Escribir el resumen', status: 'done' }, { text: 'Revisarlo', status: 'in_progress' }] } }] },
    { text: 'Resumen listo.' }));
  await send(page, 'Trabajo largo');
  await idle(page);
  const plan = await page.evaluate(() => { const el = document.querySelector('#thread .message:last-child .plan-card'); return el && { head: el.querySelector('.plan-head').innerText, items: [...el.querySelectorAll('li')].map((li) => li.className + ':' + li.innerText), steps: !!document.querySelector('#thread .message:last-child .tool-steps') }; });
  check('update_plan draws its latest checklist in the thread (no step box for it)', plan && /2\/3/.test(plan.head) && plan.items.join('|') === 'done:Leer los apuntes|done:Escribir el resumen|in_progress:Revisarlo' && !plan.steps, plan);

  // 8. The system prompt says the date and the tools.
  const last = prompts[prompts.length - 1] || '';
  check('the system prompt carries the current date and the new tools', /Ahora: [a-zé]+, \d{1,2} de [a-z]+ de 20\d\d/.test(last) && /search_files/.test(last) && /update_plan/.test(last) && /Biblioteca del chat: vacía/.test(last), (last.match(/Ahora:[^\n]*/) || [''])[0]);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
