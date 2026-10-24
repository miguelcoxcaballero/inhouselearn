// Documents: the model creates PDF, Word, PowerPoint and Excel files with
// doc_edit (pdf-lib, docx, PptxGenJS, SheetJS in a worker), they land in the
// chat's library with their original, show under the answer (Ver/Descargar),
// doc_view hands the model each page as an image, an existing document is
// edited and replaced under the same reference, and «Preguntar» asks first.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

const MODEL = 'test/vision-model';
const modelsFile = path.join(SCRATCH, 'documents-models.json');
fs.writeFileSync(modelsFile, JSON.stringify({ data: [{ id: MODEL, name: 'Test: Vision', supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } }] }));
process.env.MODELS_JSON = modelsFile;

const CREATE = `
const pdf = await PDFLib.PDFDocument.create();
const page = pdf.addPage([595, 842]);
const font = await pdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
page.drawText('Informe de prueba', { x: 60, y: 760, size: 28, font, color: PDFLib.rgb(0.1, 0.1, 0.1) });
page.drawRectangle({ x: 60, y: 500, width: 300, height: 150, color: PDFLib.rgb(0.85, 0.1, 0.1) });
saveDocument('informe.pdf', pdf);

const doc = new docx.Document({ sections: [{ children: [
  new docx.Paragraph({ text: 'Acta de la reunión', heading: docx.HeadingLevel.HEADING_1 }),
  new docx.Paragraph({ children: [new docx.TextRun({ text: 'Se aprueba el presupuesto de la fotosíntesis.', bold: true })] })
] }] });
saveDocument('acta.docx', doc);

const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_16x9';
const s1 = pptx.addSlide();
s1.background = { color: 'FFFFFF' };
s1.addShape(pptx.ShapeType.rect, { x: 0.5, y: 0.5, w: 4, h: 3, fill: { color: '1E40AF' } });
s1.addText('Fase luminosa', { x: 5, y: 1, w: 4.5, h: 1, fontSize: 32, bold: true, color: '111111' });
const s2 = pptx.addSlide();
s2.addText('Ciclo de Calvin', { x: 1, y: 1, w: 8, h: 1, fontSize: 28, color: '111111' });
s2.addNotes('Recordar el ATP');
saveDocument('clase.pptx', pptx);

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Mes', 'Gasto'], ['Enero', 120], ['Febrero', 95]]), 'Gastos');
saveDocument('gastos.xlsx', wb);
console.log(listDocuments().length + ' antes');
return 'ok';
`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  await page.evaluate((model) => { const chat = getActiveChat(); chat.model = model; chat.approvalMode = 'auto'; saveState({ skipDrive: true }); }, MODEL);

  // 1. Create four documents in one doc_edit call.
  await page.evaluate((code) => window.__replies.push(
    { text: '', tools: [{ name: 'doc_edit', args: { code } }] },
    { text: '', tools: [{ name: 'doc_view', args: { document: 'clase.pptx' } }, { name: 'doc_view', args: { document: 'acta.docx' } }, { name: 'doc_view', args: { document: 'D1' } }, { name: 'doc_view', args: { document: 'gastos.xlsx' } }] },
    { text: 'Aquí tienes los cuatro documentos.' }), CREATE);
  await send(page, 'Hazme un PDF, un Word, un PowerPoint y un Excel');
  await idle(page, 90000);
  const made = await page.evaluate(async () => {
    const chat = getActiveChat();
    const docs = await InhouseLibrary.list(chat.id);
    const m = chat.messages.slice(-1)[0];
    const edit = m.toolSteps.find((step) => step.name === 'doc_edit');
    return { docs: docs.map((d) => [d.ref, d.path, d.kind, d.hasOriginal, d.generated]), status: edit && edit.status, output: edit && edit.output, cards: Array.from(document.querySelectorAll('#thread .message:last-child .msg-doc b')).map((b) => b.textContent) };
  });
  check('doc_edit creates a PDF, a Word, a PowerPoint and an Excel in the chat library, originals kept', made.status === 'done' && made.docs.length === 4 &&
    made.docs.every((d) => d[3] && d[4]) && made.docs.map((d) => d[2]).join() === 'pdf,doc,slides,sheet', made);
  check('…and the answer shows them with «Ver» and «Descargar»', made.cards.join() === 'informe.pdf,acta.docx,clase.pptx,gastos.xlsx', made.cards);

  // 2. doc_view sent the model real pictures of each page.
  const viewed = await page.evaluate(() => {
    const body = window.__requests[2];
    const tools = body.messages.filter((m) => m.role === 'tool' || (m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')));
    const images = [];
    body.messages.forEach((m) => (Array.isArray(m.content) ? m.content : []).forEach((c) => { if (c.type === 'image_url') images.push(c.image_url.url.length); }));
    const texts = body.messages.filter((m) => m.role === 'tool').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    return { images, texts: texts.slice(0, 900), n: tools.length };
  });
  check('doc_view gives the model each page/slide/sheet as an image (2 slides, Word, PDF, sheet)', viewed.images.length >= 5 && viewed.images.every((len) => len > 3000) && /2 diapositivas/.test(viewed.texts) && /hoja/.test(viewed.texts), viewed);

  // 3. The pictures look like the documents: the slide's blue box and the PDF's red one.
  const pixels = await page.evaluate(async () => {
    const chat = getActiveChat();
    const at = async (ref, fx, fy) => {
      const file = await InhouseLibrary.original(chat.id, ref);
      const out = await InhouseDocs.render(file, { pages: '1' });
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + out.images[0].data;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(Math.round(img.width * fx), Math.round(img.height * fy), 1, 1).data.slice(0, 3));
    };
    const slideDark = async () => {
      const file = await InhouseLibrary.original(chat.id, 'clase.pptx');
      const out = await InhouseDocs.render(file, { pages: '2' });
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + out.images[0].data;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) dark++;
      return dark;
    };
    // pptx: box at x 0.5..4.5 in of 10 in, y 0.5..3.5 of 5.625 → centre (0.25, 0.356)
    return { slide: await at('clase.pptx', 0.25, 0.356), pdf: await at('informe.pdf', (60 + 150) / 595, 1 - (500 + 75) / 842), text: await slideDark() };
  });
  check('the slide picture has its blue box and its text; the PDF its red box', pixels.slide[2] > 120 && pixels.slide[0] < 80 && pixels.pdf[0] > 170 && pixels.pdf[1] < 80 && pixels.text > 300, pixels);

  if (process.env.DUMP) {
    const dumps = await page.evaluate(async () => { const chat = getActiveChat(); const out = {}; for (const ref of ['D1', 'D2', 'D3', 'D4']) { const file = await InhouseLibrary.original(chat.id, ref); out[ref] = (await InhouseDocs.render(file, {})).images.map((i) => i.data); } return out; });
    Object.entries(dumps).forEach(([ref, list]) => list.forEach((data, i) => fs.writeFileSync(path.join(SCRATCH, 'doc-' + ref + '-' + (i + 1) + '.jpg'), Buffer.from(data, 'base64'))));
  }

  // 4. The library reads them: the slides' text and notes are searchable.
  const read = await page.evaluate(async () => (await InhouseLibrary.read(getActiveChat().id, 'clase.pptx')).text);
  check('the library reads the PowerPoint slide by slide, notes included', /Diapositiva 1[\s\S]*Fase luminosa/.test(read) && /Ciclo de Calvin/.test(read) && /Recordar el ATP/.test(read), read);

  // 5. «Ver» opens every page; «Descargar» gives the file.
  await page.click('#thread .message:last-child .msg-doc:nth-child(3) [data-doc-open]');
  await page.waitForSelector('#preview-body .doc-page img', { timeout: 20000 });
  const preview = await page.evaluate(() => ({ title: document.getElementById('preview-title').textContent, pages: document.querySelectorAll('#preview-body .doc-page img').length }));
  await page.screenshot({ path: path.join(SCRATCH, 'documents-preview.png') });
  const download = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await page.click('#preview-body [data-doc-download]');
  const file = await download;
  const savedPath = file ? await file.path() : '';
  const head = savedPath ? fs.readFileSync(savedPath).slice(0, 2).toString() : '';
  check('«Ver» draws every slide; «Descargar» gives the real .pptx', preview.title === 'clase.pptx' && preview.pages === 2 && file && file.suggestedFilename() === 'clase.pptx' && head === 'PK', { preview, name: file && file.suggestedFilename(), head });
  await page.evaluate(() => document.getElementById('preview-overlay').classList.add('hidden'));

  // 6. Edit an existing document: same name, same reference, now two pages.
  await page.evaluate(() => window.__replies.push(
    { text: '', tools: [{ name: 'doc_edit', args: { code: "const pdf = await PDFLib.PDFDocument.load(await readDocument('D1'));\nconst p = pdf.addPage();\np.drawText('Anexo', { x: 50, y: 700, size: 24 });\nsaveDocument('informe.pdf', pdf);\nreturn pdf.getPageCount();" } }] },
    { text: 'Añadido el anexo.' }));
  await send(page, 'Añade un anexo al PDF');
  await idle(page, 60000);
  const edited = await page.evaluate(async () => {
    const chat = getActiveChat();
    const docs = await InhouseLibrary.list(chat.id);
    const pdf = docs.find((d) => d.path === 'informe.pdf');
    return { count: docs.length, ref: pdf && pdf.ref, pages: pdf && pdf.totalPages, output: chat.messages.slice(-1)[0].toolSteps[0].output };
  });
  check('editing reads the original and replaces it under the same reference (D1, 2 pages)', edited.count === 4 && edited.ref === 'D1' && edited.pages === 2 && /return:\n2/.test(edited.output), edited);

  // 7. «Preguntar»: saving asks; «No» saves nothing and tells the model.
  await page.evaluate(() => { getActiveChat().approvalMode = 'ask'; window.__replies.push(
    { text: '', tools: [{ name: 'doc_edit', args: { code: "saveDocument('borrador.docx', new docx.Document({ sections: [{ children: [new docx.Paragraph('x')] }] }));" } }] },
    { text: 'Vale, no lo guardo.' }); });
  await send(page, 'Haz un borrador');
  await page.waitForSelector('.dock-approve', { timeout: 30000 }).catch(() => null);
  const card = await page.evaluate(() => { const el = document.querySelector('.dock-approve'); return el ? el.innerText : ''; });
  if (card) await page.click('.dock-approve [data-dock="reject"]');
  await idle(page, 30000);
  const declined = await page.evaluate(async () => ({ count: (await InhouseLibrary.list(getActiveChat().id)).length, output: getActiveChat().messages.slice(-1)[0].toolSteps[0].output }));
  check('in «Preguntar» saving a document asks first, and «No» saves nothing', /borrador\.docx/.test(card) && declined.count === 4 && /no ha aprobado/.test(declined.output), { card, declined });

  // 8. A model without vision is told to read the text instead.
  const noVision = await page.evaluate(async () => {
    const tools = documentToolsFor(getActiveChat(), null, false);
    try { await tools.find((t) => t.name === 'doc_view').execute('x', { document: 'D1' }); return 'no error'; } catch (e) { return e.message; }
  });
  check('a model without vision is sent to read_library', /read_library/.test(noVision), noVision);

  // 9. A .pptx attached in the composer goes in as its slides' text, not as raw bytes.
  const attached = await page.evaluate(async () => {
    const file = await InhouseLibrary.original(getActiveChat().id, 'clase.pptx');
    const att = await prepareAttachment(new File([file.bytes], 'clase.pptx', { type: file.mimeType }));
    return { kind: att.kind, text: att.extractedText };
  });
  check('a PowerPoint attached in the composer is read slide by slide', attached.kind === 'slides' && /Diapositiva 1:\nFase luminosa/.test(attached.text) && /Ciclo de Calvin/.test(attached.text), attached);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
