// Google Drive del usuario: herramientas de pi para buscar y leer sus
// archivos (solo lectura al conectar, permiso drive.readonly) y, si hace falta
// cambiar algo, una herramienta por acción y por archivo. Cada escritura pasa
// por ctx.confirm() con always: la app la pregunta SIEMPRE, también en
// «Acceso total», enseñando el archivo y lo que cambia; y la primera vez pide
// a Google el permiso de escritura (ctx.ensureWrite).
//
// ctx: { fetch(url, options) → Response con el token de Google, confirm(request),
//   ensureWrite(), pdfText(arrayBuffer, fromPage, toPage)?, acceptsImages, signal }
import { Type } from '@earendil-works/pi-ai';
import { googleProblem } from './gmail.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS = 'id,name,mimeType,modifiedTime,size,parents,webViewLink,owners(displayName),trashed,capabilities(canEdit)';
const MAX_READ_CHARS = 40000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FOLDER = 'application/vnd.google-apps.folder';
const WRITE_TOOLS = new Set(['drive_write_file', 'drive_edit_file', 'drive_organize']);
// Google files have no bytes of their own: they are exported.
const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json'
};
const KIND = {
  'application/vnd.google-apps.document': 'Documento de Google',
  'application/vnd.google-apps.spreadsheet': 'Hoja de cálculo de Google (se lee la primera hoja, en CSV)',
  'application/vnd.google-apps.presentation': 'Presentación de Google',
  [FOLDER]: 'carpeta',
  'application/pdf': 'PDF'
};
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|x-sh|x-yaml|yaml|x-tex|sql|ld\+json|xhtml\+xml|csv))/;
const TEXT_NAME = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|html?|css|m?js|cjs|ts|tsx|jsx|py|java|kt|c|cc|cpp|h|cs|go|rs|rb|php|sh|sql|tex|ini|cfg|toml|log|srt|vtt)$/i;

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

function clip(text, from, max) {
  const value = String(text == null ? '' : text);
  const start = Math.max(0, Math.floor(Number(from) || 0));
  const end = Math.min(value.length, start + max);
  const part = value.slice(start, end);
  return {
    text: part,
    note: end < value.length ? '\n… (quedan ' + (value.length - end) + ' caracteres: vuelve a leer con from=' + end + ')' : '',
    total: value.length
  };
}

function lineStats(before, after) {
  const count = (text) => {
    const map = new Map();
    (text ? String(text).split('\n') : []).forEach((line) => map.set(line, (map.get(line) || 0) + 1));
    return map;
  };
  const a = count(before);
  const b = count(after);
  let added = 0;
  let removed = 0;
  b.forEach((n, line) => { added += Math.max(0, n - (a.get(line) || 0)); });
  a.forEach((n, line) => { removed += Math.max(0, n - (b.get(line) || 0)); });
  return { added, removed };
}

// Word, PowerPoint and Excel files (templates included): read as text, or imported whole.
const OFFICE_NAME = /\.(docx|dotx|docm|dotm|pptx|potx|pptm|xlsx|xltx|xlsm)$/i;
const isOffice = (file) => OFFICE_NAME.test(file.name || '') || /officedocument|ms-word|ms-excel|ms-powerpoint/.test(file.mimeType || '');
// Google files, imported as the Office file the user would download.
const IMPORTS = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: '.pdf' }
};
const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

const isText = (file) => TEXT_MIME.test(file.mimeType || '') || TEXT_NAME.test(file.name || '');
const isGoogle = (file) => String(file.mimeType || '').startsWith('application/vnd.google-apps.');

