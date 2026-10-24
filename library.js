/* ─── Biblioteca del chat ─────────────────────────────────────────────
   PDFs, carpetas enteras, fotos y documentos que el usuario sube a un chat.
   No se meten en el mensaje: se guardan en IndexedDB (cabe mucho más que en
   localStorage), se trocean por páginas y el modelo los consulta con las
   herramientas search_library, read_library, list_library y
   view_library_image (engine/src/library.js).

   - PDF: texto página a página con pdf.js; una página sin texto (escaneada)
     se guarda como imagen y se lee con OCR.
   - Fotos: se reducen a 1600 px en JPEG y se leen con OCR (Tesseract.js, se
     carga solo la primera vez que hace falta, en segundo plano).
   - Word, hojas de cálculo y texto: se parten en secciones de ~3000 caracteres.
   - Búsqueda BM25 sobre fragmentos de ~900 caracteres, sin tildes ni mayúsculas.
   - Cada documento se sube también a la carpeta de Drive del usuario
     (library-<id>.json), para que otro dispositivo lo descargue al abrir el chat.

   Depende de: pdfjsLib, mammoth, XLSX (cargados por index.html). */
(function () {
  const DB_NAME = 'inhouse-learn-library';
  const DB_VERSION = 2;
  const MAX_ORIGINAL_BYTES = 30 * 1024 * 1024;
  const MAX_DRIVE_ORIGINAL_BYTES = 8 * 1024 * 1024;
  const MAX_PDF_PAGES = 3000;
  const MAX_SCANNED_PAGES = 400;
  const MAX_IMAGE_SIDE = 1600;
  const SECTION_CHARS = 3000;
  const CHUNK_CHARS = 900;
  const CHUNK_OVERLAP = 150;
  const SCANNED_PAGE_MIN_CHARS = 15;
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const DRIVE_DOC_TAG = 'inhouseLearnDoc';
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|py|java|c|cpp|h|tex|bib|srt|vtt|log|yaml|yml|ini|rtf)$/i;
  const SKIP_NAME = /(^|\/)(\.|__MACOSX\/|Thumbs\.db$|desktop\.ini$)/i;

  const listeners = new Set();
  const indexCache = new Map(); // chatId -> { key, chunks, df, avg }
  let dbPromise = null;
  let drive = null; // { upload(name, text, appProperties) → id, list(appProperties) → [{id, name}], download(id) → text, remove(id) }
  const status = { busy: false, label: '', ocrQueue: 0 };

  /* ── IndexedDB ───────────────────────────────────────────────────── */

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' }).createIndex('chatId', 'chatId');
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' }).createIndex('chatId', 'chatId');
        // The file itself (PDF, Word, PowerPoint, Excel), to see it and edit it later.
        if (!db.objectStoreNames.contains('originals')) db.createObjectStore('originals', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function tx(store, mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const result = run(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB abort'));
    });
  }

  const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
  const get = (store, id) => tx(store, 'readonly', (s) => s.get(id));
  const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
  const byChat = (store, chatId) => tx(store, 'readonly', (s) => s.index('chatId').getAll(chatId));

  /* ── Utilidades ──────────────────────────────────────────────────── */

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }

  function fromBase64(text) {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emit() {
    listeners.forEach((fn) => { try { fn(Object.assign({}, status)); } catch (_) {} });
  }

  function setStatus(label, busy) {
    status.label = label || '';
    status.busy = !!busy;
    emit();
  }

  function fold(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  const STOP = new Set(('de la el en y a los las del que se por un una con para es al lo como su sus mas o pero sin sobre este esta estos estas ese esa entre cuando muy ya tambien fue son ha han hay ser era the of and to in is for on that with as by an be are this from or at it its was were which').split(' '));

  function tokens(text) {
    return fold(text).split(/[^a-z0-9ñ]+/).filter((word) => word.length > 1 && !STOP.has(word))
      .map((word) => (word.length > 4 && /[^s]s$/.test(word) ? word.slice(0, -1) : word));
  }

  function kindOf(file, path) {
    const name = String(path || file.name || '').toLowerCase();
    const mime = String(file.type || '').toLowerCase();
    if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    if (mime.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/.test(name)) return 'image';
    // Templates (.dotx/.potx/.xltx) and macro files read like their documents.
    if (/\.(docx|dotx|docm|dotm|odt)$/.test(name)) return 'doc';
    if (/\.(pptx|potx|pptm)$/.test(name)) return 'slides';
    if (/\.(xlsx|xltx|xlsm|xls|ods)$/.test(name)) return 'sheet';
    if (mime.startsWith('text/') || mime.includes('json') || TEXT_EXT.test(name)) return 'text';
    return '';
  }

  function splitSections(text) {
    const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
    const out = [];
    let rest = clean;
    while (rest.length > SECTION_CHARS) {
      let cut = rest.lastIndexOf('\n\n', SECTION_CHARS);
      if (cut < SECTION_CHARS * 0.5) cut = rest.lastIndexOf('\n', SECTION_CHARS);
      if (cut < SECTION_CHARS * 0.5) cut = rest.lastIndexOf('. ', SECTION_CHARS) + 1;
      if (cut < SECTION_CHARS * 0.5) cut = SECTION_CHARS;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.map((section, index) => ({ n: index + 1, text: section }));
  }

  function canvasJpeg(canvas) {
    return canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
  }

  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {}
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  async function imageToJpeg(file) {
    const bitmap = await loadBitmap(file);
    const w = bitmap.width || bitmap.naturalWidth;
    const h = bitmap.height || bitmap.naturalHeight;
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    return { data: canvasJpeg(canvas), width: canvas.width, height: canvas.height };
  }

  function pdfjs() {
    const lib = window.pdfjsLib;
    if (!lib || !lib.getDocument) throw new Error('pdf.js no está cargado.');
    if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }
    return lib;
  }

  /* ── Ingesta ─────────────────────────────────────────────────────── */

  async function readPdf(file, doc, images, onPage) {
    const pdf = await pdfjs().getDocument({ data: await file.arrayBuffer() }).promise;
    const total = Math.min(pdf.numPages, MAX_PDF_PAGES);
    doc.totalPages = pdf.numPages;
    let scanned = 0;
    for (let n = 1; n <= total; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((item) => (item && item.str ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join('')
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      const entry = { n, text };
      if (text.replace(/\s/g, '').length < SCANNED_PAGE_MIN_CHARS && scanned < MAX_SCANNED_PAGES) {
        scanned++;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2.5, MAX_IMAGE_SIDE / Math.max(base.width, base.height)) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const id = uid('img');
        images.push({ id, chatId: doc.chatId, docId: doc.id, page: n, mimeType: 'image/jpeg', data: canvasJpeg(canvas), width: canvas.width, height: canvas.height });
        entry.image = id;
        entry.ocr = 'pending';
      }
      doc.pages.push(entry);
      if (page.cleanup) page.cleanup();
      if (onPage) onPage(n, total);
    }
    if (pdf.destroy) pdf.destroy();
  }

  async function readSheet(file) {
    if (!(window.XLSX && window.XLSX.read)) throw new Error('SheetJS no está cargado.');
    const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return workbook.SheetNames.map((name) => 'Hoja: ' + name + '\n' +
      window.XLSX.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false }).trim()).join('\n\n');
  }

  async function readDoc(file) {
    if (!(window.mammoth && window.mammoth.extractRawText)) throw new Error('Mammoth no está cargado.');
    let buffer = await file.arrayBuffer();
    // A Word template (.dotx) reads as its document.
    if (window.InhouseDocs && /\.(dotx|dotm|docm)$/i.test(file.name || '')) { const doc = await window.InhouseDocs.asDocument(new Uint8Array(buffer)); buffer = doc.buffer.slice(doc.byteOffset, doc.byteOffset + doc.byteLength); }
    const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
    return (result && result.value) || '';
  }

  async function nextRef(chatId) {
    const docs = await byChat('docs', chatId);
    return docs.reduce((max, doc) => Math.max(max, Number(String(doc.ref || '').slice(1)) || 0), 0) + 1;
  }

  // items: [{ file, path }] (path keeps the folder structure of a folder upload).
  async function ingest(chatId, items, options) {
    const opts = options || {};
    const added = [];
    const skipped = [];
    const list = Array.from(items || []).filter((item) => item && item.file && !SKIP_NAME.test(item.path || item.file.name))
      .sort((a, b) => String(a.path || a.file.name).localeCompare(String(b.path || b.file.name), 'es', { numeric: true }));
    let ref = await nextRef(chatId);
    for (let i = 0; i < list.length; i++) {
      const { file } = list[i];
      const path = String(list[i].path || file.webkitRelativePath || file.name).replace(/^\/+/, '');
      const kind = kindOf(file, path);
      const prefix = list.length > 1 ? 'Leyendo ' + (i + 1) + ' de ' + list.length + ': ' : 'Leyendo ';
      setStatus(prefix + path, true);
      if (!kind) { skipped.push({ path, reason: 'formato no compatible' }); continue; }
      const doc = { id: uid('doc'), ref: 'D' + ref, chatId, name: file.name, path, kind, mimeType: file.type || '', size: file.size, addedAt: new Date().toISOString(), pages: [] };
      const images = [];
      try {
        if (kind === 'pdf') {
          await readPdf(file, doc, images, (n, total) => { if (total > 20 && n % 10 === 0) setStatus(prefix + path + ' · página ' + n + ' de ' + total, true); });
        } else if (kind === 'image') {
          const jpeg = await imageToJpeg(file);
          const id = uid('img');
          images.push({ id, chatId, docId: doc.id, page: 1, mimeType: 'image/jpeg', data: jpeg.data, width: jpeg.width, height: jpeg.height });
          doc.pages.push({ n: 1, text: '', image: id, ocr: 'pending' });
        } else if (kind === 'slides') {
          if (!window.InhouseDocs) throw new Error('No se pueden leer presentaciones.');
          doc.pages = await window.InhouseDocs.pptxText(new Uint8Array(await file.arrayBuffer()));
          doc.totalPages = doc.pages.length;
        } else {
          const text = kind === 'doc' ? await readDoc(file) : kind === 'sheet' ? await readSheet(file) : await file.text();
          doc.pages = splitSections(text);
        }
      } catch (error) {
        skipped.push({ path, reason: error && error.message ? error.message : 'no se pudo leer' });
        continue;
      }
      if (!doc.pages.length && opts.generated) doc.pages = [{ n: 1, text: '(sin texto)' }];
      if (!doc.pages.length) { skipped.push({ path, reason: 'sin contenido' }); continue; }
      if (kind !== 'text' && file.size <= MAX_ORIGINAL_BYTES) {
        await put('originals', { id: doc.id, chatId, mimeType: file.type || '', data: await file.arrayBuffer() });
        doc.hasOriginal = true;
      }
      if (opts.generated) doc.generated = true;
      // A document the model saves again under the same name replaces the old one and keeps its reference.
      const previous = opts.generated ? (await byChat('docs', chatId)).find((other) => other.generated && other.path === path) : null;
      if (previous) {
        doc.ref = previous.ref;
        doc.driveId = previous.driveId || '';
        await removeLocal(previous);
        ref--;
      }
      for (const image of images) await put('images', image);
      await put('docs', doc);
      ref++;
      added.push(summary(doc));
      if (opts.signal && opts.signal.aborted) break;
    }
    indexCache.delete(chatId);
    setStatus('', false);
    if (added.some((doc) => doc.pendingOcr)) runOcrQueue();
    added.forEach((doc) => uploadToDrive(doc.id).catch((error) => console.warn('Biblioteca → Drive:', error)));
    return { added, skipped };
  }

  function summary(doc) {
    const chars = doc.pages.reduce((sum, page) => sum + (page.text || '').length, 0);
    return {
      id: doc.id, ref: doc.ref, name: doc.name, path: doc.path, kind: doc.kind, size: doc.size,
      pages: doc.pages.length, totalPages: doc.totalPages || doc.pages.length,
      words: Math.round(chars / 6), images: doc.pages.filter((page) => page.image).length,
      pendingOcr: doc.pages.filter((page) => page.ocr === 'pending').length, addedAt: doc.addedAt,
      hasOriginal: !!doc.hasOriginal, generated: !!doc.generated, mimeType: doc.mimeType || ''
    };
  }

  /* ── OCR en segundo plano ────────────────────────────────────────── */

  let ocrRunning = false;
  let tesseractPromise = null;
  let ocrWorker = null;

  function loadTesseract() {
    if (window.InhouseLibraryOcr) return Promise.resolve(window.InhouseLibraryOcr);
    if (!tesseractPromise) {
      tesseractPromise = new Promise((resolve, reject) => {
        if (window.Tesseract) return resolve(window.Tesseract);
        const script = document.createElement('script');
        script.src = TESSERACT_URL;
        script.async = true;
        script.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract no cargó')));
        script.onerror = () => reject(new Error('No se pudo cargar el OCR'));
        document.head.appendChild(script);
      }).then(async (Tesseract) => {
        ocrWorker = await Tesseract.createWorker(['spa', 'eng']);
        return { recognize: async (dataUrl) => (await ocrWorker.recognize(dataUrl)).data.text || '' };
      });
      tesseractPromise.catch(() => { tesseractPromise = null; });
    }
    return tesseractPromise;
  }

  async function pendingOcrPages() {
    const db = await openDb();
    const docs = await new Promise((resolve, reject) => {
      const request = db.transaction('docs', 'readonly').objectStore('docs').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const out = [];
    docs.forEach((doc) => doc.pages.forEach((page) => { if (page.ocr === 'pending') out.push({ docId: doc.id, n: page.n, image: page.image }); }));
    return out;
  }

  async function runOcrQueue() {
    if (ocrRunning) return;
    ocrRunning = true;
    try {
      let queue = await pendingOcrPages();
      if (!queue.length) return;
      let ocr;
      try {
        ocr = await loadTesseract();
      } catch (error) {
        console.warn('OCR no disponible:', error);
        status.ocrQueue = 0;
        emit();
        return;
      }
      while (queue.length) {
        status.ocrQueue = queue.length;
        emit();
        const item = queue.shift();
        const image = await get('images', item.image);
        let text = '';
        try {
          text = image ? String(await ocr.recognize('data:' + image.mimeType + ';base64,' + image.data)).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : '';
        } catch (error) {
          console.warn('OCR:', error);
        }
        const doc = await get('docs', item.docId);
        if (doc) {
          const page = doc.pages.find((entry) => entry.n === item.n);
          if (page) {
            page.text = [page.text, text].filter(Boolean).join('\n');
            page.ocr = 'done';
            await put('docs', doc);
            indexCache.delete(doc.chatId);
            if (!doc.pages.some((entry) => entry.ocr === 'pending')) uploadToDrive(doc.id).catch((error) => console.warn('Biblioteca → Drive:', error));
          }
        }
        if (!queue.length) queue = await pendingOcrPages();
      }
    } finally {
      ocrRunning = false;
      status.ocrQueue = 0;
      emit();
    }
  }

  /* ── Búsqueda ────────────────────────────────────────────────────── */

  async function buildIndex(chatId) {
    const docs = (await byChat('docs', chatId)).sort((a, b) => (Number(a.ref.slice(1)) || 0) - (Number(b.ref.slice(1)) || 0));
    const key = docs.map((doc) => doc.id + ':' + doc.pages.reduce((sum, page) => sum + (page.text || '').length, 0)).join('|');
    const cached = indexCache.get(chatId);
    if (cached && cached.key === key) return cached;
    const chunks = [];
    const df = new Map();
    docs.forEach((doc) => {
      const nameTokens = tokens(doc.path);
      doc.pages.forEach((page) => {
        const text = page.text || '';
        const pieces = [];
        if (!text.trim()) {
          pieces.push('');
        } else {
          for (let start = 0; start < text.length; start += CHUNK_CHARS - CHUNK_OVERLAP) {
            pieces.push(text.slice(start, start + CHUNK_CHARS));
            if (start + CHUNK_CHARS >= text.length) break;
          }
        }
        pieces.forEach((piece) => {
          const words = tokens(piece).concat(nameTokens);
          const tf = new Map();
          words.forEach((word) => tf.set(word, (tf.get(word) || 0) + 1));
          tf.forEach((_, word) => df.set(word, (df.get(word) || 0) + 1));
          chunks.push({ doc, page: page.n, text: piece, tf, len: words.length, image: !!page.image });
        });
      });
    });
    const avg = chunks.reduce((sum, chunk) => sum + chunk.len, 0) / (chunks.length || 1);
    const index = { key, docs, chunks, df, avg };
    indexCache.set(chatId, index);
    return index;
  }

  function snippet(text, terms) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= 600) return clean;
    const folded = fold(clean);
    let best = 0;
    terms.some((term) => { const at = folded.indexOf(term); if (at >= 0) { best = at; return true; } return false; });
    const start = Math.max(0, best - 200);
    return (start > 0 ? '…' : '') + clean.slice(start, start + 600) + (start + 600 < clean.length ? '…' : '');
  }

  async function search(chatId, query, options) {
    const opts = options || {};
    const limit = Math.max(1, Math.min(20, Number(opts.limit) || 8));
    const index = await buildIndex(chatId);
    const terms = Array.from(new Set(tokens(query)));
    const phrase = fold(query).replace(/["“”]/g, '').trim();
    const onlyDoc = opts.doc ? String(opts.doc).toUpperCase().replace(/:.*/, '') : '';
    const N = index.chunks.length || 1;
    const scored = [];
    index.chunks.forEach((chunk) => {
      if (onlyDoc && chunk.doc.ref !== onlyDoc) return;
      let score = 0;
      terms.forEach((term) => {
        const f = chunk.tf.get(term);
        if (!f) return;
        const idf = Math.log(1 + (N - index.df.get(term) + 0.5) / (index.df.get(term) + 0.5));
        score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * chunk.len / index.avg));
      });
      if (!score) return;
      if (phrase.length > 4 && phrase.includes(' ') && fold(chunk.text).includes(phrase)) score *= 1.6;
      const matched = terms.filter((term) => chunk.tf.has(term)).length;
      score *= 0.6 + 0.4 * matched / (terms.length || 1);
      scored.push({ chunk, score });
    });
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const hits = [];
    for (const { chunk, score } of scored) {
      const key = chunk.doc.ref + ':' + chunk.page;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ ref: key.replace(':', ':p'), doc: chunk.doc.ref, name: chunk.doc.path, page: chunk.page, kind: chunk.doc.kind, image: chunk.image, score: Math.round(score * 100) / 100, snippet: chunk.text ? snippet(chunk.text, terms) : '' });
      if (hits.length >= limit) break;
    }
    return { query, terms, hits, total: scored.length };
  }

  function parseRef(ref) {
    const match = /^\s*(D\d+)(?::?p?(\d+)(?:\s*-\s*(\d+))?)?\s*$/i.exec(String(ref || ''));
    if (!match) return null;
    return { doc: match[1].toUpperCase(), from: match[2] ? Number(match[2]) : 0, to: match[3] ? Number(match[3]) : (match[2] ? Number(match[2]) : 0) };
  }

  async function findDoc(chatId, ref) {
    const docs = await byChat('docs', chatId);
    const wanted = String(ref || '').trim();
    return docs.find((doc) => doc.ref === wanted.toUpperCase()) ||
      docs.find((doc) => doc.path === wanted || doc.name === wanted) ||
      docs.find((doc) => fold(doc.path).includes(fold(wanted)) && wanted.length > 2) || null;
  }

  async function read(chatId, ref, pages, maxChars) {
    const parsed = parseRef(ref);
    const doc = await findDoc(chatId, parsed ? parsed.doc : ref);
    if (!doc) return null;
    let from = parsed && parsed.from ? parsed.from : 1;
    let to = parsed && parsed.to ? parsed.to : from;
    const range = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(String(pages || ''));
    if (range) { from = Number(range[1]); to = range[2] ? Number(range[2]) : from; }
    if (!parsed || (!parsed.from && !range)) { from = 1; to = doc.pages.length; }
    const limit = maxChars || 16000;
    let out = '';
    let last = from - 1;
    for (const page of doc.pages) {
      if (page.n < from || page.n > to) continue;
      const label = doc.kind === 'pdf' ? 'Página ' + page.n : doc.kind === 'image' ? 'Imagen' : doc.kind === 'slides' ? 'Diapositiva ' + page.n : 'Sección ' + page.n;
      const body = page.text && page.text.trim() ? page.text.trim() : (page.ocr === 'pending' ? '(imagen; el OCR aún la está leyendo)' : '(sin texto)');
      const piece = '[' + doc.ref + ' · ' + label + (page.image ? ' · imagen ' + doc.ref + ':p' + page.n : '') + ']\n' + body + '\n\n';
      if (out && out.length + piece.length > limit) break;
      out += piece.length > limit ? piece.slice(0, limit) + '…\n\n' : piece;
      last = page.n;
    }
    return { doc: summary(doc), from, to: last, more: last < Math.min(to, doc.pages.length) ? last + 1 : 0, text: out.trim() };
  }

  async function image(chatId, ref) {
    const parsed = parseRef(ref);
    const doc = await findDoc(chatId, parsed ? parsed.doc : ref);
    if (!doc) return null;
    const page = doc.pages.find((entry) => entry.image && (!parsed || !parsed.from || entry.n === parsed.from)) || null;
    if (!page) return { doc: summary(doc), missing: true };
    const record = await get('images', page.image);
    return record ? { doc: summary(doc), page: page.n, mimeType: record.mimeType, data: record.data, text: page.text || '' } : { doc: summary(doc), missing: true };
  }

  async function list(chatId) {
    return (await byChat('docs', chatId)).map(summary).sort((a, b) => (Number(a.ref.slice(1)) || 0) - (Number(b.ref.slice(1)) || 0));
  }

  async function removeLocal(doc) {
    for (const page of doc.pages) if (page.image) await del('images', page.image);
    await del('originals', doc.id);
    await del('docs', doc.id);
  }

  // The file as it was uploaded or saved: { doc, name, mimeType, bytes }. ref: "D3", a path or a file name.
  async function original(chatId, ref) {
    const wanted = String(ref || '').trim();
    const parsed = parseRef(wanted);
    const docs = await byChat('docs', chatId);
    const lower = wanted.toLowerCase();
    const doc = (parsed && docs.find((entry) => entry.ref.toLowerCase() === parsed.doc.toLowerCase())) ||
      docs.find((entry) => entry.path.toLowerCase() === lower) || docs.find((entry) => entry.name.toLowerCase() === lower) ||
      docs.find((entry) => entry.path.toLowerCase().endsWith('/' + lower));
    if (!doc) return null;
    const record = doc.hasOriginal ? await get('originals', doc.id) : null;
    if (!record) return { doc: summary(doc), name: doc.name, missing: true };
    return { doc: summary(doc), name: doc.name, path: doc.path, mimeType: record.mimeType || doc.mimeType || '', bytes: new Uint8Array(record.data) };
  }

  async function remove(chatId, docId) {
    const doc = await get('docs', docId);
    if (!doc || doc.chatId !== chatId) return false;
    await removeLocal(doc);
    indexCache.delete(chatId);
    if (drive && doc.driveId) drive.remove(doc.driveId).catch(() => {});
    emit();
    return true;
  }

  async function removeChat(chatId) {
    const docs = await byChat('docs', chatId);
    for (const doc of docs) await remove(chatId, doc.id);
  }

  // Text for the user message: what was added, never the content itself.
  function manifestText(added, skipped) {
    const lines = ['[Biblioteca del chat] El usuario ha subido ' + added.length + (added.length === 1 ? ' archivo' : ' archivos') + '. No están en este mensaje: búscalos con search_library y léelos con read_library (o view_library_image para ver una imagen).'];
    added.slice(0, 60).forEach((doc) => {
      lines.push('- ' + doc.ref + ' · ' + doc.path + ' · ' + describe(doc));
    });
    if (added.length > 60) lines.push('- … y ' + (added.length - 60) + ' más (list_library los muestra todos).');
    if (skipped && skipped.length) lines.push('No se pudieron leer: ' + skipped.slice(0, 10).map((item) => item.path + ' (' + item.reason + ')').join(', ') + (skipped.length > 10 ? '…' : '') + '.');
    return lines.join('\n');
  }

  function describe(doc) {
    const parts = [];
    if (doc.kind === 'pdf') parts.push('PDF de ' + doc.totalPages + (doc.totalPages === 1 ? ' página' : ' páginas'));
    else if (doc.kind === 'slides') parts.push('presentación de ' + doc.pages + (doc.pages === 1 ? ' diapositiva' : ' diapositivas'));
    else if (doc.kind === 'image') parts.push('imagen');
    else parts.push(doc.pages + (doc.pages === 1 ? ' sección' : ' secciones'));
    if (doc.words) parts.push('~' + doc.words.toLocaleString('es-ES') + ' palabras');
    if (doc.images && doc.kind === 'pdf') parts.push(doc.images + ' escaneadas');
    if (doc.pendingOcr) parts.push('OCR en curso');
    return parts.join(' · ');
  }

  /* ── Drive ───────────────────────────────────────────────────────── */

  async function uploadToDrive(docId) {
    if (!drive) return;
    const doc = await get('docs', docId);
    if (!doc) return;
    const images = [];
    for (const page of doc.pages) if (page.image) { const record = await get('images', page.image); if (record) images.push(record); }
    // The original travels too while it is small enough for one Drive file.
    const record = doc.hasOriginal ? await get('originals', doc.id) : null;
    const originalData = record && record.data.byteLength <= MAX_DRIVE_ORIGINAL_BYTES ? { mimeType: record.mimeType, data: toBase64(record.data) } : null;
    const id = await drive.upload('library-' + doc.id + '.json', JSON.stringify({ v: 1, doc, images, original: originalData }), { [DRIVE_DOC_TAG]: '1', chatId: doc.chatId }, doc.driveId || '');
    if (id && id !== doc.driveId) {
      const fresh = await get('docs', docId);
      if (fresh) { fresh.driveId = id; await put('docs', fresh); }
    }
  }

  // Documents added before Drive was ready (or while offline) go up now.
  async function uploadMissing(chatId) {
    if (!drive) return 0;
    const docs = (await byChat('docs', chatId)).filter((doc) => !doc.driveId);
    for (const doc of docs) await uploadToDrive(doc.id);
    return docs.length;
  }

  // Brings in the documents another device added to this chat.
  async function pullFromDrive(chatId) {
    if (!drive) return 0;
    const remote = await drive.list({ [DRIVE_DOC_TAG]: '1', chatId });
    const local = await byChat('docs', chatId);
    const known = new Set(local.map((doc) => 'library-' + doc.id + '.json'));
    let added = 0;
    for (const file of remote) {
      if (known.has(file.name)) continue;
      try {
        const payload = JSON.parse(await drive.download(file.id));
        if (!payload || !payload.doc || payload.doc.chatId !== chatId) continue;
        for (const record of payload.images || []) await put('images', record);
        if (payload.original && payload.original.data) await put('originals', { id: payload.doc.id, chatId, mimeType: payload.original.mimeType || '', data: fromBase64(payload.original.data) });
        else payload.doc.hasOriginal = false;
        payload.doc.driveId = file.id;
        await put('docs', payload.doc);
        added++;
      } catch (error) {
        console.warn('Biblioteca ← Drive:', error);
      }
    }
    if (added) { indexCache.delete(chatId); emit(); }
    return added;
  }

  window.InhouseLibrary = {
    ingest, list, search, read, image, original, remove, removeChat, manifestText, describe, kindOf, pullFromDrive, uploadMissing, runOcrQueue,
    configureDrive: (adapter) => { drive = adapter || null; },
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    status: () => Object.assign({}, status),
    _tokens: tokens
  };

  // Pages left half-read by a closed tab are read now.
  setTimeout(() => { if (window.indexedDB) runOcrQueue().catch(() => {}); }, 4000);
})();
