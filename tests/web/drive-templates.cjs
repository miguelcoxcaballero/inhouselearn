// A Word template (.dotx) in the user's Drive (a shared drive, like «Documento
// Extenso.dotx»): drive_read reads its text, drive_import brings the file itself
// into the chat, doc_edit fills it with JSZip and saves it as .docx — the
// template becomes a normal document with the same header, margins and styles —
// and doc_view looks at the result. Drive and the model are fakes.
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

const MODEL = 'test/vision-model';
const fs = require('fs');
const path = require('path');
const modelsFile = path.join(process.env.OUT || require('os').tmpdir(), 'templates-models.json');
fs.writeFileSync(modelsFile, JSON.stringify({ data: [{ id: MODEL, name: 'Test: Vision', supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } }] }));
process.env.MODELS_JSON = modelsFile;

// Builds the template inside the page (docx + JSZip in the documents worker).
const MAKE_TEMPLATE = `
const doc = new docx.Document({
  styles: { paragraphStyles: [{ id: 'TituloInforme', name: 'Titulo Informe', run: { size: 44, bold: true, color: '1F3864' } }] },
  sections: [{
    properties: { page: { margin: { top: 2268, right: 1418, bottom: 1701, left: 1985 } } },
    headers: { default: new docx.Header({ children: [new docx.Paragraph('COMISIÓN EJECUTIVA AMPLIADA')] }) },
    children: [new docx.Paragraph({ style: 'TituloInforme', children: [new docx.TextRun('{{TITULO}}')] }), new docx.Paragraph('{{CUERPO}}')]
  }]
});
const bytes = new Uint8Array(await (await docx.Packer.toBlob(doc)).arrayBuffer());
const zip = await JSZip.loadAsync(bytes);
let types = await zip.file('[Content_Types].xml').async('string');
types = types.replace('wordprocessingml.document.main+xml', 'wordprocessingml.template.main+xml');
zip.file('[Content_Types].xml', types);
saveDocument('plantilla.dotx', zip);
`;

const FILL = `
const zip = await JSZip.loadAsync(await readDocument('Documento Extenso.dotx'));
let xml = await zip.file('word/document.xml').async('string');
xml = xml.replace('{{TITULO}}', 'Informe del XXXIV').replace('{{CUERPO}}', 'Indra (Platino) y GMV (Oro) captadas.');
zip.file('word/document.xml', xml);
saveDocument('informe.docx', zip);
`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1000, height: 820 } });
  await page.evaluate((m) => { getActiveChat().model = m; getActiveChat().approvalMode = 'auto'; }, MODEL);

  const made = await page.evaluate(async (code) => {
    const out = await InhouseDocs.run(code, { list: async () => [], open: async () => null });
    if (out.error) return { error: out.error };
    let bin = ''; out.saved[0].bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return { b64: btoa(bin) };
  }, MAKE_TEMPLATE);
  if (made.error) throw new Error(made.error);
  const template = Buffer.from(made.b64, 'base64');
  const file = { id: 'tpl1', name: 'Documento Extenso.dotx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template', size: String(template.length), modifiedTime: '2025-12-01T10:00:00Z' };

  await page.route(/googleapis\.com/, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
    if (url.hostname === 'oauth2.googleapis.com') return json({ scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file' });
    if (url.pathname === '/drive/v3/files/tpl1') {
      if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: file.mimeType, headers: { 'access-control-allow-origin': '*' }, body: template });
      return json(file);
    }
    return json({ files: [] });
  });
  await page.evaluate(() => {
    appState.accessToken = 'user-token';
    appState.accessTokenExpiresAt = Date.now() + 3600000;
    localStorage.setItem(STORAGE_KEY + '::userDrive', 'read');
    getActiveChat().userDrive = true;
  });

  await page.evaluate((fill) => window.__replies.push(
    { text: '', tools: [{ name: 'drive_read', args: { id: 'tpl1' } }] },
    { text: '', tools: [{ name: 'drive_import', args: { id: 'https://drive.google.com/file/d/tpl1/view' } }] },
    { text: '', tools: [{ name: 'doc_edit', args: { code: fill } }] },
    { text: '', tools: [{ name: 'doc_view', args: { document: 'informe.docx' } }] },
    { text: 'Informe hecho con la plantilla.' }), FILL);
  await send(page, 'Haz el informe con la plantilla Documento Extenso');
  await idle(page, 90000);

  const steps = await page.evaluate(() => getActiveChat().messages.slice(-1)[0].toolSteps.map((s) => ({ name: s.name, status: s.status, out: String(s.output || '').slice(0, 300) })));
  const read = steps.find((s) => s.name === 'drive_read');
  check('drive_read reads a .dotx template from Drive as text (no more «no sé leer este tipo»)', read && read.status === 'done' && /\{\{TITULO\}\}/.test(read.out) && /drive_import/.test(read.out), read);
  const imp = steps.find((s) => s.name === 'drive_import');
  check('drive_import brings the template itself into the chat library', imp && imp.status === 'done' && /D1 · Documento Extenso\.dotx/.test(imp.out) && /plantilla/.test(imp.out), imp);

  const result = await page.evaluate(async () => {
    const chat = getActiveChat();
    const file = await InhouseLibrary.original(chat.id, 'informe.docx');
    if (!file || !file.bytes) return { missing: true };
    const zip = await JSZip.loadAsync(file.bytes);
    const types = await zip.file('[Content_Types].xml').async('string');
    const docXml = await zip.file('word/document.xml').async('string');
    const headers = Object.keys(zip.files).filter((n) => /^word\/header\d*\.xml$/.test(n));
    const headerText = headers.length ? await zip.file(headers[0]).async('string') : '';
    const text = (await InhouseLibrary.read(chat.id, 'informe.docx')).text;
    return {
      document: types.includes('wordprocessingml.document.main+xml') && !types.includes('template.main+xml'),
      header: /COMISIÓN EJECUTIVA AMPLIADA/.test(headerText),
      margins: /w:top="2268"/.test(docXml) && /w:left="1985"/.test(docXml),
      style: /w:pStyle w:val="TituloInforme"/.test(docXml),
      filled: /Informe del XXXIV/.test(text) && /Indra \(Platino\)/.test(text) && !/\{\{/.test(text)
    };
  });
  check('saved as .docx the filled template is a normal Word document…', result.document, result);
  check('…with the template\'s header, margins and title style intact, and the text filled in', result.header && result.margins && result.style && result.filled, result);

  const view = steps.find((s) => s.name === 'doc_view');
  const image = await page.evaluate(() => window.__requests.slice(-1)[0].messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')));
  check('doc_view shows the model the finished document as a picture', view && view.status === 'done' && image, view);

  // The template can also be viewed directly (a .dotx renders like a .docx).
  const direct = await page.evaluate(async () => { const f = await InhouseLibrary.original(getActiveChat().id, 'D1'); const r = await InhouseDocs.render(f, { pages: '1' }); return r.images.length; });
  check('a .dotx renders page by page like a .docx', direct === 1, direct);

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