function describe(file) {
  const bits = [KIND[file.mimeType] || file.mimeType || 'archivo'];
  if (file.size) bits.push(Math.max(1, Math.round(Number(file.size) / 1024)) + ' KB');
  if (file.modifiedTime) bits.push('cambiado ' + String(file.modifiedTime).slice(0, 10));
  if (file.owners && file.owners[0] && file.owners[0].displayName) bits.push('de ' + file.owners[0].displayName);
  return file.name + ' · id ' + file.id + ' · ' + bits.join(', ');
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function createDriveTools(ctx) {
  async function call(url, options, what) {
    for (let attempt = 0; ; attempt++) {
      const response = await ctx.fetch(url, Object.assign({ signal: ctx.signal }, options || {}));
      if (response.ok) return response;
      let data = null;
      try { data = await response.json(); } catch (_) {}
      const problem = googleProblem(response.status, data, 'Google Drive');
      // Just turned on in Google Cloud: it answers after a few minutes.
      if (problem.kind === 'disabled' && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      const hint = problem.kind !== 'other' ? '' : response.status === 403 ? ' (Google no da permiso: puede que el archivo no sea tuyo o que falte el permiso de Drive; vuelve a conectar Drive en el menú +)'
        : response.status === 404 ? ' (no existe o no tienes acceso)' : '';
      const error = new Error('Google Drive ' + response.status + (what ? ' al ' + what : '') + ': ' + (problem.kind === 'other' ? (problem.text === 'error' ? response.statusText || 'error' : problem.text) : problem.text) + hint);
      error.status = response.status;
      error.kind = problem.kind;
      throw error;
    }
  }
  const json = async (url, options, what) => (await call(url, options, what)).json();
  const meta = (id) => json(API + '/files/' + encodeURIComponent(id) + '?supportsAllDrives=true&fields=' + encodeURIComponent(FIELDS), null, 'leer el archivo');
  const idOf = (raw) => {
    const value = String(raw || '').trim();
    const match = /\/d\/([\w-]+)|[?&]id=([\w-]+)|\/folders\/([\w-]+)/.exec(value);
    const id = match ? (match[1] || match[2] || match[3]) : value;
    if (!/^[\w-]{1,200}$/.test(id)) throw new Error('Id de archivo no válido: "' + raw + '". Usa el id que devuelve drive_search o el enlace del archivo.');
    return id;
  };

  async function textOf(file) {
    if (EXPORTS[file.mimeType]) return (await call(API + '/files/' + encodeURIComponent(file.id) + '/export?mimeType=' + encodeURIComponent(EXPORTS[file.mimeType]), null, 'exportar')).text();
    if (isText(file)) return (await call(API + '/files/' + encodeURIComponent(file.id) + '?alt=media&supportsAllDrives=true', null, 'descargar')).text();
    return null;
  }

  // Every change: once per file and per action, even in «Acceso total».
  async function approve(request) {
    const ok = await ctx.confirm(Object.assign({ always: true, kind: 'drive', confirmText: 'Permitir' }, request));
    if (!ok) throw new Error('El usuario no ha dado permiso para este cambio en Google Drive. No lo repitas sin preguntarle.');
    await ctx.ensureWrite();
  }

  const tools = [
    {
      name: 'drive_shared_drives',
      label: 'Drive: unidades compartidas',
      description: 'List the shared drives (unidades compartidas) this Google account belongs to, with their ids. Their files also come up in drive_search; use a shared drive id as folder in drive_list or drive_search to look inside it.',
      parameters: Type.Object({}),
      execute: async () => {
        const data = await json(API + '/drives?pageSize=100&fields=' + encodeURIComponent('drives(id,name)'), null, 'listar las unidades compartidas');
        const drives = data.drives || [];
        return textResult(drives.length ? drives.map((drive) => drive.name + ' · id ' + drive.id).join('\n') : 'Esta cuenta no tiene unidades compartidas.', { count: drives.length });
      }
    },
    {
      name: 'drive_search',
      label: 'Drive: buscar',
      description: 'Search the user\'s Google Drive (read-only) by name and by the text inside files. Returns name, id, type and date. Use it whenever the user mentions their notes, documents, sheets or files in Drive, then read with drive_read.',
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: 'Words to find in the name or the content. Empty: the most recently changed files.' })),
        folder: Type.Optional(Type.String({ description: 'Only inside this folder (id or link).' })),
        type: Type.Optional(Type.String({ description: '"document", "spreadsheet", "presentation", "pdf", "image", "folder" or empty for any.' })),
        limit: Type.Optional(Type.Number({ description: 'How many (default 20, max 50).' }))
      }),
      execute: async (id, params) => {
        const words = String(params.query || '').trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const clauses = ['trashed = false'];
        if (words) clauses.push("(name contains '" + words + "' or fullText contains '" + words + "')");
        if (params.folder) clauses.push("'" + idOf(params.folder) + "' in parents");
        const types = { document: "mimeType = 'application/vnd.google-apps.document'", spreadsheet: "mimeType = 'application/vnd.google-apps.spreadsheet'", presentation: "mimeType = 'application/vnd.google-apps.presentation'", pdf: "mimeType = 'application/pdf'", image: "mimeType contains 'image/'", folder: "mimeType = '" + FOLDER + "'" };
        if (types[params.type]) clauses.push(types[params.type]);
        const limit = Math.min(50, Math.max(1, Number(params.limit) || 20));
        const query = new URLSearchParams({ q: clauses.join(' and '), pageSize: String(limit), fields: 'files(' + FIELDS + ')', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives' });
        if (!words) query.set('orderBy', 'modifiedTime desc');
        const data = await json(API + '/files?' + query, null, 'buscar');
        const files = data.files || [];
        return textResult(files.length ? files.map(describe).join('\n') : 'No hay ningún archivo que coincida' + (words ? ' con «' + params.query + '»' : '') + '.', { count: files.length });
      }
    },
    {
      name: 'drive_list',
      label: 'Drive: carpeta',
      description: 'List what is inside a folder of the user\'s Google Drive (default: the root, «Mi unidad»).',
      parameters: Type.Object({ folder: Type.Optional(Type.String({ description: 'Folder id or link (default root).' })) }),
      execute: async (id, params) => {
        const folder = params.folder ? idOf(params.folder) : 'root';
        const query = new URLSearchParams({ q: "'" + folder + "' in parents and trashed = false", pageSize: '200', orderBy: 'folder,name', fields: 'files(' + FIELDS + ')', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
        const files = (await json(API + '/files?' + query, null, 'listar la carpeta')).files || [];
        return textResult(files.length ? files.map(describe).join('\n') : 'La carpeta está vacía.', { count: files.length });
      }
    },
    {
      name: 'drive_read',
      label: 'Drive: leer',
      description: 'Read a file of the user\'s Google Drive: Google Docs, Sheets (first sheet, CSV) and Slides as text, text and code files, PDFs (by pages) and images (you see the picture). Long files are read in parts with from.',
      parameters: Type.Object({
        id: Type.String({ description: 'File id (from drive_search) or its link.' }),
        from: Type.Optional(Type.Number({ description: 'Character to start at, for long files (default 0).' })),
        pages: Type.Optional(Type.String({ description: 'PDF pages, e.g. "1-5" (default the first 10).' }))
      }),
      execute: async (id, params) => {
        const file = await meta(idOf(params.id));
        if (file.mimeType === FOLDER) throw new Error(file.name + ' es una carpeta: usa drive_list.');
        const head = describe(file) + (file.webViewLink ? '\n' + file.webViewLink : '') + '\n\n';
        if (String(file.mimeType).startsWith('image/')) {
          if (Number(file.size) > MAX_IMAGE_BYTES) return textResult(head + 'La imagen pesa demasiado para verla aquí (' + Math.round(Number(file.size) / 1048576) + ' MB).');
          if (ctx.acceptsImages === false) return textResult(head + 'Es una imagen y el modelo de este chat no ve imágenes.');
          const buffer = await (await call(API + '/files/' + encodeURIComponent(file.id) + '?alt=media&supportsAllDrives=true', null, 'descargar')).arrayBuffer();
          return { content: [{ type: 'text', text: head.trim() }, { type: 'image', data: bytesToBase64(buffer), mimeType: file.mimeType }], details: { id: file.id } };
        }
        if (file.mimeType === 'application/pdf') {
          if (typeof ctx.pdfText !== 'function') throw new Error('No puedo leer PDFs aquí.');
          const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(params.pages || '').trim());
          const first = match ? Math.max(1, Number(match[1])) : 1;
          const last = match ? Math.max(first, Number(match[2] || match[1])) : first + 9;
          const buffer = await (await call(API + '/files/' + encodeURIComponent(file.id) + '?alt=media&supportsAllDrives=true', null, 'descargar')).arrayBuffer();
          const pdf = await ctx.pdfText(buffer, first, Math.min(last, first + 29));
          const part = clip(pdf.text, params.from, MAX_READ_CHARS);
          return textResult(head + 'Páginas ' + first + '–' + Math.min(pdf.pages, last) + ' de ' + pdf.pages + ':\n' + part.text + part.note + (last < pdf.pages ? '\n(Sigue con pages="' + (last + 1) + '-' + Math.min(pdf.pages, last + 10) + '".)' : ''), { id: file.id, pages: pdf.pages });
        }
        if (isOffice(file) && typeof ctx.officeText === 'function') {
          const buffer = await (await call(API + '/files/' + encodeURIComponent(file.id) + '?alt=media&supportsAllDrives=true', null, 'descargar')).arrayBuffer();
          const part = clip(await ctx.officeText(buffer, file.name, file.mimeType), params.from, MAX_READ_CHARS);
          return textResult(head + part.text + part.note + (ctx.importFile ? '\n\n(Para verlo tal cual o usarlo como plantilla, tráelo al chat con ' + prefix + 'drive_import.)' : ''), { id: file.id, chars: part.total });
        }
        const text = await textOf(file);
        if (text == null) return textResult(head + 'No sé leer este tipo de archivo (' + file.mimeType + ') como texto.' + (ctx.importFile ? ' Puedes traerlo al chat con ' + prefix + 'drive_import.' : ''));
        const part = clip(text, params.from, MAX_READ_CHARS);
        return textResult(head + part.text + part.note, { id: file.id, chars: part.total });
      }
    },
    {
      name: 'drive_import',
      label: 'Drive: traer al chat',
      description: 'Bring a file of the user\'s Drive (shared drives too) into this chat\'s library as the original file, to look at it page by page (doc_view) and to fill or edit it with doc_edit: Word documents and templates (.docx, .dotx), PowerPoint (.pptx, .potx), Excel (.xlsx, .xltx), PDFs and images. Google Docs/Sheets/Slides come as .docx/.xlsx/.pptx. Use it whenever the user wants a document made «with our template» or «like this file»: import the template, then build the new document from it with doc_edit so its cover, styles, headers, footers and margins stay exactly the same. It only reads Drive; nothing changes there.',
      parameters: Type.Object({
        id: Type.String({ description: 'File id (from drive_search / drive_list) or its link.' })
      }),
      execute: async (id, params) => {
        if (typeof ctx.importFile !== 'function') throw new Error('Este chat no puede guardar archivos.');
        const file = await meta(idOf(params.id));
        if (file.mimeType === FOLDER) throw new Error(file.name + ' es una carpeta: importa sus archivos uno a uno.');
        if (Number(file.size) > MAX_IMPORT_BYTES) throw new Error(file.name + ' pesa ' + Math.round(Number(file.size) / 1048576) + ' MB: el máximo es 30 MB.');
        let name = file.name;
        let mimeType = file.mimeType;
        let response;
        if (IMPORTS[file.mimeType]) {
          const target = IMPORTS[file.mimeType];
          response = await call(API + '/files/' + encodeURIComponent(file.id) + '/export?mimeType=' + encodeURIComponent(target.mime), null, 'exportar');
          mimeType = target.mime;
          if (!name.toLowerCase().endsWith(target.ext)) name += target.ext;
        } else if (isGoogle(file)) {
          throw new Error(file.name + ' es un archivo de Google que no se puede descargar como documento.');
        } else {
          response = await call(API + '/files/' + encodeURIComponent(file.id) + '?alt=media&supportsAllDrives=true', null, 'descargar');
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_IMPORT_BYTES) throw new Error(name + ' pesa más de 30 MB.');
        const doc = await ctx.importFile({ name, mimeType, bytes: buffer, source: file.webViewLink || '' });
        return textResult('Traído al chat: ' + doc.ref + ' · ' + doc.path + ' (' + Math.max(1, Math.round(buffer.byteLength / 1024)) + ' KB). Míralo con doc_view("' + doc.ref + '") y úsalo en doc_edit con await readDocument("' + doc.ref + '").' +
          (/\.(dotx|dotm|potx|xltx)$/i.test(name) ? ' Es una plantilla: guarda el resultado como .docx/.pptx/.xlsx y saveDocument lo convierte en documento normal conservando portada, estilos, cabeceras y márgenes.' : ''),
          { id: file.id, documents: [{ ref: doc.ref, id: doc.id, path: doc.path, size: buffer.byteLength, kind: doc.kind }] });
      }
    },
    {
      name: 'drive_write_file',
      label: 'Drive: escribir un archivo',
      description: 'Create a new text file in the user\'s Google Drive, or replace the whole text of one (a text file, or a Google Doc as plain text: its formatting is lost). The user is asked EVERY time, for this file. Prefer drive_edit_file for small changes to text files.',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: 'File to replace (id or link). Empty: create a new file.' })),
        name: Type.Optional(Type.String({ description: 'Name of the new file, e.g. "resumen.md".' })),
        folder: Type.Optional(Type.String({ description: 'Folder for the new file (default the root).' })),
        content: Type.String({ description: 'The full text.' }),
        google_doc: Type.Optional(Type.Boolean({ description: 'Create it as a Google Doc instead of a text file.' }))
      }),
      execute: async (id, params) => {
        const content = String(params.content == null ? '' : params.content);
        if (params.id) {
          const file = await meta(idOf(params.id));
          if (file.mimeType === FOLDER) throw new Error(file.name + ' es una carpeta.');
          if (isGoogle(file) && file.mimeType !== 'application/vnd.google-apps.document') throw new Error(file.name + ' es un archivo de Google que no es un documento: no lo reescribo como texto.');
          if (!isGoogle(file) && !isText(file)) throw new Error(file.name + ' no es un archivo de texto: no lo reescribo.');
          const before = await textOf(file);
          const stats = lineStats(before, content);
          await approve({
            title: 'Reescribir en Drive: ' + file.name,
            summary: 'Google Drive · ' + file.name + '\nSe sustituye todo su texto' + (isGoogle(file) ? ' (es un Documento de Google: pierde el formato)' : '') + '. Google guarda la versión anterior en su historial.',
            items: [{ path: file.name, status: 'modificado', added: stats.added, removed: stats.removed }]
          });
          const type = isGoogle(file) ? 'text/plain' : (file.mimeType || 'text/plain');
          const done = await json(UPLOAD + '/files/' + encodeURIComponent(file.id) + '?uploadType=media&supportsAllDrives=true&fields=' + encodeURIComponent(FIELDS), { method: 'PATCH', headers: { 'Content-Type': type + '; charset=UTF-8' }, body: content }, 'guardar');
          return textResult('Guardado en Drive: ' + describe(done) + ' (+' + stats.added + ' −' + stats.removed + ' líneas).', { id: done.id });
        }
        const name = String(params.name || '').trim();
        if (!name) throw new Error('Para crear un archivo hace falta name.');
        const folder = params.folder ? idOf(params.folder) : '';
        const folderName = folder ? (await meta(folder)).name : 'Mi unidad';
        await approve({
          title: 'Crear en Drive: ' + name,
          summary: 'Google Drive · ' + folderName + '\nArchivo nuevo' + (params.google_doc ? ' (Documento de Google)' : '') + ', ' + content.split('\n').length + ' líneas.',
          items: [{ path: (folder ? folderName + '/' : '') + name, status: 'nuevo', added: content ? content.split('\n').length : 0, removed: 0 }]
        });
        const metadata = { name };
        if (folder) metadata.parents = [folder];
        if (params.google_doc) metadata.mimeType = 'application/vnd.google-apps.document';
        const boundary = 'inhouse' + Math.random().toString(36).slice(2);
        const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + content + '\r\n--' + boundary + '--';
        const done = await json(UPLOAD + '/files?uploadType=multipart&supportsAllDrives=true&fields=' + encodeURIComponent(FIELDS), { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body }, 'crear');
        return textResult('Creado en Drive: ' + describe(done) + (done.webViewLink ? '\n' + done.webViewLink : ''), { id: done.id });
      }
    },
    {
      name: 'drive_edit_file',
      label: 'Drive: editar un archivo',
      description: 'Replace an exact, unique fragment of a text file in the user\'s Google Drive (not Google Docs: use drive_write_file for those). The user is asked EVERY time, for this file.',
      parameters: Type.Object({
        id: Type.String({ description: 'File id or link.' }),
        find: Type.String({ description: 'Exact text to replace; it must appear once.' }),
        replace: Type.String({ description: 'The new text.' })
      }),
      execute: async (id, params) => {
        const file = await meta(idOf(params.id));
        if (isGoogle(file) || !isText(file)) throw new Error(file.name + ' no es un archivo de texto normal: ' + (file.mimeType === 'application/vnd.google-apps.document' ? 'usa drive_write_file.' : 'no lo puedo editar.'));
        const before = await textOf(file);
        const find = String(params.find || '');
        const count = find ? before.split(find).length - 1 : 0;
        if (count !== 1) throw new Error(count ? 'El fragmento aparece ' + count + ' veces en ' + file.name + ': amplíalo para que sea único.' : 'No encuentro ese fragmento en ' + file.name + ': léelo otra vez con drive_read.');
        const after = before.replace(find, () => String(params.replace == null ? '' : params.replace));
        const stats = lineStats(before, after);
        await approve({
          title: 'Editar en Drive: ' + file.name,
          summary: 'Google Drive · ' + file.name + '\n− ' + find.slice(0, 300) + '\n+ ' + String(params.replace || '').slice(0, 300),
          items: [{ path: file.name, status: 'modificado', added: stats.added, removed: stats.removed }]
        });
        const done = await json(UPLOAD + '/files/' + encodeURIComponent(file.id) + '?uploadType=media&supportsAllDrives=true&fields=' + encodeURIComponent(FIELDS), { method: 'PATCH', headers: { 'Content-Type': (file.mimeType || 'text/plain') + '; charset=UTF-8' }, body: after }, 'guardar');
        return textResult('Editado en Drive: ' + describe(done) + ' (+' + stats.added + ' −' + stats.removed + ' líneas).', { id: done.id });
      }
    },
    {
      name: 'drive_organize',
      label: 'Drive: organizar',
      description: 'One change to one item of the user\'s Google Drive: rename it, move it to another folder, send it to the trash, or create a folder. The user is asked EVERY time, for this item and this action; for several items call it once per item.',
      parameters: Type.Object({
        action: Type.String({ description: '"rename", "move", "trash" or "create_folder".' }),
        id: Type.Optional(Type.String({ description: 'The file or folder (id or link); not for create_folder.' })),
        name: Type.Optional(Type.String({ description: 'New name (rename) or the new folder\'s name (create_folder).' })),
        folder: Type.Optional(Type.String({ description: 'Destination folder (move) or parent of the new folder (create_folder; default root).' }))
      }),
      execute: async (id, params) => {
        const action = String(params.action || '');
        if (action === 'create_folder') {
          const name = String(params.name || '').trim();
          if (!name) throw new Error('Falta el nombre de la carpeta.');
          const parent = params.folder ? idOf(params.folder) : '';
          const parentName = parent ? (await meta(parent)).name : 'Mi unidad';
          await approve({ title: 'Crear carpeta en Drive: ' + name, summary: 'Google Drive · dentro de ' + parentName, items: [{ path: name + '/', status: 'nuevo', added: 0, removed: 0 }] });
          const done = await json(API + '/files?supportsAllDrives=true&fields=' + encodeURIComponent(FIELDS), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ name, mimeType: FOLDER }, parent ? { parents: [parent] } : {})) }, 'crear la carpeta');
          return textResult('Carpeta creada: ' + describe(done), { id: done.id });
        }
        if (!params.id) throw new Error('Falta el id del archivo.');
        const file = await meta(idOf(params.id));
        if (action === 'rename') {
          const name = String(params.name || '').trim();
          if (!name) throw new Error('Falta el nombre nuevo.');
          await approve({ title: 'Renombrar en Drive: ' + file.name, summary: 'Google Drive · «' + file.name + '» → «' + name + '»', items: [{ path: file.name + ' → ' + name, status: 'renombrado', added: 0, removed: 0 }] });
          const done = await json(API + '/files/' + encodeURIComponent(file.id) + '?supportsAllDrives=true&fields=' + encodeURIComponent(FIELDS), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }, 'renombrar');
          return textResult('Renombrado: ' + describe(done), { id: done.id });
        }
        if (action === 'move') {
          if (!params.folder) throw new Error('Falta la carpeta de destino.');
          const to = await meta(idOf(params.folder));
          if (to.mimeType !== FOLDER) throw new Error(to.name + ' no es una carpeta.');
          await approve({ title: 'Mover en Drive: ' + file.name, summary: 'Google Drive · «' + file.name + '» → carpeta «' + to.name + '»', items: [{ path: file.name + ' → ' + to.name + '/', status: 'movido', added: 0, removed: 0 }] });
          const query = new URLSearchParams({ addParents: to.id, removeParents: (file.parents || []).join(','), supportsAllDrives: 'true', fields: FIELDS });
          const done = await json(API + '/files/' + encodeURIComponent(file.id) + '?' + query, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 'mover');
          return textResult('Movido a «' + to.name + '»: ' + describe(done), { id: done.id });
        }
        if (action === 'trash') {
          await approve({ title: 'Mandar a la papelera: ' + file.name, summary: 'Google Drive · «' + file.name + '» va a la papelera (se puede recuperar desde allí durante 30 días).', items: [{ path: file.name, status: 'borrado', added: 0, removed: 0 }], danger: true });
          await json(API + '/files/' + encodeURIComponent(file.id) + '?supportsAllDrives=true&fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }, 'mandar a la papelera');
          return textResult('«' + file.name + '» está en la papelera de Drive.', { id: file.id });
        }
        throw new Error('Acción no válida: usa rename, move, trash o create_folder.');
      }
    }
  ];
  // Another account linked for a question: read-only tools with their own
  // names (extra_drive_*), next to the user's own Drive if that is on too.
  const prefix = ctx.prefix || '';
  const accountNote = ctx.account ? ' (Google account ' + ctx.account + ', read-only)' : '';
  return tools
    .filter((tool) => !ctx.readOnly || !WRITE_TOOLS.has(tool.name))
    .map((tool) => prefix || accountNote ? Object.assign({}, tool, { name: prefix + tool.name, description: tool.description + accountNote }) : tool);
}
