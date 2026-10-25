// Three bugs of the composer area: the files strip scrolls sideways (wheel and
// mouse drag, a drag never opens a file); the model pill's chip shows «Ultra code»
// (the rainbow word was invisible on the chip's own background); and a turn that
// ends without words says so instead of leaving a blank answer, while an answer
// that mentions an unclosed <thinking> tag keeps its text.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 900, height: 800 } });

  // 1. Files strip.
  await page.evaluate(() => {
    const ws = chatWorkspace(getActiveChat());
    for (let i = 0; i < 14; i++) ws.write('archivo_largo_numero_' + i + '.tex', '% ' + i);
    renderWorkspaceBar();
  });
  await page.waitForTimeout(200);
  const strip = await page.$('.workspace-files');
  const box = await strip.boundingBox();
  const before = await page.evaluate(() => ({ left: document.querySelector('.workspace-files').scrollLeft, overflow: document.querySelector('.workspace-files').scrollWidth > document.querySelector('.workspace-files').clientWidth, fade: document.querySelector('.workspace-files').classList.contains('more-right') }));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(150);
  const afterWheel = await page.evaluate(() => document.querySelector('.workspace-files').scrollLeft);
  check('the files strip overflows and the mouse wheel scrolls it sideways', before.overflow && before.fade && afterWheel > before.left + 100, { before, afterWheel });
  await page.evaluate(() => { window.__opened = 0; const original = window.openWorkspaceFile; window.openWorkspaceFile = (...args) => { window.__opened++; return original && original(...args); }; document.querySelector('.workspace-files').scrollLeft = 0; });
  await page.waitForTimeout(100);
  await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 140, box.y + box.height / 2, { steps: 6 });
  await page.mouse.move(box.x + box.width - 260, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const drag = await page.evaluate(() => ({ left: document.querySelector('.workspace-files').scrollLeft, preview: !document.getElementById('preview-overlay').classList.contains('hidden'), dragging: document.querySelector('.workspace-files').classList.contains('dragging') }));
  check('dragging it with the mouse scrolls it and does not open the file under the pointer', drag.left > 150 && !drag.preview && !drag.dragging, drag);

  // 2. The level chip next to the model.
  const chip = await page.evaluate(() => {
    const chat = getActiveChat();
    chat.model = 'deepseek/deepseek-v4.1-flash';
    chat.ultraCode = true;
    updateConfigUi();
    const meta = elements.modelTriggerMeta;
    const word = meta.querySelector('.ultra-text');
    const style = word && getComputedStyle(word);
    return { visible: !meta.classList.contains('hidden'), text: meta.textContent, word: !!word, gradient: style ? /gradient/.test(style.backgroundImage) : false, clip: style ? (style.webkitBackgroundClip || style.backgroundClip) : '', chipBg: getComputedStyle(meta).backgroundColor, chipClass: meta.classList.contains('ultra-text') };
  });
  check('with Ultra code the chip shows the rainbow word «Ultra code» (gradient on the word, not hidden by the chip)', chip.visible && chip.text === 'Ultra code' && chip.word && chip.gradient && chip.clip === 'text' && !chip.chipClass && /rgba\(0, 0, 0, 0\)|transparent/.test(chip.chipBg), chip);
  await page.evaluate(() => { const chat = getActiveChat(); chat.ultraCode = false; updateConfigUi(); });

  // 3. Empty answers and unclosed tags.
  await page.evaluate(() => { newChat(); window.__replies.push({ text: '' }); });
  await send(page, 'Hola');
  await idle(page);
  const empty = await page.evaluate(() => { const m = getActiveChat().messages.filter((x) => x.role === 'assistant').pop(); return { error: m.error || '', content: m.content || '', shown: document.querySelector('#thread .message:last-child').textContent }; });
  check('a turn that ends without any words says so (no blank answer)', /sin escribir ninguna respuesta/.test(empty.error + empty.shown), empty);
  await page.evaluate(() => window.__replies.push({ text: 'En LaTeX no existe la etiqueta <thinking> pero puedes definir un entorno propio.' }));
  await send(page, '¿Existe <thinking> en LaTeX?');
  await idle(page);
  const tag = await page.evaluate(() => { const m = getActiveChat().messages.filter((x) => x.role === 'assistant').pop(); return { content: m.content, error: m.error || '' }; });
  check('an answer that mentions an unclosed <thinking> tag keeps its text', /etiqueta <thinking> pero puedes definir un entorno propio\./.test(tag.content) && !tag.error, tag);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
