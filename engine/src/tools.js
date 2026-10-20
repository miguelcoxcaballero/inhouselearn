// Herramientas del agente: archivos del chat y JavaScript en un sandbox.
// El espacio de archivos lo pone la app (vive en el chat y se guarda con él);
// aquí solo se definen las herramientas de pi que lo usan.
import { Type } from '@earendil-works/pi-ai';

const RUN_TIMEOUT_MS = 15000;
const MAX_FILE_CHARS = 400000;
const MAX_READ_CHARS = 20000;
const MAX_OUTPUT_CHARS = 8000;

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
        for (const [path, content] of Object.entries(outcome.writes || {})) {
          const clean = normalizePath(path);
          writeChecked(clean, content);
          written.push(clean);
        }
        const sections = [];
        if (outcome.logs.length) sections.push('console:\n' + outcome.logs.join('\n'));
        if (outcome.result !== undefined) sections.push('return:\n' + outcome.result);
        if (written.length) sections.push('archivos guardados: ' + written.join(', '));
        if (outcome.error) sections.push('error:\n' + outcome.error);
        const text = clip(sections.join('\n\n') || '(sin salida)', MAX_OUTPUT_CHARS);
        return { content: [{ type: 'text', text }], details: { written }, isError: !!outcome.error };
      }
    },
    {
      name: 'write_file',
      label: 'Guardar archivo',
      description: 'Create or overwrite a text file in this chat (notes, outlines, code, CSV, HTML...). The user sees the files above the message box and can download them as a ZIP. Only create files when the user asks for one or when the content is long enough to be worth keeping.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path, e.g. "apuntes/derivadas.md".' }),
        content: Type.String({ description: 'Full file content.' })
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => {
        const path = normalizePath(params.path);
        const size = writeChecked(path, params.content);
        return textResult('Guardado ' + path + ' (' + size + ' caracteres).', { path });
      }
    },
    {
      name: 'read_file',
      label: 'Leer archivo',
      description: 'Read a text file of this chat.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path of the file.' })
      }),
      execute: async (toolCallId, params) => {
        const path = normalizePath(params.path);
        const content = workspace.read(path);
        if (content == null) throw new Error('No existe el archivo ' + path + '. Usa list_files para ver los que hay.');
        return textResult(clip(content, MAX_READ_CHARS), { path });
      }
    },
    {
      name: 'edit_file',
      label: 'Editar archivo',
      description: 'Replace one exact fragment of a file. old_text must appear exactly once; include enough surrounding text to make it unique.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path of the file.' }),
        old_text: Type.String({ description: 'Exact text to replace.' }),
        new_text: Type.String({ description: 'Replacement text.' })
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => {
        const path = normalizePath(params.path);
        const content = workspace.read(path);
        if (content == null) throw new Error('No existe el archivo ' + path + '.');
        const count = params.old_text ? content.split(params.old_text).length - 1 : 0;
        if (count !== 1) {
          throw new Error(count === 0
            ? 'No encuentro ese texto en ' + path + '. Léelo con read_file y copia el fragmento exacto.'
            : 'Ese texto aparece ' + count + ' veces en ' + path + '. Incluye más contexto para que sea único.');
        }
        writeChecked(path, content.replace(params.old_text, () => params.new_text));
        return textResult('Editado ' + path + '.', { path });
      }
    },
    {
      name: 'list_files',
      label: 'Ver archivos',
      description: 'List the files of this chat with their sizes.',
      parameters: Type.Object({}),
      execute: async () => {
        const files = workspace.list();
        return textResult(files.length
          ? files.map((file) => file.path + ' · ' + file.size + ' caracteres').join('\n')
          : 'No hay archivos en este chat.');
      }
    },
    {
      name: 'delete_file',
      label: 'Borrar archivo',
      description: 'Delete a file of this chat.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path of the file.' })
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => {
        const path = normalizePath(params.path);
        if (!workspace.remove(path)) throw new Error('No existe el archivo ' + path + '.');
        return textResult('Borrado ' + path + '.', { path });
      }
    }
  ];
}
