/* ─── LaTeX: TeX Live 2026 entero dentro del navegador ────────────────
   Compila con pdfLaTeX, XeLaTeX o LuaLaTeX (más BibTeX/Biber y makeindex)
   usando BusyTeX (WebAssembly, https://github.com/TeXlyre/texlyre-busytex).
   Nada sale del dispositivo: el documento se compila aquí; solo se descargan
   el motor (~32 MB) y los paquetes de TeX Live, una vez, y se guardan en la
   Cache API del navegador.

   - Paquetes: «recommended» (201 MB: amsmath, tikz, pgf, booktabs, xcolor,
     beamer, hyperref, biblatex…) y, si un documento pide algo que no está,
     «extra» (342 MB). Cada nivel incluye al anterior; un worker solo monta uno
     (si se montan dos, sus bases de datos de archivos se pisan).
   - babel sin el .ldf de un idioma (español, por ejemplo): se repite con
     provide=*, que carga el idioma desde los .ini de babel.
   - El worker se crea desde un Blob (un Worker de otro dominio no se puede
     crear) y carga busytex_pipeline.js con importScripts.

   API: InhouseTex.compile({ files: [{ path, contents }], main, engine, onProgress })
        → { ok, pdf (Uint8Array), log, errors: [{ line, file, message }], level } */
