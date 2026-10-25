/* ─── Documentos: ver y editar PDF, Word, PowerPoint y Excel ──────────
   Lo usan las herramientas doc_view y doc_edit (engine/src/documents.js) y
   la vista previa de la biblioteca.

   - render: cada página (PDF), página de Word, diapositiva o hoja como una
     imagen, para que el modelo «mire» el documento como lo vería el usuario.
     PDF con pdf.js, Word con docx-preview + html2canvas, PowerPoint con un
     dibujante propio sobre canvas (cajas, texto, imágenes, tablas, fondos),
     Excel con SheetJS + html2canvas.
   - run: el código del modelo corre en un Web Worker con pdf-lib, docx,
     PptxGenJS, JSZip y SheetJS, sin red ni DOM. Lee los documentos del chat
     con readDocument() y deja los nuevos con saveDocument(); quién los guarda
     (y la aprobación) lo decide la app.
   - pptxText: el texto de cada diapositiva (y sus notas) para la biblioteca.

   Las librerías se descargan solo la primera vez que hacen falta. */
(function () {
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const WORKER_LIBS = [
    { key: 'pdflib', url: 'pdf-lib@1.17.1/dist/pdf-lib.min.js', test: /\bPDFLib\b/ },
    // Any use of the global (docx.Document, const { Document } = docx…), not a file name like informe.docx.
    { key: 'docx', url: 'docx@9.5.1/dist/index.umd.cjs', test: /(^|[^.\w-])docx\b(?!\s*['"`])/ },
    { key: 'pptx', url: 'pptxgenjs@3.12.0/dist/pptxgen.bundle.js', test: /\bPptxGenJS\b/ },
    { key: 'jszip', url: 'jszip@3.10.1/dist/jszip.min.js', test: /./ },
    { key: 'xlsx', url: 'xlsx@0.18.5/dist/xlsx.full.min.js', test: /\bXLSX\b/ }
  ];
  const PAGE_SCRIPTS = {
    jszip: { url: CDN + 'jszip@3.10.1/dist/jszip.min.js', ready: () => window.JSZip },
    docxPreview: { url: CDN + 'docx-preview@0.3.5/dist/docx-preview.min.js', ready: () => window.docx && window.docx.renderAsync },
    html2canvas: { url: CDN + 'html2canvas@1.4.1/dist/html2canvas.min.js', ready: () => window.html2canvas }
  };
  const RUN_TIMEOUT_MS = 90000;
  const RENDER_WIDTH = 1280;
  const MIME = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
    xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
    csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', html: 'text/html', json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml'
  };

  function extOf(name) {
    const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return match ? match[1].toLowerCase() : '';
  }

  function kindOf(name, mime) {
    const ext = extOf(name);
    const type = String(mime || '').toLowerCase();
    if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
    // Templates (.dotx, .potx, .xltx) and macro files are the same packages.
    if (/^(docx|dotx|docm|dotm)$/.test(ext) || type === MIME.docx || /wordprocessingml|ms-word/.test(type)) return 'docx';
    if (/^(pptx|potx|pptm)$/.test(ext) || type === MIME.pptx || /presentationml|ms-powerpoint/.test(type)) return 'pptx';
    if (/^(xlsx|xltx|xlsm|xls|ods)$/.test(ext) || type === MIME.xlsx || /spreadsheetml|ms-excel/.test(type)) return 'xlsx';
    if (type.startsWith('image/') || /^(png|jpe?g|webp|gif|bmp)$/.test(ext)) return 'image';
    return '';
  }

  function mimeFor(name) {
    return MIME[extOf(name)] || 'application/octet-stream';
  }

  function bytesOf(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    return new Uint8Array(0);
  }

  // "3", "2-5", "1,3,7-8" → page numbers (1-based) within total, at most max.
  function pageList(spec, total, max) {
    const limit = Math.max(1, max || 6);
    if (spec == null || spec === '' || (Array.isArray(spec) && !spec.length)) {
      return Array.from({ length: Math.min(total, limit) }, (_, i) => i + 1);
    }
    const out = [];
    const parts = Array.isArray(spec) ? spec.map(String) : String(spec).split(/[,;\s]+/);
    for (const part of parts) {
      const range = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
      if (!range) continue;
      const from = Number(range[1]);
      const to = range[2] ? Number(range[2]) : from;
      for (let n = from; n <= to && out.length < limit; n++) if (n >= 1 && n <= total && !out.includes(n)) out.push(n);
    }
    return out;
  }

  const scriptPromises = {};
  function loadScript(key) {
    const spec = PAGE_SCRIPTS[key];
    if (spec.ready()) return Promise.resolve();
    if (!scriptPromises[key]) {
      scriptPromises[key] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = spec.url;
        script.async = true;
        script.onload = () => (spec.ready() ? resolve() : reject(new Error('No cargó ' + key)));
        script.onerror = () => reject(new Error('No se pudo descargar ' + key + ' (¿sin conexión?)'));
        document.head.appendChild(script);
      }).catch((error) => { delete scriptPromises[key]; throw error; });
    }
    return scriptPromises[key];
  }

  // A template (.dotx/.potx/.xltx) differs from its document only in the main
  // part's content type: rewritten, Word, PowerPoint and Excel open it as a
  // normal file with the template's cover, styles, headers and margins.
  function documentContentTypes(xml) {
    return xml
      .replace(/application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.template\.main\+xml|application\/vnd\.ms-word\.(template\.macroEnabledTemplate|document\.macroEnabled)\.main\+xml/g, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
      .replace(/application\/vnd\.openxmlformats-officedocument\.presentationml\.template\.main\+xml|application\/vnd\.ms-powerpoint\.(template|presentation)\.macroEnabled\.main\+xml/g, 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')
      .replace(/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.template\.main\+xml|application\/vnd\.ms-excel\.(template|sheet)\.macroEnabled\.main\+xml/g, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
  }
  async function asDocument(bytes) {
    const zip = await zipOf(bytes);
    const file = zip.file('[Content_Types].xml');
    if (!file) return bytes;
    const before = await file.async('string');
    const after = documentContentTypes(before);
    if (after === before) return bytes;
    zip.file('[Content_Types].xml', after);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  async function zipOf(bytes) {
    await loadScript('jszip');
    return window.JSZip.loadAsync(bytes);
  }

  function canvasImage(canvas, page) {
    return { page, mimeType: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.84).split(',')[1], width: canvas.width, height: canvas.height };
  }

  // An offscreen box the size of a page: html2canvas needs it in the document.
  function stage(width) {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-30000px;top:0;width:' + (width ? width + 'px' : 'max-content;max-width:2400px') + ';background:#fff;color:#000;pointer-events:none;';
    document.body.appendChild(host);
    return host;
  }

  /* ── PDF ─────────────────────────────────────────────────────────── */

  function pdfjs() {
    const lib = window.pdfjsLib;
    if (!lib || !lib.getDocument) throw new Error('pdf.js no está cargado.');
    if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }
    return lib;
  }

  async function renderPdf(bytes, spec, max) {
    const pdf = await pdfjs().getDocument({ data: bytes.slice() }).promise;
    try {
      const images = [];
      for (const n of pageList(spec, pdf.numPages, max)) {
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2.5, RENDER_WIDTH / base.width) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        images.push(canvasImage(canvas, n));
        if (page.cleanup) page.cleanup();
      }
      return { total: pdf.numPages, unit: 'página', images };
    } finally {
      if (pdf.destroy) pdf.destroy();
    }
  }

  /* ── Word ────────────────────────────────────────────────────────── */

  async function renderDocx(bytes, spec, max) {
    await loadScript('jszip');
    await loadScript('docxPreview');
    await loadScript('html2canvas');
    const host = stage(1000);
    try {
      await window.docx.renderAsync(new Blob([bytes]), host, host, { className: 'inhouse-docx', inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true });
      const pages = Array.from(host.querySelectorAll('section.inhouse-docx'));
      const images = [];
      for (const n of pageList(spec, pages.length, max)) {
        const section = pages[n - 1];
        const scale = Math.min(2, RENDER_WIDTH / Math.max(1, section.offsetWidth));
        images.push(canvasImage(await window.html2canvas(section, { scale, backgroundColor: '#ffffff', logging: false, useCORS: true }), n));
      }
      return { total: pages.length, unit: 'página', images };
    } finally {
      host.remove();
    }
  }

  /* ── Excel ───────────────────────────────────────────────────────── */

  async function renderSheet(bytes, spec, max) {
    if (!(window.XLSX && window.XLSX.read)) throw new Error('SheetJS no está cargado.');
    await loadScript('html2canvas');
    const workbook = window.XLSX.read(bytes, { type: 'array' });
    const names = workbook.SheetNames;
    const images = [];
    for (const n of pageList(spec, names.length, max)) {
      const sheet = workbook.Sheets[names[n - 1]];
      // Only the top-left corner: a picture of 10 000 rows tells nothing.
      if (sheet['!ref']) {
        const range = window.XLSX.utils.decode_range(sheet['!ref']);
        range.e.r = Math.min(range.e.r, range.s.r + 59);
        range.e.c = Math.min(range.e.c, range.s.c + 19);
        sheet['!ref'] = window.XLSX.utils.encode_range(range);
      }
      const host = stage(0);
      try {
        host.innerHTML = '<div style="font:13px Arial,sans-serif;padding:12px"><div style="font-weight:700;margin-bottom:8px">' + names[n - 1].replace(/[<>&]/g, '') + '</div>' +
          window.XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' }) + '</div>';
        host.querySelectorAll('table').forEach((table) => { table.style.borderCollapse = 'collapse'; });
        host.querySelectorAll('td').forEach((cell) => { cell.style.border = '1px solid #c8c8c8'; cell.style.padding = '3px 6px'; cell.style.whiteSpace = 'nowrap'; });
        images.push(canvasImage(await window.html2canvas(host, { scale: 2, backgroundColor: '#ffffff', logging: false }), n));
      } finally {
        host.remove();
      }
    }
    return { total: names.length, unit: 'hoja', images };
  }

  /* ── PowerPoint ──────────────────────────────────────────────────── */

  const EMU_PER_PT = 12700;
  const parser = () => new DOMParser();

  function xml(text) {
    return parser().parseFromString(text, 'application/xml');
  }

  function kids(node, name) {
    return node ? Array.from(node.children).filter((child) => child.localName === name) : [];
  }

  function kid(node, name) {
    return kids(node, name)[0] || null;
  }

  function path(node, names) {
    let current = node;
    for (const name of names) { current = kid(current, name); if (!current) return null; }
    return current;
  }

  function resolveTarget(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const piece of target.split('/')) {
      if (piece === '..') parts.pop();
      else if (piece !== '.') parts.push(piece);
    }
    return parts.join('/');
  }

  async function relsOf(zip, part) {
    const relPath = part.replace(/([^/]+)$/, '_rels/$1.rels');
    const file = zip.file(relPath);
    const out = {};
    if (!file) return out;
    const doc = xml(await file.async('string'));
    Array.from(doc.getElementsByTagName('Relationship')).forEach((rel) => {
      out[rel.getAttribute('Id')] = { type: rel.getAttribute('Type') || '', target: rel.getAttribute('TargetMode') === 'External' ? '' : resolveTarget(part, rel.getAttribute('Target') || '') };
    });
    return out;
  }

  function relOfType(rels, suffix) {
    const entry = Object.values(rels).find((rel) => rel.type.endsWith('/' + suffix));
    return entry ? entry.target : '';
  }

  async function slideParts(zip) {
    const pres = xml(await zip.file('ppt/presentation.xml').async('string'));
    const rels = await relsOf(zip, 'ppt/presentation.xml');
    const size = pres.getElementsByTagNameNS('*', 'sldSz')[0];
    const ids = Array.from(pres.getElementsByTagNameNS('*', 'sldId'));
    const slides = ids.map((id) => {
      const rid = id.getAttribute('r:id') || id.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      return rels[rid] ? rels[rid].target : '';
    }).filter(Boolean);
    return { slides, cx: size ? Number(size.getAttribute('cx')) : 12192000, cy: size ? Number(size.getAttribute('cy')) : 6858000 };
  }

  async function pptxText(bytes) {
    const zip = await zipOf(bytes);
    const { slides } = await slideParts(zip);
    const out = [];
    for (let i = 0; i < slides.length; i++) {
      const doc = xml(await zip.file(slides[i]).async('string'));
      const paragraphs = Array.from(doc.getElementsByTagNameNS('*', 'p')).filter((p) => p.namespaceURI && p.namespaceURI.includes('drawingml'))
        .map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('')).filter((line) => line.trim());
      let text = paragraphs.join('\n');
      const rels = await relsOf(zip, slides[i]);
      const notesPath = relOfType(rels, 'notesSlide');
      if (notesPath && zip.file(notesPath)) {
        const notes = xml(await zip.file(notesPath).async('string'));
        const noteText = Array.from(notes.getElementsByTagNameNS('*', 'p')).map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('')).filter((line) => line.trim() && !/^\d+$/.test(line.trim())).join('\n');
        if (noteText) text += '\n[Notas] ' + noteText;
      }
      out.push({ n: i + 1, text: text || '(diapositiva sin texto)' });
    }
    return out;
  }

  // Colours: srgbClr, sysClr or schemeClr (through the theme), with lumMod/lumOff.
  function colorOf(fill, theme) {
    if (!fill) return null;
    const node = kid(fill, 'srgbClr') || kid(fill, 'schemeClr') || kid(fill, 'sysClr') || kid(fill, 'prstClr');
    if (!node) return null;
    let hex = '';
    if (node.localName === 'srgbClr') hex = node.getAttribute('val');
    else if (node.localName === 'sysClr') hex = node.getAttribute('lastClr') || '000000';
    else if (node.localName === 'prstClr') hex = ({ black: '000000', white: 'FFFFFF', red: 'FF0000', blue: '0000FF', green: '008000' })[node.getAttribute('val')] || '000000';
    else {
      const name = node.getAttribute('val');
      const alias = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' }[name] || name;
      hex = theme[alias] || (alias === 'lt1' ? 'FFFFFF' : '000000');
    }
    let r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const mod = kid(node, 'lumMod'), off = kid(node, 'lumOff'), alphaNode = kid(node, 'alpha');
    if (mod || off) {
      const m = mod ? Number(mod.getAttribute('val')) / 100000 : 1;
      const o = off ? Number(off.getAttribute('val')) / 100000 : 0;
      [r, g, b] = [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round((v / 255 * m + o) * 255))));
    }
    const alpha = alphaNode ? Number(alphaNode.getAttribute('val')) / 100000 : 1;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  async function themeOf(zip, masterPath) {
    const rels = await relsOf(zip, masterPath);
    const themePath = relOfType(rels, 'theme');
    const out = {};
    if (!themePath || !zip.file(themePath)) return out;
    const doc = xml(await zip.file(themePath).async('string'));
    const scheme = doc.getElementsByTagNameNS('*', 'clrScheme')[0];
    if (scheme) Array.from(scheme.children).forEach((entry) => {
      const value = kid(entry, 'srgbClr') ? kid(entry, 'srgbClr').getAttribute('val') : kid(entry, 'sysClr') ? kid(entry, 'sysClr').getAttribute('lastClr') : '';
      if (value) out[entry.localName] = value;
    });
    const fonts = doc.getElementsByTagNameNS('*', 'latin');
    out.font = fonts[0] ? fonts[0].getAttribute('typeface') : '';
    return out;
  }

  function placeholderOf(shape) {
    const ph = shape.getElementsByTagNameNS('*', 'ph')[0];
    return ph ? { type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') || '' } : null;
  }

  function findPlaceholder(doc, ph) {
    if (!doc || !ph) return null;
    const shapes = Array.from(doc.getElementsByTagNameNS('*', 'sp'));
    return shapes.find((shape) => { const other = placeholderOf(shape); return other && ph.idx && other.idx === ph.idx; }) ||
      shapes.find((shape) => { const other = placeholderOf(shape); return other && other.type === ph.type; }) ||
      (ph.type === 'ctrTitle' ? shapes.find((shape) => { const other = placeholderOf(shape); return other && other.type === 'title'; }) : null) ||
      (ph.type === 'subTitle' ? shapes.find((shape) => { const other = placeholderOf(shape); return other && other.type === 'body'; }) : null);
  }

  function xfrmOf(node) {
    const xfrm = node && (path(node, ['spPr', 'xfrm']) || kid(node, 'xfrm') || path(node, ['grpSpPr', 'xfrm']));
    const off = xfrm && kid(xfrm, 'off');
    const ext = xfrm && kid(xfrm, 'ext');
    if (!off || !ext) return null;
    return { x: Number(off.getAttribute('x')), y: Number(off.getAttribute('y')), w: Number(ext.getAttribute('cx')), h: Number(ext.getAttribute('cy')), xfrm };
  }

  function bgFillOf(doc) {
    const bg = doc && doc.getElementsByTagNameNS('*', 'bg')[0];
    if (!bg) return null;
    const pr = kid(bg, 'bgPr');
    if (pr) return { solid: kid(pr, 'solidFill'), blip: pr.getElementsByTagNameNS('*', 'blip')[0] || null, grad: kid(pr, 'gradFill') };
    const ref = kid(bg, 'bgRef');
    return ref ? { solid: ref } : null;
  }

  function defaultSize(ph, master) {
    const styles = master && master.getElementsByTagNameNS('*', 'txStyles')[0];
    const pick = (name) => { const style = styles && kid(styles, name); const lvl = style && kid(style, 'lvl1pPr'); const rpr = lvl && kid(lvl, 'defRPr'); return rpr && rpr.getAttribute('sz') ? Number(rpr.getAttribute('sz')) / 100 : 0; };
    if (ph && (ph.type === 'title' || ph.type === 'ctrTitle')) return pick('titleStyle') || 44;
    if (ph) return pick('bodyStyle') || 28;
    return pick('otherStyle') || 18;
  }

  function wrapLines(ctx, text, width) {
    const out = [];
    for (const raw of String(text).split('\n')) {
      const words = raw.split(/(\s+)/);
      let line = '';
      for (const word of words) {
        const next = line + word;
        if (line && ctx.measureText(next).width > width && word.trim()) { out.push(line.trimEnd()); line = word.trimStart(); }
        else line = next;
      }
      out.push(line);
    }
    return out;
  }

  async function imageFromZip(zip, target) {
    const file = target && zip.file(target);
    if (!file) return null;
    try {
      const blob = new Blob([await file.async('uint8array')], { type: mimeFor(target) });
      return await createImageBitmap(blob);
    } catch (_) {
      return null;
    }
  }

  function drawShapePath(ctx, geom, x, y, w, h) {
    ctx.beginPath();
    if (geom === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    else if (geom === 'roundRect' && ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.16);
    else ctx.rect(x, y, w, h);
  }

  function drawTextBody(ctx, body, box, scale, ph, master, theme, inherited) {
    if (!body) return;
    const bodyPr = kid(body, 'bodyPr');
    const ins = (name, fallback) => (bodyPr && bodyPr.getAttribute(name) ? Number(bodyPr.getAttribute(name)) : fallback) * scale;
    const left = box.x + ins('lIns', 91440), right = box.x + box.w - ins('rIns', 91440);
    const top = box.y + ins('tIns', 45720), bottom = box.y + box.h - ins('bIns', 45720);
    const autofit = bodyPr && bodyPr.getElementsByTagNameNS('*', 'normAutofit')[0];
    const fontScale = autofit && autofit.getAttribute('fontScale') ? Number(autofit.getAttribute('fontScale')) / 100000 : 1;
    const anchor = (bodyPr && bodyPr.getAttribute('anchor')) || (inherited && inherited.anchor) || (ph && (ph.type === 'title' || ph.type === 'ctrTitle') ? 'ctr' : 't');
    const bulleted = ph && !['title', 'ctrTitle', 'subTitle', 'dt', 'ftr', 'sldNum'].includes(ph.type);
    const lines = [];
    for (const p of kids(body, 'p')) {
      const pPr = kid(p, 'pPr');
      const align = (pPr && pPr.getAttribute('algn')) || (inherited && inherited.align) || (ph && (ph.type === 'ctrTitle' || ph.type === 'subTitle') ? 'ctr' : 'l');
      const level = pPr && pPr.getAttribute('lvl') ? Number(pPr.getAttribute('lvl')) : 0;
      const runs = Array.from(p.children).filter((node) => node.localName === 'r' || node.localName === 'fld' || node.localName === 'br');
      let text = '';
      let size = 0, bold = false, italic = false, color = null;
      for (const run of runs) {
        if (run.localName === 'br') { text += '\n'; continue; }
        const rPr = kid(run, 'rPr');
        if (rPr) {
          if (!size && rPr.getAttribute('sz')) size = Number(rPr.getAttribute('sz')) / 100;
          if (rPr.getAttribute('b') === '1') bold = true;
          if (rPr.getAttribute('i') === '1') italic = true;
          if (!color) color = colorOf(kid(rPr, 'solidFill'), theme);
        }
        text += (kid(run, 't') || { textContent: '' }).textContent;
      }
      const endSize = kid(p, 'endParaRPr') && kid(p, 'endParaRPr').getAttribute('sz');
      size = (size || (endSize ? Number(endSize) / 100 : 0) || (inherited && inherited.size) || defaultSize(ph, master)) * fontScale;
      const noBullet = pPr && (kid(pPr, 'buNone'));
      const hasBullet = pPr && (kid(pPr, 'buChar') || kid(pPr, 'buAutoNum'));
      if (text && ((bulleted && !noBullet) || hasBullet)) text = '•  ' + text;
      lines.push({ text, size, bold: bold || !!(ph && (ph.type === 'title' || ph.type === 'ctrTitle') && inherited && inherited.bold), italic, color: color || (inherited && inherited.color) || '#' + (theme.dk1 || '000000'), align, indent: level * 0.5 * 72 * EMU_PER_PT * scale });
    }
    const font = theme.font && !/^\+/.test(theme.font) ? '"' + theme.font + '", Arial, sans-serif' : 'Calibri, Arial, sans-serif';
    const laid = [];
    let height = 0;
    for (const line of lines) {
      const px = line.size * EMU_PER_PT * scale;
      ctx.font = (line.italic ? 'italic ' : '') + (line.bold ? '700 ' : '400 ') + px + 'px ' + font;
      const wrapped = line.text ? wrapLines(ctx, line.text, right - left - line.indent) : [''];
      wrapped.forEach((text) => { laid.push({ text, px, line }); height += px * 1.2; });
    }
    let y = anchor === 'ctr' ? top + (bottom - top - height) / 2 : anchor === 'b' ? bottom - height : top;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x - 2, box.y - 2, box.w + 4, Math.max(box.h, height) + 4);
    ctx.clip();
    for (const item of laid) {
      const { line, px } = item;
      ctx.font = (line.italic ? 'italic ' : '') + (line.bold ? '700 ' : '400 ') + px + 'px ' + font;
      ctx.fillStyle = line.color;
      ctx.textBaseline = 'top';
      const startX = left + line.indent;
      ctx.textAlign = line.align === 'ctr' ? 'center' : line.align === 'r' ? 'right' : 'left';
      const x = line.align === 'ctr' ? (startX + right) / 2 : line.align === 'r' ? right : startX;
      ctx.fillText(item.text, x, y + px * 0.1);
      y += px * 1.2;
    }
    ctx.restore();
  }

  // What a placeholder takes from its layout/master when the slide leaves it out.
  function inheritedText(source, theme) {
    if (!source) return null;
    const body = kid(source, 'txBody');
    const bodyPr = body && kid(body, 'bodyPr');
    const lst = body && kid(body, 'lstStyle');
    const lvl = lst && kid(lst, 'lvl1pPr');
    const rpr = lvl && kid(lvl, 'defRPr');
    return {
      anchor: bodyPr && bodyPr.getAttribute('anchor'),
      align: lvl && lvl.getAttribute('algn'),
      size: rpr && rpr.getAttribute('sz') ? Number(rpr.getAttribute('sz')) / 100 : 0,
      bold: rpr && rpr.getAttribute('b') === '1',
      color: rpr ? colorOf(kid(rpr, 'solidFill'), theme) : null
    };
  }

  async function drawTree(ctx, tree, env, transform) {
    for (const node of Array.from(tree.children)) {
      const name = node.localName;
      if (name === 'grpSp') {
        const g = xfrmOf(node);
        const ch = g && kid(g.xfrm, 'chOff'), che = g && kid(g.xfrm, 'chExt');
        let next = transform;
        if (g && ch && che) {
          const sx = g.w / Math.max(1, Number(che.getAttribute('cx'))), sy = g.h / Math.max(1, Number(che.getAttribute('cy')));
          const cx = Number(ch.getAttribute('x')), cy = Number(ch.getAttribute('y'));
          next = (box) => transform({ x: g.x + (box.x - cx) * sx, y: g.y + (box.y - cy) * sy, w: box.w * sx, h: box.h * sy });
        }
        await drawTree(ctx, node, env, next);
        continue;
      }
      if (name !== 'sp' && name !== 'pic' && name !== 'graphicFrame' && name !== 'cxnSp') continue;
      const ph = placeholderOf(node);
      const layoutShape = ph ? findPlaceholder(env.layout, ph) : null;
      const masterShape = ph ? findPlaceholder(env.master, ph) : null;
      const own = xfrmOf(node) || xfrmOf(layoutShape) || xfrmOf(masterShape);
      if (!own) continue;
      const emu = transform(own);
      const box = { x: emu.x * env.scale, y: emu.y * env.scale, w: emu.w * env.scale, h: emu.h * env.scale };
      if (name === 'pic') {
        const blip = node.getElementsByTagNameNS('*', 'blip')[0];
        const rid = blip && (blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'));
        const image = rid && env.rels[rid] ? await imageFromZip(env.zip, env.rels[rid].target) : null;
        if (image) ctx.drawImage(image, box.x, box.y, box.w, box.h);
        else { ctx.fillStyle = '#e5e5e5'; ctx.fillRect(box.x, box.y, box.w, box.h); }
        continue;
      }
      if (name === 'graphicFrame') {
        const table = node.getElementsByTagNameNS('*', 'tbl')[0];
        if (!table) continue;
        const cols = Array.from(table.getElementsByTagNameNS('*', 'gridCol')).map((col) => Number(col.getAttribute('w')) * env.scale);
        let y = box.y;
        for (const tr of kids(table, 'tr')) {
          const rowH = Number(tr.getAttribute('h')) * env.scale || 30;
          let x = box.x;
          kids(tr, 'tc').forEach((tc, index) => {
            const w = cols[index] || box.w / Math.max(1, cols.length);
            const tcPr = kid(tc, 'tcPr');
            const fill = tcPr && colorOf(kid(tcPr, 'solidFill'), env.theme);
            ctx.fillStyle = fill || 'rgba(255,255,255,0)';
            ctx.fillRect(x, y, w, rowH);
            ctx.strokeStyle = '#9a9a9a';
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, w, rowH);
            drawTextBody(ctx, kid(tc, 'txBody'), { x, y, w, h: rowH }, env.scale, null, env.master, env.theme, { size: 14 });
            x += w;
          });
          y += rowH;
        }
        continue;
      }
      const spPr = kid(node, 'spPr');
      const geomNode = spPr && kid(spPr, 'prstGeom');
      const geom = geomNode ? geomNode.getAttribute('prst') : 'rect';
      const style = kid(node, 'style');
      const fill = spPr && kid(spPr, 'noFill') ? null : colorOf(spPr && kid(spPr, 'solidFill'), env.theme) || (!ph && style && !(spPr && kid(spPr, 'noFill')) ? colorOf(path(style, ['fillRef']), env.theme) : null);
      const blipFill = spPr && kid(spPr, 'blipFill');
      if (fill && name !== 'cxnSp') { ctx.fillStyle = fill; drawShapePath(ctx, geom, box.x, box.y, box.w, box.h); ctx.fill(); }
      if (blipFill) {
        const blip = blipFill.getElementsByTagNameNS('*', 'blip')[0];
        const rid = blip && (blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'));
        const image = rid && env.rels[rid] ? await imageFromZip(env.zip, env.rels[rid].target) : null;
        if (image) ctx.drawImage(image, box.x, box.y, box.w, box.h);
      }
      const ln = spPr && kid(spPr, 'ln');
      const lineColor = ln && !kid(ln, 'noFill') ? colorOf(kid(ln, 'solidFill'), env.theme) || (style ? colorOf(path(style, ['lnRef']), env.theme) : null) : (!ph && style && !ln ? colorOf(path(style, ['lnRef']), env.theme) : null);
      if (lineColor) {
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = Math.max(1, (ln && ln.getAttribute('w') ? Number(ln.getAttribute('w')) : 12700) * env.scale);
        if (name === 'cxnSp' || geom === 'line') { ctx.beginPath(); ctx.moveTo(box.x, box.y); ctx.lineTo(box.x + box.w, box.y + box.h); ctx.stroke(); }
        else { drawShapePath(ctx, geom, box.x, box.y, box.w, box.h); ctx.stroke(); }
      }
      const inherited = inheritedText(layoutShape, env.theme) || inheritedText(masterShape, env.theme);
      const fontColor = style ? colorOf(path(style, ['fontRef']), env.theme) : null;
      if (fontColor && inherited && !inherited.color) inherited.color = fontColor;
      drawTextBody(ctx, kid(node, 'txBody'), box, env.scale, ph, env.master, env.theme, inherited || (fontColor ? { color: fontColor } : null));
    }
  }

  async function renderPptx(bytes, spec, max) {
    const zip = await zipOf(bytes);
    const { slides, cx, cy } = await slideParts(zip);
    const images = [];
    for (const n of pageList(spec, slides.length, max)) images.push(canvasImage(await slideCanvas(zip, slides, cx, cy, n, RENDER_WIDTH), n));
    return { total: slides.length, unit: 'diapositiva', images };
  }

  // One slide drawn on a canvas `width` pixels wide.
  async function slideCanvas(zip, slides, cx, cy, n, width) {
    const scale = width / cx;
    {
      const slidePath = slides[n - 1];
      const slide = xml(await zip.file(slidePath).async('string'));
      const rels = await relsOf(zip, slidePath);
      const layoutPath = relOfType(rels, 'slideLayout');
      const layout = layoutPath && zip.file(layoutPath) ? xml(await zip.file(layoutPath).async('string')) : null;
      const layoutRels = layoutPath ? await relsOf(zip, layoutPath) : {};
      const masterPath = relOfType(layoutRels, 'slideMaster');
      const master = masterPath && zip.file(masterPath) ? xml(await zip.file(masterPath).async('string')) : null;
      const theme = masterPath ? await themeOf(zip, masterPath) : {};
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = Math.round(cy * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const bg = bgFillOf(slide) || bgFillOf(layout) || bgFillOf(master);
      const bgRels = bgFillOf(slide) ? rels : bgFillOf(layout) ? layoutRels : masterPath ? await relsOf(zip, masterPath) : {};
      if (bg && bg.blip) {
        const rid = bg.blip.getAttribute('r:embed') || bg.blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
        const image = rid && bgRels[rid] ? await imageFromZip(zip, bgRels[rid].target) : null;
        if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      } else if (bg && bg.grad) {
        const stops = Array.from(bg.grad.getElementsByTagNameNS('*', 'gs'));
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        stops.forEach((stop) => gradient.addColorStop(Number(stop.getAttribute('pos')) / 100000, colorOf(stop, theme) || '#fff'));
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else if (bg && bg.solid) {
        ctx.fillStyle = colorOf(bg.solid, theme) || '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      const env = { zip, rels, layout, master, theme, scale };
      // Pictures and shapes the layout and master draw on every slide (logos, bands), unless hidden.
      const showMaster = !(slide.documentElement.getAttribute('showMasterSp') === '0');
      if (showMaster && master) {
        const masterTree = master.getElementsByTagNameNS('*', 'spTree')[0];
        const masterEnv = Object.assign({}, env, { rels: await relsOf(zip, masterPath), layout: null });
        if (masterTree) await drawTree(ctx, filterDecor(masterTree), masterEnv, (box) => box);
      }
      if (layout) {
        const layoutTree = layout.getElementsByTagNameNS('*', 'spTree')[0];
        if (layoutTree) await drawTree(ctx, filterDecor(layoutTree), Object.assign({}, env, { rels: layoutRels, layout: null }), (box) => box);
      }
      const tree = slide.getElementsByTagNameNS('*', 'spTree')[0];
      if (tree) await drawTree(ctx, tree, env, (box) => box);
      return canvas;
    }
  }

  // From a layout or master only what is not a placeholder (those are templates for the slide).
  function filterDecor(tree) {
    const copy = tree.cloneNode(true);
    Array.from(copy.children).forEach((node) => { if (placeholderOf(node)) node.remove(); });
    return copy;
  }

  /* ── API: render ─────────────────────────────────────────────────── */

  // file: { name, mimeType, bytes } → { total, unit, images: [{ page, mimeType, data, width, height }] }
  async function render(file, options) {
    const opts = options || {};
    const bytes = bytesOf(file.bytes);
    const kind = kindOf(file.name, file.mimeType);
    if (kind === 'pdf') return renderPdf(bytes, opts.pages, opts.max);
    if (kind === 'docx') return renderDocx(await asDocument(bytes), opts.pages, opts.max);
    if (kind === 'pptx') return renderPptx(bytes, opts.pages, opts.max);
    if (kind === 'xlsx') return renderSheet(bytes, opts.pages, opts.max);
    if (kind === 'image') {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: file.mimeType || mimeFor(file.name) }));
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return { total: 1, unit: 'imagen', images: [canvasImage(canvas, 1)] };
    }
    throw new Error('No sé dibujar ' + (file.name || 'este archivo') + ': solo PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx) e imágenes.');
  }

  /* ── API: preview (la vista previa para la persona) ──────────────── */

  // Fast, for a person (render() makes the model's images): PDF pages and
  // slides are drawn only when they come near the screen, at the screen's
  // size; Word and Excel are shown as documents (no picture of each page);
  // images as they are. host: an empty element; signal: stops the work when
  // the preview closes. → { total, unit }
  async function preview(file, host, options) {
    const opts = options || {};
    const signal = opts.signal;
    const bytes = bytesOf(file.bytes);
    const kind = kindOf(file.name, file.mimeType);
    const pixelWidth = () => Math.min(1600, Math.max(320, Math.round((host.clientWidth || 800) * Math.min(2, window.devicePixelRatio || 1))));
    const aborted = () => !!(signal && signal.aborted);
    if (kind === 'pdf') {
      const pdf = await pdfjs().getDocument({ data: bytes.slice() }).promise;
      if (signal) signal.addEventListener('abort', () => { if (pdf.destroy) pdf.destroy(); }, { once: true });
      const first = await pdf.getPage(1);
      const base = first.getViewport({ scale: 1 });
      lazyPages(host, pdf.numPages, 'página', base.height / base.width, async (n) => {
        const page = n === 1 ? first : await pdf.getPage(n);
        const pageBase = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: pixelWidth() / pageBase.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        return canvas;
      }, signal);
      return { total: pdf.numPages, unit: 'página' };
    }
    if (kind === 'pptx') {
      const zip = await zipOf(bytes);
      const { slides, cx, cy } = await slideParts(zip);
      lazyPages(host, slides.length, 'diapositiva', cy / cx, (n) => slideCanvas(zip, slides, cx, cy, n, pixelWidth()), signal);
      return { total: slides.length, unit: 'diapositiva' };
    }
    if (kind === 'docx') {
      await loadScript('jszip');
      await loadScript('docxPreview');
      const box = document.createElement('div');
      box.className = 'doc-html doc-word';
      host.appendChild(box);
      await window.docx.renderAsync(new Blob([await asDocument(bytes)]), box, box, { className: 'inhouse-docx', inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true });
      if (aborted()) return { total: 0, unit: 'página' };
      const pages = Array.from(box.querySelectorAll('section.inhouse-docx'));
      // Pages keep Word's width; a narrow screen sees them scaled down.
      const fit = () => {
        const widest = Math.max(1, ...pages.map((page) => page.scrollWidth));
        box.style.zoom = String(Math.min(1, (host.clientWidth - 8) / widest));
      };
      fit();
      if (window.ResizeObserver) new ResizeObserver(fit).observe(host);
      return { total: pages.length, unit: 'página' };
    }
    if (kind === 'xlsx') {
      if (!(window.XLSX && window.XLSX.read)) throw new Error('SheetJS no está cargado.');
      const workbook = window.XLSX.read(bytes, { type: 'array' });
      workbook.SheetNames.forEach((name) => {
        const sheet = workbook.Sheets[name];
        if (sheet['!ref']) {
          const range = window.XLSX.utils.decode_range(sheet['!ref']);
          range.e.r = Math.min(range.e.r, range.s.r + 499);
          range.e.c = Math.min(range.e.c, range.s.c + 49);
          sheet['!ref'] = window.XLSX.utils.encode_range(range);
        }
        const section = document.createElement('section');
        section.className = 'doc-html doc-sheet';
        section.innerHTML = '<h3>' + name.replace(/[<>&]/g, '') + '</h3><div class="doc-sheet-scroll">' + window.XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' }) + '</div>';
        host.appendChild(section);
      });
      return { total: workbook.SheetNames.length, unit: 'hoja' };
    }
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'doc-image';
      img.alt = file.name || '';
      img.src = URL.createObjectURL(new Blob([bytes], { type: file.mimeType || mimeFor(file.name) }));
      host.appendChild(img);
      return { total: 1, unit: 'imagen' };
    }
    throw new Error('No sé enseñar ' + (file.name || 'este archivo') + ': solo PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx) e imágenes.');
  }

  // A placeholder per page with the page's proportions (so the scroll bar is
  // right from the start); each is drawn when it is within a screen of view,
  // one at a time, nearest first.
  function lazyPages(host, total, unit, ratio, draw, signal) {
    const figures = [];
    const queue = [];
    let busy = false;
    const label = unit.charAt(0).toUpperCase() + unit.slice(1);
    for (let n = 1; n <= total; n++) {
      const figure = document.createElement('figure');
      figure.className = 'doc-page lazy';
      figure.dataset.page = String(n);
      figure.innerHTML = '<div class="doc-page-sheet" style="aspect-ratio:' + (1 / ratio).toFixed(4) + '"></div><figcaption>' + label + ' ' + n + ' de ' + total + '</figcaption>';
      host.appendChild(figure);
      figures.push(figure);
    }
    const pump = async () => {
      if (busy) return;
      busy = true;
      while (queue.length && !(signal && signal.aborted)) {
        const figure = queue.shift();
        if (!figure.classList.contains('lazy')) continue;
        figure.classList.remove('lazy');
        try {
          const canvas = await draw(Number(figure.dataset.page));
          if (signal && signal.aborted) break;
          canvas.className = 'doc-page-canvas';
          figure.querySelector('.doc-page-sheet').replaceWith(canvas);
        } catch (error) {
          figure.querySelector('.doc-page-sheet').textContent = 'No se pudo dibujar: ' + error.message;
        }
        // Let the page paint between pages.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      busy = false;
    };
    const want = (figure) => {
      if (!figure.classList.contains('lazy') || queue.includes(figure)) return;
      queue.push(figure);
      queue.sort((a, b) => Number(a.dataset.page) - Number(b.dataset.page));
      pump();
    };
    if (!('IntersectionObserver' in window)) { figures.slice(0, 40).forEach(want); return; }
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) want(entry.target); }), { root: null, rootMargin: '100% 0px' });
    figures.forEach((figure) => observer.observe(figure));
    if (signal) signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    // The first page straight away, before the observer's first round.
    want(figures[0]);
  }

  /* ── API: run (crear y editar con código) ─────────────────────────── */

  const libText = new Map();
  function libSource(lib) {
    if (!libText.has(lib.key)) {
      libText.set(lib.key, fetch(CDN + lib.url).then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      }).catch((error) => { libText.delete(lib.key); throw new Error('No se pudo descargar ' + lib.url.split('@')[0] + ' (' + error.message + ').'); }));
    }
    return libText.get(lib.key);
  }

  const RUNNER = `
;(function () {
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection']) {
    // On self AND every prototype above it: the real functions live on
  // WorkerGlobalScope.prototype, and shadowing them on self alone leaves them
  // reachable through Object.getPrototypeOf(self).
  for (let o = self; o; o = Object.getPrototypeOf(o)) {
    try { Object.defineProperty(o, name, { value: undefined, writable: false, configurable: false }); } catch (_) {}
  }
  }
  const format = (value) => {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value instanceof Uint8Array) return '[Uint8Array ' + value.length + ' bytes]';
    try { return JSON.stringify(value, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2); } catch (_) { return String(value); }
  };
  let nextId = 1;
  const waiting = new Map();
  let documents = [];
  const readDocument = (name) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    self.postMessage({ type: 'read', id, name: String(name) });
  });
  const saves = [];
  const toBytes = async (data, path) => {
    if (data == null) throw new Error('saveDocument(' + path + '): no hay contenido.');
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (self.PDFLib && data instanceof self.PDFLib.PDFDocument) return await data.save();
    if (self.docx && self.docx.Document && data instanceof self.docx.Document) return new Uint8Array(await (await self.docx.Packer.toBlob(data)).arrayBuffer());
    if (typeof data.addSlide === 'function' && typeof data.write === 'function') return await data.write({ outputType: 'uint8array' });
    if (self.JSZip && data instanceof self.JSZip) return await data.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    if (self.XLSX && data.SheetNames && data.Sheets) {
      const ext = (/\\.([a-z]+)$/i.exec(path) || [])[1] || 'xlsx';
      return new Uint8Array(self.XLSX.write(data, { type: 'array', bookType: ext.toLowerCase() === 'csv' ? 'csv' : 'xlsx' }));
    }
    throw new Error('saveDocument(' + path + '): no sé guardar este objeto. Pasa bytes, un PDFDocument de pdf-lib, un docx.Document, una presentación de PptxGenJS, un JSZip o un libro de SheetJS.');
  };
  // Saved as .docx/.pptx/.xlsx, a filled template (.dotx/.potx/.xltx) becomes a
  // normal document: only the main part's content type changes.
  const asDocument = async (bytes, path) => {
    if (!/\\.(docx|pptx|xlsx)$/i.test(path) || !self.JSZip || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return bytes;
    try {
      const zip = await self.JSZip.loadAsync(bytes);
      const file = zip.file('[Content_Types].xml');
      if (!file) return bytes;
      const before = await file.async('string');
      const after = before
        .replace(/application\\/vnd\\.openxmlformats-officedocument\\.wordprocessingml\\.template\\.main\\+xml|application\\/vnd\\.ms-word\\.(template\\.macroEnabledTemplate|document\\.macroEnabled)\\.main\\+xml/g, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
        .replace(/application\\/vnd\\.openxmlformats-officedocument\\.presentationml\\.template\\.main\\+xml|application\\/vnd\\.ms-powerpoint\\.(template|presentation)\\.macroEnabled\\.main\\+xml/g, 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')
        .replace(/application\\/vnd\\.openxmlformats-officedocument\\.spreadsheetml\\.template\\.main\\+xml|application\\/vnd\\.ms-excel\\.(template|sheet)\\.macroEnabled\\.main\\+xml/g, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
      if (after === before) return bytes;
      zip.file('[Content_Types].xml', after);
      return await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    } catch (_) { return bytes; }
  };
  const saveDocument = (path, data) => {
    const clean = String(path || '').trim().replace(/^(\\.\\/|\\/)+/, '');
    if (!clean) throw new Error('saveDocument necesita un nombre, p. ej. "informe.pdf".');
    saves.push(toBytes(data, clean).then((bytes) => asDocument(bytes, clean)).then((bytes) => ({ path: clean, bytes })));
    return clean;
  };
  const listDocuments = () => documents.map((doc) => Object.assign({}, doc));
  self.onmessage = async (event) => {
    const message = event.data || {};
    if (message.type === 'read') {
      const entry = waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      if (message.error) entry.reject(new Error(message.error)); else entry.resolve(new Uint8Array(message.bytes));
      return;
    }
    if (message.type !== 'run') return;
    documents = message.documents || [];
    const logs = [];
    const log = (prefix) => (...args) => logs.push(prefix + args.map(format).join(' '));
    const sandboxConsole = { log: log(''), info: log(''), debug: log(''), table: log(''), warn: log('[warn] '), error: log('[error] ') };
    let result, error, saved = [];
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      result = await new AsyncFunction('console', 'readDocument', 'saveDocument', 'listDocuments', message.code)(sandboxConsole, readDocument, saveDocument, listDocuments);
      saved = await Promise.all(saves);
    } catch (e) {
      error = e && e.stack ? String(e.stack).split('\\n').slice(0, 6).join('\\n') : String(e);
    }
    self.postMessage({ type: 'done', logs, result: result === undefined ? undefined : format(result), error, saved }, saved.map((item) => item.bytes.buffer));
  };
})();
`;

  // host: { list() → [{ ref, name, kind, size }], open(name) → { name, mimeType, bytes } }
  // → { logs, result, error, saved: [{ path, bytes, mimeType }] }
  async function run(code, host, signal) {
    const source = String(code || '');
    const libs = WORKER_LIBS.filter((lib) => lib.test.test(source));
    const texts = await Promise.all(libs.map(libSource));
    const blobUrl = URL.createObjectURL(new Blob([texts.join('\n;\n'), RUNNER], { type: 'text/javascript' }));
    const documents = host && host.list ? await host.list() : [];
    return new Promise((resolve) => {
      const worker = new Worker(blobUrl);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        worker.terminate();
        URL.revokeObjectURL(blobUrl);
        const out = Object.assign({ logs: [], saved: [] }, value);
        out.saved = (out.saved || []).map((item) => ({ path: item.path, bytes: bytesOf(item.bytes), mimeType: mimeFor(item.path) }));
        resolve(out);
      };
      const onAbort = () => finish({ error: 'Cancelado.' });
      const timer = setTimeout(() => finish({ error: 'Tiempo agotado: el código tardó más de ' + RUN_TIMEOUT_MS / 1000 + ' s.' }), RUN_TIMEOUT_MS);
      worker.onmessage = async (event) => {
        const message = event.data || {};
        if (message.type === 'read') {
          try {
            const file = await host.open(message.name);
            if (!file) throw new Error('No existe el documento «' + message.name + '». listDocuments() dice cuáles hay.');
            const bytes = bytesOf(file.bytes).slice();
            worker.postMessage({ type: 'read', id: message.id, bytes: bytes.buffer }, [bytes.buffer]);
          } catch (error) {
            worker.postMessage({ type: 'read', id: message.id, error: error && error.message ? error.message : String(error) });
          }
          return;
        }
        if (message.type === 'done') finish(message);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish({ error: event.message || 'Error al ejecutar el código.' });
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort);
      }
      worker.postMessage({ type: 'run', code: source, documents });
    });
  }

  // Starts downloading what a Word preview needs (the first open is then quick).
  let warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    loadScript('jszip').then(() => loadScript('docxPreview')).catch(() => { warmed = false; });
  }

  window.InhouseDocs = { kindOf, mimeFor, render, preview, warm, run, pptxText, pageList, asDocument };
})();
