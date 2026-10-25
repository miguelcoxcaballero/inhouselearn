// Herramientas del agente: archivos del chat y JavaScript en un sandbox.
// El espacio de archivos lo pone la app (vive en el chat y se guarda con él);
// aquí solo se definen las herramientas de pi que lo usan.
import { Type } from '@earendil-works/pi-ai';

const RUN_TIMEOUT_MS = 15000;
const MAX_FILE_CHARS = 400000;
const MAX_READ_CHARS = 20000;
const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 12000;
const MAX_SEARCH_RESULTS = 60;

// What the model has seen of each file (a hash of the content it read or wrote),
// per chat: write_file never overwrites a file the model has not seen as it is now.
const seenByWorkspace = new Map();
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + text.length;
}

// "apuntes/*.md", "**/*.js", "notas.txt" → RegExp over the whole path.
function globToRegExp(glob) {
  const source = String(glob || '*').trim() || '*';
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '*' && source[i + 1] === '*') { out += '.*'; i++; if (source[i + 1] === '/') i++; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A bare pattern ("*.md") matches in any folder, like most tools.
  return new RegExp('^' + (source.includes('/') ? '' : '(?:.*/)?') + out + '$', 'i');
}

export function normalizePath(raw) {
  const path = String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .replace(/\/{2,}/g, '/');
  if (!path || path.length > 200 || path.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Ruta de archivo no válida: "' + raw + '". Usa algo como apuntes/tema1.md.');
  }
  return path;
}

function clip(text, max) {
  const value = String(text == null ? '' : text);
  return value.length > max ? value.slice(0, max) + '\n… (' + (value.length - max) + ' caracteres más)' : value;
}

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

// El código corre en un Web Worker: hilo aparte (un bucle infinito no congela la
// app y se corta con terminate()), sin DOM ni localStorage, y sin red.
const WORKER_SOURCE = `
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel']) {
  try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch (_) {}
}
const format = (value) => {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2); } catch (_) { return String(value); }
};
self.onmessage = async (event) => {
  const { code, files } = event.data;
  const logs = [];
  const writes = {};
  const log = (prefix) => (...args) => logs.push(prefix + args.map(format).join(' '));
  const sandboxConsole = { log: log(''), info: log(''), debug: log(''), table: log(''), warn: log('[warn] '), error: log('[error] ') };
  const clean = (path) => String(path).replace(/^(\\.\\/|\\/)+/, '');
  const readFile = (path) => {
    const key = clean(path);
    if (key in writes) return writes[key];
    if (key in files) return files[key];
    throw new Error('No existe el archivo: ' + key);
  };
  const writeFile = (path, content) => { writes[clean(path)] = String(content); };
  const listFiles = () => Array.from(new Set(Object.keys(files).concat(Object.keys(writes))));
  let result;
  let error;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    result = await new AsyncFunction('console', 'readFile', 'writeFile', 'listFiles', code)(sandboxConsole, readFile, writeFile, listFiles);
  } catch (e) {
    error = e && e.stack ? String(e.stack).split('\\n').slice(0, 5).join('\\n') : String(e);
  }
  self.postMessage({ logs, result: result === undefined ? undefined : format(result), error, writes });
};
`;

let workerUrl = null;

export function runInSandbox(code, files, signal) {
  if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  return new Promise((resolve) => {
    const worker = new Worker(workerUrl);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.terminate();
      resolve(Object.assign({ logs: [], writes: {} }, value));
    };
    const onAbort = () => finish({ error: 'Cancelado.' });
    const timer = setTimeout(() => finish({ error: 'Tiempo agotado: el código tardó más de ' + RUN_TIMEOUT_MS / 1000 + ' s (¿un bucle infinito?).' }), RUN_TIMEOUT_MS);
    worker.onmessage = (event) => finish(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      finish({ error: event.message || 'Error al ejecutar el código.' });
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }
    worker.postMessage({ code: String(code || ''), files });
  });
}