(function () {
  const BASE = 'https://texlyre.github.io/texlyre-busytex/core/busytex/';
  const LEVELS = ['recommended', 'extra'];
  const CACHE_NAME = 'inhouse-texlive-2026';
  const IDLE_MS = 5 * 60 * 1000;
  const COMPILE_TIMEOUT_MS = 4 * 60 * 1000;
  const DRIVERS = { pdflatex: 'pdftex_bibtex8', xelatex: 'xetex_bibtex8_dvipdfmx', lualatex: 'luahbtex_bibtex8' };

  const WORKER_SOURCE = (base, cacheName) => `
const BASE = ${JSON.stringify(base)};
const CACHE_NAME = ${JSON.stringify(cacheName)};
// The engine and the TeX Live packages are big: kept in the Cache API, downloaded once.
const realFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (/\\.(data|wasm)$/.test(url) && self.caches) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return hit;
      const response = await realFetch(url, init);
      if (response.ok) { try { await cache.put(url, response.clone()); } catch (_) {} }
      return response;
    } catch (_) {}
  }
  return realFetch(input, init);
};
importScripts(BASE + 'busytex_pipeline.js');
let pipeline = null;
onmessage = async ({ data }) => {
  if (data.init) {
    try {
      const pkg = BASE + 'texlive-' + data.level + '.js';
      pipeline = new BusytexPipeline(BASE + 'busytex.js', BASE + 'busytex.wasm', [pkg], [pkg], [], (m) => postMessage({ print: String(m) }), () => postMessage({ initialized: true }), true, BusytexPipeline.ScriptLoaderWorker);
    } catch (e) { postMessage({ exception: String(e && e.stack || e) }); }
    return;
  }
  if (data.compile) {
    try {
      const r = await pipeline.compile(data.files, data.main, null, null, null, null, 'silent', data.driver, []);
      postMessage({ result: { exit: r.exit_code, pdf: r.pdf && r.pdf.length ? r.pdf : null, log: r.log, logs: (r.logs || []).map((x) => ({ cmd: x.cmd, log: x.log, stdout: x.stdout })) } }, r.pdf && r.pdf.length ? [r.pdf.buffer] : []);
    } catch (e) { postMessage({ exception: String(e && e.stack || e) }); }
  }
};`;

  let engine = null; // { worker, level, ready: Promise, idleTimer }
  let queue = Promise.resolve();

  function progressOf(text) {
    const match = /Downloading data\.\.\. \((\d+)\/(\d+)\)/.exec(text) || /\((\d+)\/(\d+)\)/.exec(text);
    if (!match) return null;
    const loaded = Number(match[1]), total = Number(match[2]);
    return total > 1000 ? { loaded, total, percent: Math.min(100, Math.round(loaded / total * 100)) } : null;
  }

  function stopEngine() {
    if (!engine) return;
    clearTimeout(engine.idleTimer);
    engine.worker.terminate();
    engine = null;
  }

  function startEngine(level, onProgress) {
    stopEngine();
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE(BASE, CACHE_NAME)], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const current = { worker, level, idleTimer: 0, listener: null };
    current.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TeX Live no terminó de cargar en 10 minutos (¿conexión lenta?).')), 10 * 60 * 1000);
      worker.onmessage = ({ data }) => {
        if (data.print) {
          const progress = progressOf(data.print);
          if (progress && typeof (current.listener || onProgress) === 'function') (current.listener || onProgress)(Object.assign({ stage: 'download', level }, progress));
          return;
        }
        if (data.initialized) { clearTimeout(timer); URL.revokeObjectURL(url); resolve(); }
        if (data.exception) { clearTimeout(timer); reject(new Error('No se pudo arrancar TeX Live: ' + data.exception.split('\n')[0])); }
      };
      worker.onerror = (event) => { event.preventDefault(); clearTimeout(timer); reject(new Error('No se pudo arrancar TeX Live: ' + (event.message || 'error del worker') + '.')); };
    });
    current.ready.catch(() => { if (engine === current) stopEngine(); });
    worker.postMessage({ init: true, level });
    engine = current;
    return current;
  }

  function runOnce(current, files, main, driver) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stopEngine(); reject(new Error('La compilación tardó más de 4 minutos y se ha parado.')); }, COMPILE_TIMEOUT_MS);
      current.worker.onmessage = ({ data }) => {
        if (data.print) return;
        clearTimeout(timer);
        if (data.result) resolve(data.result);
        else if (data.exception) reject(new Error(data.exception.split('\n')[0]));
      };
      current.worker.postMessage({ compile: true, files, main, driver });
    });
  }

  // The TeX errors a person (or the model) needs: "! message" with its line.
  function parseErrors(log) {
    const out = [];
    const lines = String(log || '').split('\n');
    let file = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const opened = line.match(/\(\.\/([^\s()]+\.(?:tex|sty|cls|bib))/g);
      if (opened) file = opened[opened.length - 1].slice(3);
      if (line.startsWith('! ')) {
        let message = line.slice(2).trim();
        let at = 0;
        for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
          const where = /^l\.(\d+)\s?(.*)$/.exec(lines[j]);
          if (where) { at = Number(where[1]); if (where[2]) message += ' — en: ' + where[2].trim(); break; }
          if (/^(Type|See the|\(babel\)|\(hyperref\))/.test(lines[j]) || !lines[j].trim()) continue;
          if (j === i + 1 && !lines[j].startsWith('l.')) message += ' ' + lines[j].trim();
        }
        if (!/^==> Fatal error occurred|^Emergency stop/.test(message) && !out.some((e) => e.message === message && e.line === at)) out.push({ file, line: at, message: message.slice(0, 300) });
      }
      const missing = /^! LaTeX Error: File `([^']+)' not found/.exec(line);
      if (missing && out.length && !out.some((e) => e.missing === missing[1])) out[out.length - 1].missing = missing[1];
    }
    return out.slice(0, 12);
  }

  function lastTexLog(result) {
    const runs = (result.logs || []).filter((entry) => /latex/.test(entry.cmd || ''));
    const last = runs[runs.length - 1];
    return (last && (last.log || last.stdout)) || result.log || '';
  }

  const BABEL = /\\usepackage\s*\[([^\]]*)\]\s*\{babel\}/;

  async function compileNow(options) {
    const files = (options.files || []).map((file) => ({ path: String(file.path).replace(/^\/+/, ''), contents: file.contents }));
    const main = String(options.main || 'main.tex').replace(/^\/+/, '');
    if (!files.some((file) => file.path === main)) throw new Error('No existe ' + main + ' entre los archivos.');
    const driver = DRIVERS[options.engine] || DRIVERS.pdflatex;
    const onProgress = options.onProgress;
    let levelIndex = Math.max(0, LEVELS.indexOf(engine ? engine.level : LEVELS[0]));
    let current = engine && engine.level === LEVELS[levelIndex] ? engine : startEngine(LEVELS[levelIndex], onProgress);
    let triedProvide = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      current.listener = onProgress;
      clearTimeout(current.idleTimer);
      if (typeof onProgress === 'function') onProgress({ stage: 'loading', level: current.level });
      await current.ready;
      if (typeof onProgress === 'function') onProgress({ stage: 'compiling', level: current.level });
      const result = await runOnce(current, files, main, driver);
      current.idleTimer = setTimeout(() => { if (engine === current) stopEngine(); }, IDLE_MS);
      const log = lastTexLog(result);
      const errors = parseErrors(log);
      if (result.pdf) return { ok: true, pdf: new Uint8Array(result.pdf), log, errors, level: current.level };
      // A package that is not in this level: the next one (it includes this one).
      if (errors.some((e) => e.missing) && levelIndex < LEVELS.length - 1) {
        levelIndex++;
        current = startEngine(LEVELS[levelIndex], onProgress);
        continue;
      }
      // babel without the language's .ldf: load the language from babel's .ini files.
      const mainFile = files.find((file) => file.path === main);
      if (!triedProvide && /Package babel Error: Unknown option/.test(log) && typeof mainFile.contents === 'string' && BABEL.test(mainFile.contents)) {
        triedProvide = true;
        mainFile.contents = mainFile.contents.replace(BABEL, (all, opts) => /provide/.test(opts) ? all : '\\usepackage[' + opts + ',provide=*]{babel}');
        continue;
      }
      return { ok: false, pdf: null, log, errors, level: current.level, babelProvide: triedProvide };
    }
    return { ok: false, pdf: null, log: '', errors: [{ line: 0, file: main, message: 'No se pudo compilar.' }], level: current.level };
  }

  function compile(options) {
    const run = queue.then(() => compileNow(options));
    queue = run.catch(() => {});
    return run;
  }

  window.InhouseTex = { compile, parseErrors, stop: stopEngine, BASE, LEVELS };
})();
