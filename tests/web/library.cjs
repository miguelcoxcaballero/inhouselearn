// Chat library: upload a folder (PDF with several pages, notes, a photo read
// by OCR, many small files), then the model finds what it needs with
// search_library / read_library / view_library_image.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));

// A real text PDF, one line of text per page.
function makePdf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const parent = objects.length + pages.length * 2 + 1;
  pages.forEach((text) => {
    const stream = 'BT /F1 14 Tf 40 760 Td (' + text.replace(/[()\\]/g, '') + ') Tj ET';
    const content = add('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
    pageIds.push(add('<< /Type /Page /Parent ' + parent + ' 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' + font + ' 0 R >> >> /Contents ' + content + ' 0 R >>'));
  });
  add('<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>');
  const catalog = add('<< /Type /Catalog /Pages ' + parent + ' 0 R >>');
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += (index + 1) + ' 0 obj\n' + body + '\nendobj\n'; });
  const xref = out.length;
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

// A small solid PNG.
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = 200; raw[i + 1] = 120; raw[i + 2] = 60; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-'));
  const dir = path.join(root, 'Biologia');
  fs.mkdirSync(path.join(dir, 'tema2', 'fotos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tema1.pdf'), makePdf(['Tema 1. La celula y sus partes', 'La fotosintesis ocurre en los cloroplastos y produce glucosa y oxigeno', 'El ciclo de Calvin fija el CO2 en la fase oscura']));
  fs.writeFileSync(path.join(dir, 'tema2', 'apuntes.md'), '# Respiración\n\nLa respiración celular ocurre en la mitocondria.\n\n' + 'Relleno de apuntes sin importancia. '.repeat(200) + '\n\nEl ATP sintasa produce ATP con el gradiente de protones.');
  fs.writeFileSync(path.join(dir, 'tema2', 'fotos', 'pizarra.png'), makePng(64, 48));
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, 'tema2', 'extra-' + i + '.txt'), 'Ejercicio ' + i + ': repaso general de biología número ' + i + '.');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors, context } = await openApp(browser, { viewport: { width: 1100, height: 850 } });
  await page.evaluate(() => { window.InhouseLibraryOcr = { recognize: async () => 'Pizarra: la mitocondria es la central energética' }; });

  const t0 = Date.now();
  await page.setInputFiles('#folder-input', dir);
  await page.waitForFunction(() => appState.composerAttachments.some((a) => a.source === 'library'), null, { timeout: 60000 });
  const ingestMs = Date.now() - t0;
  const pill = await page.evaluate(() => { const a = appState.composerAttachments.find((x) => x.source === 'library'); return { name: a.name, docs: a.docIds.length, manifest: a.part.text }; });
  console.log('manifest-tail', pill.manifest.split('\n').slice(-2).join(' | '));
  check('folder upload: one library pill, every readable file indexed, hidden files skipped', pill.docs === 43 && /^Biologia · 43 archivos/.test(pill.name) && /D1 · Biologia\/tema1\.pdf · PDF de 3 páginas/.test(pill.manifest) && !/DS_Store/.test(pill.manifest), Object.assign({ ingestMs }, pill));

  await page.waitForFunction(() => InhouseLibrary.status().ocrQueue === 0, null, { timeout: 20000 }).catch(() => {});
  const chatId = await page.evaluate(() => appState.activeChatId);
  const searches = await page.evaluate(async (id) => ({
    foto: (await InhouseLibrary.search(id, 'fotosíntesis cloroplastos')).hits.slice(0, 2).map((h) => h.ref + ' ' + h.snippet.slice(0, 40)),
    atp: (await InhouseLibrary.search(id, 'ATP sintasa')).hits[0],
    ocr: (await InhouseLibrary.search(id, 'central energetica')).hits[0]
  }), chatId);
  check('search: PDF page, a long note and an OCR\'d photo are found', /^D1:p2 /.test(searches.foto[0] || '') && searches.atp && /apuntes\.md/.test(searches.atp.name) && /ATP sintasa/.test(searches.atp.snippet) && searches.ocr && /pizarra\.png/.test(searches.ocr.name), searches);

  // The model searches, reads and looks at the photo; then answers.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'search_library', args: { query: 'fotosíntesis' } }] },
    { text: '', tools: [{ name: 'read_library', args: { ref: 'D1:p2', pages: '2-3' } }] },
    { text: '', tools: [{ name: 'view_library_image', args: { ref: 'pizarra.png' } }] },
    { text: 'La fotosíntesis ocurre en los cloroplastos (D1, pág. 2).' }
  ));
  await send(page, '¿Dónde ocurre la fotosíntesis según mis apuntes?');
  await idle(page, 60000);
  const flow = await page.evaluate(() => {
    const reqs = window.__requests;
    const sys = (reqs[0].messages.find((m) => m.role === 'system') || {}).content || '';
    const toolNames = (reqs[0].tools || []).map((t) => t.function.name);
    const results = reqs[reqs.length - 1].messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 300));
    const user = reqs[0].messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content)).join(' ');
    return { tools: toolNames.filter((n) => /library/.test(n)), sysHasLibrary: /Biblioteca del chat: el usuario ha subido 43 archivos/.test(sys), userSize: user.length, results, answer: getActiveChat().messages.slice(-1)[0].content };
  });
  check('model gets the library tools and a short manifest, not the files', flow.tools.length === 4 && flow.sysHasLibrary && flow.userSize < 9000, { tools: flow.tools, userSize: flow.userSize });
  check('search_library, read_library and view_library_image return the right content', /D1:p2 · Biologia\/tema1\.pdf · pág\. 2/.test(flow.results[0] || '') && /Página 2\][\s\S]*cloroplastos[\s\S]*Página 3\][\s\S]*Calvin/.test(flow.results[1] || '') && /mitocondria es la central/.test(flow.results[2] || ''), flow.results);
  check('answer cites the source', /D1, pág\. 2/.test(flow.answer), flow.answer);

  // Panel and persistence across a reload.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof runAssistantTurn === 'function');
  await page.waitForTimeout(1500);
  const chip = await page.locator('#workspace-library-btn').textContent().catch(() => '');
  await page.click('#workspace-library-btn').catch(() => {});
  await page.waitForTimeout(500);
  const panel = await page.evaluate(() => ({ rows: document.querySelectorAll('.library-row').length, title: document.getElementById('preview-title').textContent }));
  check('after reload the library is still there (chip and panel)', /Biblioteca · 43/.test(chip) && panel.rows === 43, { chip, panel });
  await page.screenshot({ path: SCRATCH + '/library-panel.png' });
  await page.click('#preview-close');
  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
  fs.rmSync(root, { recursive: true, force: true });
})();