// workspace: { list(): [{ path, size }], read(path): string|null, write(path, text), remove(path): boolean }
export function createWorkspaceTools(workspace) {
  const seenKey = workspace.key || workspace;
  if (!seenByWorkspace.has(seenKey)) seenByWorkspace.set(seenKey, new Map());
  const seen = seenByWorkspace.get(seenKey);
  const snapshot = () => Object.fromEntries(workspace.list().map((file) => [file.path, workspace.read(file.path) || '']));

  const writeChecked = (path, content) => {
    const text = String(content == null ? '' : content);
    if (text.length > MAX_FILE_CHARS) {
      throw new Error('El archivo es demasiado grande para guardarlo en el navegador (máximo ' + MAX_FILE_CHARS + ' caracteres).');
    }
    workspace.write(path, text);
    return text.length;
  };

  return [
    {
      name: 'run_js',
      label: 'Ejecutar JavaScript',
      description: 'Run JavaScript in an isolated sandbox (separate thread, no network, no DOM). Use it for exact arithmetic, checking a solution, simulations, or generating data and tables; not for things you can answer directly. Top-level await works. console.log output is captured; use `return` to give back a value. The chat files are available through readFile(path), listFiles() and writeFile(path, text). Time limit: 15 seconds.',
      parameters: Type.Object({
        code: Type.String({ description: 'JavaScript source to run.' })
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params, signal) => {
        const outcome = await runInSandbox(params.code, snapshot(), signal);
        const written = [];
        const refused = [];
        for (const [path, content] of Object.entries(outcome.writes || {})) {
          // A bad path or a file too big never hides the console output.
          try {
            const clean = normalizePath(path);
            writeChecked(clean, content);
            seen.set(clean, hashText(String(content)));
            written.push(clean);
          } catch (error) {
            refused.push(path + ': ' + (error && error.message ? error.message : error));
          }
        }
        const sections = [];
        if (outcome.logs.length) sections.push('console:\n' + outcome.logs.join('\n'));
        if (outcome.result !== undefined) sections.push('return:\n' + outcome.result);
        if (written.length) sections.push('archivos guardados: ' + written.join(', '));
        if (refused.length) sections.push('no guardados:\n' + refused.join('\n'));
        if (outcome.error) sections.push('error:\n' + outcome.error);
        let text = sections.join('\n\n') || '(sin salida)';
        if (text.length > MAX_OUTPUT_CHARS) text = clip(text, MAX_OUTPUT_CHARS) + '\n(Salida cortada. Para verla entera, guárdala con writeFile("salida.txt", …) y léela por partes con read_file.)';
        return { content: [{ type: 'text', text }], details: { written }, isError: !!outcome.error || refused.length > 0 };
      }
    },
    {
      name: 'write_file',
      label: 'Guardar archivo',
      description: 'Create a text file in this chat (notes, outlines, code, CSV, HTML, LaTeX...), or replace one completely. The user sees the files above the message box and can download them as a ZIP. Only create files when the user asks for one or when the content is long (more than ~60 lines) and worth keeping. To change part of an existing file use edit_file. Replacing an existing file you have not read (or that changed since you read it) is refused unless overwrite is true. Up to ' + MAX_FILE_CHARS + ' characters.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path, e.g. "apuntes/derivadas.md".' }),
        content: Type.String({ description: 'Full file content.' }),
        overwrite: Type.Optional(Type.Boolean({ description: 'true to replace an existing file you have not read as it is now.' }))
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => {
        const path = normalizePath(params.path);
        const current = workspace.read(path);
        if (current != null && !params.overwrite && seen.get(path) !== hashText(current)) {
          throw new Error(path + ' ya existe (' + current.length + ' caracteres) y no lo has leído tal como está ahora. Léelo con read_file y cámbialo con edit_file, o vuelve a llamar a write_file con overwrite: true si de verdad quieres sustituirlo entero.');
        }
        const size = writeChecked(path, params.content);
        seen.set(path, hashText(String(params.content == null ? '' : params.content)));
        return textResult((current != null ? 'Sustituido ' + path + ' (antes ' + current.length + ' caracteres, ahora ' : 'Guardado ' + path + ' (') + size + ' caracteres).', { path });
      }
    },
    {
      name: 'read_file',
      label: 'Leer archivo',
      description: 'Read a text file of this chat, with line numbers ("  12→text"; the number and the arrow are not part of the file: never copy them into edit_file). Up to ' + MAX_READ_LINES + ' lines or ' + MAX_READ_CHARS + ' characters per call; for longer files read the next part with offset (first line, 1-based) and limit (how many lines). Uploaded or generated documents (PDF, Word, PowerPoint, Excel, images) are not chat files: they are in the library.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path of the file.' }),
        offset: Type.Optional(Type.Number({ description: 'First line to read, 1-based (default 1).' })),
        limit: Type.Optional(Type.Number({ description: 'How many lines (default and max ' + MAX_READ_LINES + ').' }))
      }),
      execute: async (toolCallId, params) => {
        const path = normalizePath(params.path);
        const content = workspace.read(path);
        if (content == null) {
          const others = workspace.list().map((file) => file.path);
          throw new Error('No existe el archivo ' + path + ' en los archivos del chat' + (others.length ? ' (hay: ' + others.slice(0, 20).join(', ') + ')' : ' (no hay ninguno)') + '.' + (/\.(pdf|docx?|pptx?|xlsx?|dotx|potx|xltx|png|jpe?g|webp|gif)$/i.test(path) ? ' Los documentos subidos o generados están en la biblioteca, no aquí.' : ''));
        }
        seen.set(path, hashText(content));
        const lines = content.split('\n');
        const total = lines.length;
        const from = Math.min(Math.max(1, Math.floor(Number(params.offset) || 1)), Math.max(1, total));
        const want = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(Number(params.limit) || MAX_READ_LINES)));
        const width = String(Math.min(total, from + want - 1)).length;
        const out = [];
        let chars = 0;
        let last = from - 1;
        for (let n = from; n <= total && n < from + want; n++) {
          const line = (String(n).padStart(width, ' ') + '→' + lines[n - 1]);
          if (chars + line.length > MAX_READ_CHARS && out.length) break;
          out.push(line.length > MAX_READ_CHARS ? line.slice(0, MAX_READ_CHARS) + ' … (línea cortada)' : line);
          chars += line.length + 1;
          last = n;
        }
        const head = path + ' · ' + (from === 1 && last === total ? total + (total === 1 ? ' línea' : ' líneas') : 'líneas ' + from + '-' + last + ' de ' + total) + ' · ' + content.length + ' caracteres';
        const more = last < total ? '\n… Sigue: read_file con path "' + path + '", offset ' + (last + 1) + '.' : '';
        return textResult(head + '\n' + out.join('\n') + more, { path });
      }
    },
    {
      name: 'edit_file',
      label: 'Editar archivo',
      description: 'Replace one exact fragment of a file. old_text must appear exactly once (copy it from read_file without the line numbers); include enough surrounding text to make it unique, or set replace_all to change every occurrence.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path of the file.' }),
        old_text: Type.String({ description: 'Exact text to replace.' }),
        new_text: Type.String({ description: 'Replacement text.' }),
        replace_all: Type.Optional(Type.Boolean({ description: 'true: replace every occurrence of old_text.' }))
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => {
        const path = normalizePath(params.path);
        const content = workspace.read(path);
        if (content == null) throw new Error('No existe el archivo ' + path + '.');
        const count = params.old_text ? content.split(params.old_text).length - 1 : 0;
        if (count === 0 || (count > 1 && !params.replace_all)) {
          throw new Error(count === 0
            ? 'No encuentro ese texto en ' + path + '. Léelo con read_file (o búscalo con search_files) y copia el fragmento exacto, sin los números de línea.'
            : 'Ese texto aparece ' + count + ' veces en ' + path + '. Incluye más contexto para que sea único, o usa replace_all: true para cambiarlas todas.');
        }
        const next = params.replace_all ? content.split(params.old_text).join(String(params.new_text)) : content.replace(params.old_text, () => params.new_text);
        writeChecked(path, next);
        seen.set(path, hashText(next));
        return textResult('Editado ' + path + (count > 1 ? ' (' + count + ' sitios)' : '') + '.', { path });
      }
    },
    {
      name: 'list_files',
      label: 'Ver archivos',
      description: 'List the text files of this chat with their lines and sizes (uploaded or generated documents are in the library).',
      parameters: Type.Object({}),
      execute: async () => {
        const files = workspace.list();
        return textResult(files.length
          ? files.map((file) => { const text = workspace.read(file.path) || ''; return file.path + ' · ' + (text ? text.split('\n').length : 0) + ' líneas · ' + file.size + ' caracteres'; }).join('\n')
          : 'No hay archivos de texto en este chat.');
      }
    },
    {
      name: 'search_files',
      label: 'Buscar en los archivos',
      description: 'Search the text files of this chat, like grep: every matching line with its file and line number (and context lines around it if you ask). pattern is plain text unless regex is true (JavaScript syntax, case-insensitive unless case_sensitive). path is an optional glob like "apuntes/*.md" or "**/*.tex". With an empty pattern it lists the files whose path matches the glob. Uploaded documents are searched with search_library instead.',
      parameters: Type.Object({
        pattern: Type.String({ description: 'Text (or regular expression) to find. Empty: only list the files matching path.' }),
        path: Type.Optional(Type.String({ description: 'Glob of files to search, e.g. "*.md" or "apuntes/**". Default: every file.' })),
        regex: Type.Optional(Type.Boolean({ description: 'true: pattern is a regular expression.' })),
        case_sensitive: Type.Optional(Type.Boolean({ description: 'true: match upper/lower case exactly.' })),
        context: Type.Optional(Type.Number({ description: 'Lines of context before and after each match (default 0, max 5).' }))
      }),
      execute: async (toolCallId, params) => {
        const glob = globToRegExp(params.path || '*');
        const files = workspace.list().map((file) => file.path).filter((path) => glob.test(path));
        const pattern = String(params.pattern || '');
        if (!pattern) {
          return textResult(files.length ? files.length + (files.length === 1 ? ' archivo' : ' archivos') + ':\n' + files.join('\n') : 'Ningún archivo coincide con «' + (params.path || '*') + '».', { matches: files.length });
        }
        let re;
        try {
          re = new RegExp(params.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), params.case_sensitive ? '' : 'i');
        } catch (error) {
          throw new Error('Expresión regular no válida: ' + (error && error.message ? error.message : error));
        }
        const around = Math.min(5, Math.max(0, Math.floor(Number(params.context) || 0)));
        const blocks = [];
        let total = 0;
        const touched = new Set();
        for (const path of files) {
          const lines = String(workspace.read(path) || '').split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            total++;
            touched.add(path);
            if (blocks.length >= MAX_SEARCH_RESULTS) continue;
            const from = Math.max(0, i - around);
            const to = Math.min(lines.length - 1, i + around);
            const shown = [];
            for (let k = from; k <= to; k++) shown.push(path + ':' + (k + 1) + (k === i ? ': ' : '- ') + (lines[k].length > 400 ? lines[k].slice(0, 400) + ' …' : lines[k]));
            blocks.push(shown.join('\n'));
          }
        }
        if (!total) return textResult('Nada para «' + pattern + '» en ' + files.length + (files.length === 1 ? ' archivo' : ' archivos') + '.', { matches: 0 });
        return textResult(total + (total === 1 ? ' coincidencia' : ' coincidencias') + ' en ' + touched.size + (touched.size === 1 ? ' archivo' : ' archivos') + (total > blocks.length ? ' (se muestran las ' + blocks.length + ' primeras; afina el patrón o el path)' : '') + ':\n' + blocks.join(around ? '\n--\n' : '\n'), { matches: total });
      }
    },
    {
      name: 'delete_file',
      label: 'Borrar archivo',
      description: 'Delete a text file of this chat (library documents are deleted with delete_library).',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path of the file.' })
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => {
        const path = normalizePath(params.path);
        if (!workspace.remove(path)) throw new Error('No existe el archivo ' + path + ' en los archivos del chat.' + (/^D\d+$/i.test(path) ? ' ' + path + ' es un documento de la biblioteca: bórralo con delete_library.' : ''));
        seen.delete(path);
        return textResult('Borrado ' + path + '.', { path });
      }
    }
  ];
}
