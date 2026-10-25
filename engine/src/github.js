// Conector de GitHub: herramientas de pi para leer y cambiar repositorios con
// la API REST de GitHub desde el navegador, con el token del usuario.
//
// Los cambios no se suben uno a uno: github_write_files y github_edit_file los
// PREPARAN (ctx.stage, que la app guarda con el chat) y las lecturas ya los
// ven; github_push los sube todos en UN commit, y github_create_pull_request
// sube lo preparado de su rama antes de abrir el PR. Toda escritura real
// (commit, PR, comentario) pasa antes por ctx.confirm(): la app enseña qué se
// va a cambiar y el usuario decide.
import { Type } from '@earendil-works/pi-ai';

const API = 'https://api.github.com';
const MAX_READ_CHARS = 40000;
const MAX_GREP_FILES = 800;
const MAX_GREP_BYTES = 30 * 1024 * 1024;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_FILE = /\.(html?|css|scss|less|m?js|cjs|jsx|tsx?|json|md|markdown|txt|ya?ml|toml|xml|svg|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|ps1|sql|gradle|properties|ini|cfg|conf|env|lock|csv|tsv|tex|vue|svelte|astro|dart|lua|r|pl|ex|exs|elm|clj|scala|graphql|gql|proto|dockerfile|makefile|gitignore|editorconfig)$/i;
const TEXT_NAME = /(^|\/)(Dockerfile|Makefile|LICENSE|README|CODEOWNERS|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.nvmrc)$/;
const MAX_LIST = 400;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
// This app's own repository, and the one that holds its permanent signing key
// (secret EJEMPLO; GitHub cannot copy a secret, so Learn is signed there).
const LEARN_REPO = 'miguelcoxcaballero/inhouselearn';
const SIGN_REPO = 'miguelcoxcaballero/youtube-calma';
// The screenshots workflow as installed in a private repository (same file).
const PRIVATE_SHOT_WORKFLOW = 'inhouse-screenshots.yml';

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

function clip(text, max) {
  const value = String(text == null ? '' : text);
  return value.length > max ? value.slice(0, max) + '\n… (' + (value.length - max) + ' caracteres más)' : value;
}

function repoOf(raw) {
  const repo = String(raw || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!REPO_RE.test(repo)) throw new Error('Repositorio no válido: "' + raw + '". Usa "propietario/nombre".');
  return repo;
}

function cleanPath(raw) {
  const path = String(raw || '').trim().replace(/^\/+/, '');
  if (!path || path.split('/').some((part) => part === '..' || part === '.')) throw new Error('Ruta no válida: "' + raw + '".');
  return path;
}

const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

function decodeBase64(b64) {
  const bytes = Uint8Array.from(atob(String(b64 || '').replace(/\s/g, '')), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Lines added and removed, by a plain line multiset (enough for a summary).
function lineStats(before, after) {
  const count = (text) => {
    const map = new Map();
    (text ? String(text).split('\n') : []).forEach((line) => map.set(line, (map.get(line) || 0) + 1));
    return map;
  };
  const a = count(before);
  const b = count(after);
  let removed = 0;
  let added = 0;
  a.forEach((n, line) => { removed += Math.max(0, n - (b.get(line) || 0)); });
  b.forEach((n, line) => { added += Math.max(0, n - (a.get(line) || 0)); });
  return { added, removed };
}

function isTextPath(path, size) {
  return (TEXT_FILE.test(path) || TEXT_NAME.test(path)) && !(size > MAX_GREP_FILE_BYTES) && !/(^|\/)(node_modules|\.git)\//.test(path) && !/\.min\.(js|css)$/.test(path);
}

// Content-addressed: a blob sha always has the same text, so this cache is safe.
const blobCache = new Map();

// Ultra code runs several agents at once, each with its own tools, against the
// same repositories. Both guards are module-level so every instance shares them:
// - a lock per repo@branch around a commit (after the user approved it), so two
//   agents never build on the same head at the same time;
// - at most MAX_FETCHES requests to GitHub in flight, so a burst of agents does
//   not trip GitHub's secondary rate limits.
const MAX_FETCHES = 4;
const MAX_COMMIT_TRIES = 3;
const branchLocks = new Map();

function withBranchLock(key, fn) {
  const previous = branchLocks.get(key) || Promise.resolve();
  const run = previous.then(fn);
  const tail = run.catch(() => {});
  branchLocks.set(key, tail);
  tail.then(() => { if (branchLocks.get(key) === tail) branchLocks.delete(key); });
  return run;
}

let activeFetches = 0;
const fetchQueue = [];
// A finished request hands its slot straight to the next one waiting, so the
// count never goes over MAX_FETCHES between a release and the next start.
async function withFetchSlot(fn) {
  if (activeFetches >= MAX_FETCHES) await new Promise((resolve) => fetchQueue.push(resolve));
  else activeFetches++;
  try {
    return await fn();
  } finally {
    const next = fetchQueue.shift();
    if (next) next(); else activeFetches--;
  }
}

// In-memory stage when the app gives none (tests, other hosts).
function memoryStage() {
  const map = new Map();
  const key = (repo, branch) => repo + '@' + branch;
  return {
    get: (repo, branch) => map.get(key(repo, branch)) || null,
    put: (entry) => { map.set(key(entry.repo, entry.branch), entry); },
    remove: (repo, branch) => { map.delete(key(repo, branch)); },
    list: () => Array.from(map.values())
  };
}

function stageCount(entry) {
  return entry ? Object.keys(entry.files || {}).length + (entry.deletes || []).length : 0;
}

// ctx: { token(): string, confirm({ title, summary, items }) → Promise<boolean>, onRepo?(repo), signal?,
//        stage?: { get(repo, branch), put(entry), remove(repo, branch), list() }, onStage?() }
// A stage entry: { repo, branch, base, files: { path: content }, deletes: [path], notes: [text] }.
export function createGithubTools(ctx) {
  const stage = ctx.stage || memoryStage();
  const changed = () => { if (ctx.onStage) ctx.onStage(); };

  async function gh(method, path, body, extraHeaders) {
    const token = ctx.token();
    if (!token) throw new Error('GitHub no está conectado: pide al usuario que lo conecte en el menú + → GitHub.');
    const { response, text } = await withFetchSlot(() => request(method, path, body, token, extraHeaders));
    if (response.status === 204) return null;
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok) {
      const message = (data && data.message) || text.slice(0, 200) || 'error';
      const hint = response.status === 401 ? ' (el token no es válido o caducó)'
        : response.status === 403 ? ' (el token no tiene permiso para esto: hace falta Contents y Pull requests de lectura y escritura en ese repositorio, Actions de lectura para ver la CI y Actions de lectura y escritura para lanzar workflows, como la publicación de la APK)'
          : response.status === 404 ? ' (no existe, o el token no tiene acceso a ese repositorio)' : '';
      const error = new Error('GitHub ' + response.status + ': ' + message + hint);
      error.status = response.status;
      error.githubMessage = message;
      throw error;
    }
    return data;
  }

  // One HTTP request (inside a fetch slot): the response and its body text.
  async function request(method, path, body, token, extraHeaders) {
    let response;
    try {
      response = await fetch(API + path, {
        method,
        // GitHub answers with Cache-Control: max-age=60. Without no-store the browser
        // returned a branch's old head right after a commit (stale reads and
        // "not a fast forward" on the next commit).
        cache: 'no-store',
        headers: Object.assign({
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }, body ? { 'Content-Type': 'application/json' } : {}, extraHeaders || {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctx.signal
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      const wrapped = new Error('No se pudo conectar con GitHub (' + (error && error.message ? error.message : 'red') + ').');
      wrapped.status = 0;
      throw wrapped;
    }
    const text = response.status === 204 ? '' : await response.text();
    return { response, text };
  }

  const repoInfo = new Map();
  async function defaultBranch(repo) {
    if (!repoInfo.has(repo)) repoInfo.set(repo, await gh('GET', '/repos/' + repo));
    return repoInfo.get(repo).default_branch;
  }

  async function branchSha(repo, branch) {
    try {
      const ref = await gh('GET', '/repos/' + repo + '/git/ref/heads/' + enc(branch));
      return ref.object.sha;
    } catch (error) {
      if (error.status === 404) return '';
      throw error;
    }
  }

  async function blobText(repo, sha) {
    if (blobCache.has(sha)) return blobCache.get(sha);
    const blob = await gh('GET', '/repos/' + repo + '/git/blobs/' + sha);
    const text = decodeBase64(blob.content);
    blobCache.set(sha, text);
    return text;
  }

  async function readRemote(repo, path, ref) {
    try {
      const data = await gh('GET', '/repos/' + repo + '/contents/' + enc(path) + (ref ? '?ref=' + encodeURIComponent(ref) : ''));
      if (Array.isArray(data)) return { dir: data };
      if (data.encoding === 'base64' && data.content) return { text: decodeBase64(data.content), sha: data.sha, size: data.size };
      if (data.sha) return { text: await blobText(repo, data.sha), sha: data.sha, size: data.size };
      return { text: '', sha: data.sha, size: data.size };
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  function used(repo) {
    if (ctx.onRepo) ctx.onRepo(repo);
    return repo;
  }

  async function ask(request) {
    const ok = await ctx.confirm(request);
    if (!ok) throw new Error('El usuario no ha aprobado este cambio en GitHub. No lo repitas sin preguntarle qué quiere cambiar.');
  }

  // The branch a ref names, if it has prepared changes.
  async function stagedFor(repo, ref) {
    const branch = ref || await defaultBranch(repo);
    return stage.get(repo, branch);
  }

  // Current text of a file as the model should see it: prepared version first.
  async function currentText(repo, branch, path, base) {
    const entry = stage.get(repo, branch);
    if (entry && entry.files && Object.prototype.hasOwnProperty.call(entry.files, path)) return { text: entry.files[path], staged: true };
    if (entry && (entry.deletes || []).includes(path)) return { deleted: true };
    const exists = await branchSha(repo, branch);
    const ref = exists ? branch : (base || (entry && entry.base) || await defaultBranch(repo));
    const file = await readRemote(repo, path, ref);
    return file ? Object.assign({ ref }, file) : { missing: true, ref };
  }

  function entryFor(repo, branch, base) {
    const entry = stage.get(repo, branch) || { repo, branch, base: '', files: {}, deletes: [], notes: [] };
    if (base && !entry.base) entry.base = base;
    return entry;
  }

  function stagedSummary(entry) {
    const paths = Object.keys(entry.files || {}).concat((entry.deletes || []).map((path) => path + ' (borrar)'));
    return paths.length + (paths.length === 1 ? ' archivo preparado' : ' archivos preparados') + ' en ' + entry.repo + '@' + entry.branch + ': ' + paths.join(', ');
  }

  const STAGED_HINT = '\nTodavía NO está en GitHub. Sigue preparando todo lo que haga falta y súbelo junto al final con github_push (un solo commit) o con github_create_pull_request.';

  // One commit with any number of files (git data API): blobs → tree → commit → ref.
  async function commitFiles(params, extraItems) {
    const repo = used(repoOf(params.repo));
    const branch = String(params.branch || '').trim();
    if (!branch) throw new Error('Falta la rama.');
    const files = (params.files || []).map((file) => ({ path: cleanPath(file.path), content: String(file.content == null ? '' : file.content) }));
    const deletes = (params.delete || []).map(cleanPath);
    if (!files.length && !deletes.length) throw new Error('No hay archivos que subir.');
    const main = await defaultBranch(repo);
    let head = await branchSha(repo, branch);
    const base = String(params.base || '').trim() || main;
    const creating = !head;
    // A new branch: the approved diff was computed on the base as it was then.
    const seenBase = creating ? await branchSha(repo, base) : null;
    const sourceRef = creating ? base : branch;
    const items = [];
    for (const file of files) {
      const old = await readRemote(repo, file.path, sourceRef);
      const stats = lineStats(old && old.text, file.content);
      items.push({ path: file.path, status: old && !old.dir ? 'modificado' : 'nuevo', added: stats.added, removed: stats.removed });
    }
    deletes.forEach((path) => items.push({ path, status: 'borrado', added: 0, removed: 0 }));
    if (!params.preapproved) {
      await ask({
        title: params.title || 'Subir a GitHub',
        summary: repo + ' · rama ' + branch + (creating ? ' (nueva, desde ' + base + ')' : '') + (branch === main ? ' · ¡es la rama principal!' : '') + '\n«' + params.message + '»' + (params.extra ? '\n' + params.extra : ''),
        items: items.concat(extraItems || []),
        kind: 'commit',
        mainBranch: branch === main
      });
    }
    // Everything after the approval runs alone on this branch (another agent
    // may be committing to it), on the head as it is now.
    const seen = head || seenBase; // the commit the approved diff was computed on
    const done = await withBranchLock(repo + '@' + branch, async () => {
      head = await branchSha(repo, branch);
      // While the user was deciding, another agent may have committed here.
      // If it touched the same files, the approved content would overwrite
      // changes nobody saw: stop instead.
      if (seen && head && head !== seen) {
        const compare = await gh('GET', '/repos/' + repo + '/compare/' + seen + '...' + head);
        const theirs = new Set();
        (compare.files || []).forEach((file) => { theirs.add(file.filename); if (file.previous_filename) theirs.add(file.previous_filename); });
        const overlap = files.map((file) => file.path).concat(deletes).filter((path) => theirs.has(path));
        if (overlap.length) throw new Error('Otro agente cambió ' + overlap.join(', ') + ' en ' + branch + ' mientras tanto; lee la versión nueva y repite el cambio.');
      }
      let created = false;
      if (!head) {
        const baseSha = await branchSha(repo, base);
        if (!baseSha) throw new Error('No existe la rama base ' + base + '.');
        try {
          await gh('POST', '/repos/' + repo + '/git/refs', { ref: 'refs/heads/' + branch, sha: baseSha });
          head = baseSha;
          created = true;
        } catch (error) {
          // Someone created it meanwhile (another agent, tab or device): commit on top of it.
          if (error.status !== 422 || !/already exists/i.test(error.githubMessage || error.message)) throw error;
          head = await branchSha(repo, branch);
          if (!head) throw error;
        }
      }
      const ours = files.map((file) => file.path).concat(deletes);
      const blobs = new Map(); // path -> blob sha, kept across tries
      for (let attempt = 1; ; attempt++) {
        const parent = await gh('GET', '/repos/' + repo + '/git/commits/' + head);
        const tree = [];
        for (const file of files) {
          if (!blobs.has(file.path)) blobs.set(file.path, (await gh('POST', '/repos/' + repo + '/git/blobs', { content: file.content, encoding: 'utf-8' })).sha);
          tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blobs.get(file.path) });
        }
        deletes.forEach((path) => tree.push({ path, mode: '100644', type: 'blob', sha: null }));
        const newTree = await gh('POST', '/repos/' + repo + '/git/trees', { base_tree: parent.tree.sha, tree });
        const made = await gh('POST', '/repos/' + repo + '/git/commits', { message: String(params.message || 'Update'), tree: newTree.sha, parents: [head] });
        try {
          await gh('PATCH', '/repos/' + repo + '/git/refs/heads/' + enc(branch), { sha: made.sha });
          return { commit: made, created };
        } catch (error) {
          // The branch moved under us (a commit from outside this lock, or a
          // stale read). Other files: redo the tree on the new head; the same
          // files: never overwrite them blindly.
          if (error.status !== 422 || !/fast.?forward/i.test(error.githubMessage || error.message) || attempt >= MAX_COMMIT_TRIES) throw error;
          const fresh = await branchSha(repo, branch);
          if (!fresh || fresh === head) throw error;
          const compare = await gh('GET', '/repos/' + repo + '/compare/' + head + '...' + fresh);
          const theirs = new Set();
          (compare.files || []).forEach((file) => { theirs.add(file.filename); if (file.previous_filename) theirs.add(file.previous_filename); });
          const overlap = ours.filter((path) => theirs.has(path));
          if (overlap.length) throw new Error('Otro agente cambió ' + overlap.join(', ') + ' en ' + branch + ' mientras tanto; lee la versión nueva y repite el cambio.');
          head = fresh;
        }
      }
    });
    const commit = done.commit;
    const createdNow = done.created;
    return {
      sha: commit.sha, repo, branch, base, creating: createdNow, items,
      text: 'Commit ' + commit.sha.slice(0, 7) + ' en ' + repo + '@' + branch + (createdNow ? ' (rama creada desde ' + base + ')' : '') + ': ' +
        items.map((item) => item.path + ' (' + item.status + ', +' + item.added + ' −' + item.removed + ')').join(', ') + '\nhttps://github.com/' + repo + '/commit/' + commit.sha
    };
  }

  // Pushes what is prepared for repo@branch in one commit; the stage is
  // cleared only when the commit is done.
  async function pushStaged(repo, branch, message, options) {
    const entry = stage.get(repo, branch);
    if (!stageCount(entry)) return null;
    const notes = (entry.notes || []).filter(Boolean);
    const result = await commitFiles({
      repo, branch, base: entry.base,
      message: String(message || '').trim() || (notes.length === 1 ? notes[0] : (notes[0] || 'Cambios') + (notes.length > 1 ? '\n\n' + notes.slice(1).map((note) => '- ' + note).join('\n') : '')),
      files: Object.keys(entry.files).map((path) => ({ path, content: entry.files[path] })),
      delete: entry.deletes || [],
      title: options && options.title, extra: options && options.extra, preapproved: options && options.preapproved
    }, options && options.extraItems);
    stage.remove(repo, branch);
    changed();
    return result;
  }

  async function grep(repo, params) {
    const ref = params.ref || await defaultBranch(repo);
    const tree = await gh('GET', '/repos/' + repo + '/git/trees/' + encodeURIComponent(ref) + '?recursive=1');
    const prefix = params.path ? cleanPath(params.path).replace(/\/$/, '') : '';
    const entry = stage.get(repo, ref);
    const deleted = new Set((entry && entry.deletes) || []);
    let files = tree.tree.filter((item) => item.type === 'blob' && !deleted.has(item.path) && isTextPath(item.path, item.size) &&
      (!prefix || item.path === prefix || item.path.startsWith(prefix + '/')));
    const stagedPaths = entry ? Object.keys(entry.files).filter((path) => !prefix || path === prefix || path.startsWith(prefix + '/')) : [];
    files = files.filter((item) => !stagedPaths.includes(item.path));
    let limited = false;
    let bytes = 0;
    files = files.filter((item) => {
      if (bytes > MAX_GREP_BYTES) { limited = true; return false; }
      bytes += item.size || 0;
      return true;
    });
    if (files.length > MAX_GREP_FILES) { files = files.slice(0, MAX_GREP_FILES); limited = true; }
    let matcher;
    const raw = String(params.pattern || params.query || '');
    if (!raw) throw new Error('Falta el texto a buscar.');
    if (params.regex) {
      try { matcher = new RegExp(raw, params.case_sensitive ? '' : 'i'); } catch (error) { throw new Error('Expresión regular no válida: ' + error.message); }
    } else {
      const needle = params.case_sensitive ? raw : raw.toLowerCase();
      matcher = { test: (line) => (params.case_sensitive ? line : line.toLowerCase()).includes(needle) };
    }
    const max = Math.max(1, Math.min(300, Number(params.max_results) || 80));
    const context = Math.max(0, Math.min(5, Number(params.context) || 0));
    const hits = [];
    let total = 0;
    let filesWithHits = 0;
    const scan = (path, text, staged) => {
      const lines = text.split('\n');
      let any = false;
      lines.forEach((line, index) => {
        if (!matcher.test(line)) return;
        total++;
        any = true;
        if (hits.length >= max) return;
        const from = Math.max(0, index - context);
        const to = Math.min(lines.length - 1, index + context);
        const block = [];
        for (let i = from; i <= to; i++) block.push(path + ':' + (i + 1) + (i === index ? ': ' : '- ') + lines[i].slice(0, 240));
        hits.push((staged ? '[preparado] ' : '') + block.join('\n'));
      });
      if (any) filesWithHits++;
    };
    stagedPaths.forEach((path) => scan(path, entry.files[path], true));
    for (let i = 0; i < files.length; i += 8) {
      const batch = files.slice(i, i + 8);
      const texts = await Promise.all(batch.map((item) => blobText(repo, item.sha).catch(() => '')));
      batch.forEach((item, k) => scan(item.path, texts[k], false));
    }
    return { ref, hits, total, filesWithHits, scanned: files.length + stagedPaths.length, limited, truncated: tree.truncated };
  }

  function grepText(repo, raw, result) {
    if (!result.hits.length) return 'Sin coincidencias para «' + raw + '» en ' + repo + '@' + result.ref + ' (' + result.scanned + ' archivos de texto revisados).';
    return result.total + ' coincidencias en ' + result.filesWithHits + ' archivos de ' + repo + '@' + result.ref + (result.total > result.hits.length ? ' (mostrando ' + result.hits.length + '; afina con path o un patrón más concreto)' : '') +
      (result.limited || result.truncated ? ' · búsqueda limitada a ' + result.scanned + ' archivos; usa path para acotar' : '') + '\n' + result.hits.join(result.hits.some((hit) => hit.includes('\n')) ? '\n--\n' : '\n');
  }

  const repoParam = Type.String({ description: 'Repository as "owner/name".' });

  const sleep = (ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (ctx.signal) ctx.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('Detenido.'), { name: 'AbortError' })); }, { once: true });
  });

  // The newest run of a workflow for a commit (any event).
  async function latestRun(repo, workflow, sha) {
    const data = await gh('GET', '/repos/' + repo + '/actions/workflows/' + workflow + '/runs?per_page=5&head_sha=' + sha);
    return (data.workflow_runs || [])[0] || null;
  }

  // Starts a workflow_dispatch run and finds it (GitHub does not return its id).
  async function dispatch(repo, workflow, ref, inputs, headSha) {
    const since = Date.now() - 5000;
    await gh('POST', '/repos/' + repo + '/actions/workflows/' + workflow + '/dispatches', { ref, inputs });
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const data = await gh('GET', '/repos/' + repo + '/actions/workflows/' + workflow + '/runs?per_page=5&event=workflow_dispatch');
      const run = (data.workflow_runs || []).find((item) => Date.parse(item.created_at) >= since && (!headSha || item.head_sha === headSha));
      if (run) return run;
    }
    throw new Error('Se lanzó ' + workflow + ' en ' + repo + ' pero no aparece su ejecución: https://github.com/' + repo + '/actions');
  }

  // Waits for a run to end, telling what it is doing; a failure stops
  // everything with the failing steps and their error annotations.
  async function waitRun(repo, run, what, step) {
    const started = Date.now();
    let current = run;
    let shown = '';
    while (current.status !== 'completed') {
      if (Date.now() - started > 40 * 60 * 1000) throw new Error('Lleva más de 40 minutos ' + what + ': ' + current.html_url);
      await sleep(10000);
      current = await gh('GET', '/repos/' + repo + '/actions/runs/' + current.id);
      const jobs = await gh('GET', '/repos/' + repo + '/actions/runs/' + current.id + '/jobs').catch(() => ({ jobs: [] }));
      const active = (jobs.jobs || []).find((job) => job.status === 'in_progress');
      const activeStep = active && (active.steps || []).find((item) => item.status === 'in_progress');
      const now = active ? what[0].toUpperCase() + what.slice(1) + ': ' + active.name + (activeStep ? ' · ' + activeStep.name : '') : '';
      if (now && now !== shown) { shown = now; step(now); }
    }
    if (current.conclusion !== 'success') {
      const jobs = await gh('GET', '/repos/' + repo + '/actions/runs/' + current.id + '/jobs').catch(() => ({ jobs: [] }));
      const notes = [];
      for (const job of jobs.jobs || []) {
        if (job.conclusion === 'success' || job.conclusion === 'skipped') continue;
        notes.push(job.name + ': ' + job.conclusion + (job.steps || []).filter((item) => item.conclusion === 'failure').map((item) => ' · falla «' + item.name + '»').join(''));
        const annotations = await gh('GET', '/repos/' + repo + '/check-runs/' + job.id + '/annotations').catch(() => []);
        (annotations || []).filter((note) => note.annotation_level === 'failure').slice(0, 12).forEach((note) => notes.push('  ' + String(note.message || '').split('\n').slice(0, 3).join(' ')));
      }
      throw new Error('Ha fallado ' + what + ' (' + current.conclusion + '): ' + current.html_url + (notes.length ? '\n' + notes.join('\n') : '') + '\nNo se ha hecho nada después de este paso.');
    }
    step('Terminado bien: ' + what + '.');
    return current;
  }

  return [
    {
      name: 'github_list_repos',
      label: 'GitHub: repositorios',
      description: 'List the GitHub repositories the user\'s token can access (most recently pushed first). Optional filter by name.',
      parameters: Type.Object({ query: Type.Optional(Type.String({ description: 'Part of the name to filter by.' })) }),
      execute: async (id, params) => {
        const repos = await gh('GET', '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
        const query = String(params.query || '').toLowerCase();
        const list = repos.filter((repo) => !query || repo.full_name.toLowerCase().includes(query));
        return textResult(list.length ? list.map((repo) => repo.full_name + (repo.private ? ' · privado' : '') + ' · rama ' + repo.default_branch + (repo.description ? ' · ' + repo.description.slice(0, 80) : '')).join('\n') : 'Ningún repositorio coincide.');
      }
    },
    {
      name: 'github_list_files',
      label: 'GitHub: archivos',
      description: 'List the files of a repository (whole tree, with sizes), optionally only under a folder. Use it to find where things are.',
      parameters: Type.Object({
        repo: repoParam,
        ref: Type.Optional(Type.String({ description: 'Branch, tag or commit (default branch if omitted).' })),
        path: Type.Optional(Type.String({ description: 'Only files under this folder.' }))
      }),
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const ref = params.ref || await defaultBranch(repo);
        const tree = await gh('GET', '/repos/' + repo + '/git/trees/' + encodeURIComponent(ref) + '?recursive=1');
        const prefix = params.path ? cleanPath(params.path).replace(/\/?$/, '/') : '';
        const files = tree.tree.filter((item) => item.type === 'blob' && (!prefix || item.path.startsWith(prefix)));
        const shown = files.slice(0, MAX_LIST).map((item) => item.path + ' (' + (item.size > 2048 ? Math.round(item.size / 1024) + ' KB' : item.size + ' B') + ')');
        const entry = stage.get(repo, ref);
        return textResult(repo + '@' + ref + ' · ' + files.length + ' archivos' + (tree.truncated ? ' (árbol truncado por GitHub)' : '') + '\n' + shown.join('\n') +
          (files.length > MAX_LIST ? '\n… (' + (files.length - MAX_LIST) + ' más: filtra con path)' : '') + (stageCount(entry) ? '\n\n' + stagedSummary(entry) + ' (sin subir).' : ''));
      }
    },
    {
      name: 'github_read_file',
      label: 'GitHub: leer archivo',
      description: 'Read a file of a repository (or list a folder). Lines are numbered. Big files: read the range you need with from_line/to_line (find it first with github_grep); there is no other limit. On a branch with prepared changes it shows the prepared version.',
      parameters: Type.Object({
        repo: repoParam,
        path: Type.String({ description: 'File path in the repository.' }),
        ref: Type.Optional(Type.String({ description: 'Branch, tag or commit (default branch if omitted).' })),
        from_line: Type.Optional(Type.Number({ description: 'First line (1-based).' })),
        to_line: Type.Optional(Type.Number({ description: 'Last line.' }))
      }),
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const path = cleanPath(params.path);
        const entry = await stagedFor(repo, params.ref);
        let text = null;
        let note = '';
        if (entry && Object.prototype.hasOwnProperty.call(entry.files, path)) {
          text = entry.files[path];
          note = ' · versión preparada (sin subir)';
        } else if (entry && entry.deletes.includes(path)) {
          throw new Error(path + ' está preparado para borrarse en ' + repo + '@' + entry.branch + '.');
        } else {
          const file = await readRemote(repo, path, params.ref);
          if (!file) throw new Error('No existe ' + path + ' en ' + repo + (params.ref ? '@' + params.ref : '') + '. Búscalo con github_grep o github_list_files.');
          if (file.dir) return textResult(path + '/\n' + file.dir.map((item) => item.name + (item.type === 'dir' ? '/' : '')).join('\n'));
          text = file.text;
          const other = stage.list().find((item) => item.repo === repo && Object.prototype.hasOwnProperty.call(item.files, path) && item.branch !== (entry && entry.branch));
          if (other) note = ' · ojo: hay una versión preparada sin subir en la rama ' + other.branch + ' (léela con ref="' + other.branch + '")';
        }
        const lines = text.split('\n');
        const from = Math.max(1, Math.min(lines.length, Number(params.from_line) || 1));
        const to = Math.max(from, Math.min(lines.length, Number(params.to_line) || lines.length));
        let body = '';
        let last = from - 1;
        for (let n = from; n <= to; n++) {
          const line = String(n).padStart(5) + '  ' + lines[n - 1] + '\n';
          if (body.length + line.length > MAX_READ_CHARS && n > from) break;
          body += line;
          last = n;
        }
        const more = last < to ? '\n[Cortado en la línea ' + last + ' por tamaño. Sigue con from_line=' + (last + 1) + (to < lines.length ? ' y to_line=' + to : '') + '.]' : '';
        return textResult(repo + '/' + path + ' · ' + lines.length + ' líneas' + (from > 1 || last < lines.length ? ' · ' + from + '–' + last : '') + note + '\n' + body.replace(/\n$/, '') + more, { repo, path });
      }
    },
    {
      name: 'github_grep',
      label: 'GitHub: buscar en los archivos',
      description: 'Search the text of every file of a repository at a branch (like grep): returns path:line: text for each match, including prepared changes. Exact and reliable; use it to find where something is defined or used before reading. Plain text by default (case-insensitive); regex=true for a JavaScript regular expression.',
      parameters: Type.Object({
        repo: repoParam,
        pattern: Type.String({ description: 'Text (or regex) to find, e.g. "function updateSendUi".' }),
        ref: Type.Optional(Type.String({ description: 'Branch, tag or commit (default branch if omitted).' })),
        path: Type.Optional(Type.String({ description: 'Only this file or folder.' })),
        regex: Type.Optional(Type.Boolean()),
        case_sensitive: Type.Optional(Type.Boolean()),
        context: Type.Optional(Type.Number({ description: 'Lines of context around each match (0–5).' })),
        max_results: Type.Optional(Type.Number({ description: 'Max matches shown (default 80).' }))
      }),
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        return textResult(grepText(repo, params.pattern, await grep(repo, params)));
      }
    },
    {
      name: 'github_search_code',
      label: 'GitHub: buscar código',
      description: 'Search code in a repository with GitHub\'s index (default branch, words and identifiers). If the index fails it searches the files directly, like github_grep.',
      parameters: Type.Object({ repo: repoParam, query: Type.String({ description: 'Words or identifiers to find.' }) }),
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        try {
          const data = await gh('GET', '/search/code?per_page=20&q=' + encodeURIComponent(params.query + ' repo:' + repo), null, { Accept: 'application/vnd.github.text-match+json' });
          if (data.items.length) {
            return textResult(data.items.map((item) => item.path + (item.text_matches || []).slice(0, 2).map((match) => '\n   ' + match.fragment.replace(/\s+/g, ' ').slice(0, 200)).join('')).join('\n') +
              '\n(Índice de GitHub: para líneas exactas usa github_grep.)');
          }
        } catch (error) {
          if (error.name === 'AbortError') throw error;
        }
        return textResult('(Búsqueda directa en los archivos)\n' + grepText(repo, params.query, await grep(repo, { pattern: params.query })));
      }
    },
    {
      name: 'github_write_files',
      label: 'GitHub: preparar archivos',
      description: 'PREPARE whole files (create or replace) and deletions on a branch. Nothing is uploaded yet and the user is not asked: later reads and greps of that branch see the prepared version. When the whole task is done, upload everything at once with github_push (one commit) or github_create_pull_request. content must be the complete new file.',
      parameters: Type.Object({
        repo: repoParam,
        branch: Type.String({ description: 'Branch the changes are for (created from base when pushed if missing), e.g. "feat/cola-mensajes".' }),
        files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String({ description: 'Complete new file content.' }) }))),
        delete: Type.Optional(Type.Array(Type.String({ description: 'Path to delete.' }))),
        base: Type.Optional(Type.String({ description: 'Branch to start a new branch from (default branch if omitted).' })),
        note: Type.Optional(Type.String({ description: 'One line saying what this change does (goes into the commit message).' }))
      }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const branch = String(params.branch || '').trim();
        if (!branch) throw new Error('Falta la rama.');
        const files = (params.files || []).map((file) => ({ path: cleanPath(file.path), content: String(file.content == null ? '' : file.content) }));
        const deletes = (params.delete || []).map(cleanPath);
        if (!files.length && !deletes.length) throw new Error('No hay archivos que preparar.');
        const entry = entryFor(repo, branch, params.base);
        files.forEach((file) => {
          entry.files[file.path] = file.content;
          entry.deletes = entry.deletes.filter((path) => path !== file.path);
        });
        deletes.forEach((path) => {
          delete entry.files[path];
          if (!entry.deletes.includes(path)) entry.deletes.push(path);
        });
        if (params.note) entry.notes.push(String(params.note).trim());
        stage.put(entry);
        changed();
        return textResult('Preparado: ' + files.map((file) => file.path).concat(deletes.map((path) => path + ' (borrar)')).join(', ') + '.\n' + stagedSummary(entry) + '.' + STAGED_HINT, { repo, branch, staged: stageCount(entry) });
      }
    },
    {
      name: 'github_edit_file',
      label: 'GitHub: preparar edición',
      description: 'PREPARE an exact replacement in a file (old_text must appear exactly once in the current version: the prepared one if there is, else the branch, else base). Nothing is uploaded yet and the user is not asked; make all the edits you need, then upload them together with github_push or github_create_pull_request.',
      parameters: Type.Object({
        repo: repoParam,
        branch: Type.String({ description: 'Branch the change is for (created from base when pushed if missing).' }),
        path: Type.String(),
        old_text: Type.String({ description: 'Exact text to replace.' }),
        new_text: Type.String({ description: 'Replacement.' }),
        base: Type.Optional(Type.String()),
        note: Type.Optional(Type.String({ description: 'One line saying what this change does (goes into the commit message).' }))
      }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const branch = String(params.branch || '').trim();
        if (!branch) throw new Error('Falta la rama.');
        const path = cleanPath(params.path);
        const current = await currentText(repo, branch, path, params.base);
        if (current.deleted) throw new Error(path + ' está preparado para borrarse.');
        if (current.missing || current.dir) throw new Error('No existe ' + path + ' en ' + repo + '@' + current.ref + '. Para crearlo usa github_write_files.');
        const count = params.old_text ? current.text.split(params.old_text).length - 1 : 0;
        if (count !== 1) throw new Error(count ? 'Ese texto aparece ' + count + ' veces en ' + path + ': incluye más contexto para que sea único.' : 'No encuentro ese texto en ' + path + (current.staged ? ' (versión preparada)' : '@' + current.ref) + '. Búscalo con github_grep o léelo con github_read_file y copia el fragmento exacto, con sus espacios.');
        const entry = entryFor(repo, branch, params.base);
        entry.files[path] = current.text.replace(params.old_text, () => params.new_text);
        if (params.note) entry.notes.push(String(params.note).trim());
        stage.put(entry);
        changed();
        const stats = lineStats(params.old_text, params.new_text);
        return textResult('Preparado en ' + path + ' (+' + stats.added + ' −' + stats.removed + ' líneas).\n' + stagedSummary(entry) + '.' + STAGED_HINT, { repo, branch, path, staged: stageCount(entry) });
      }
    },
    {
      name: 'github_discard',
      label: 'GitHub: descartar preparado',
      description: 'Drop prepared (not uploaded) changes of a branch: some paths, or all of them.',
      parameters: Type.Object({ repo: repoParam, branch: Type.String(), paths: Type.Optional(Type.Array(Type.String())) }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const entry = stage.get(repo, params.branch);
        if (!stageCount(entry)) return textResult('No había nada preparado en ' + repo + '@' + params.branch + '.');
        if (!params.paths || !params.paths.length) {
          stage.remove(repo, params.branch);
        } else {
          params.paths.map(cleanPath).forEach((path) => { delete entry.files[path]; entry.deletes = entry.deletes.filter((item) => item !== path); });
          if (stageCount(entry)) stage.put(entry); else stage.remove(repo, params.branch);
        }
        changed();
        const left = stage.get(repo, params.branch);
        return textResult(left ? 'Descartado. Queda: ' + stagedSummary(left) + '.' : 'Descartados los cambios preparados de ' + repo + '@' + params.branch + '.');
      }
    },
    {
      name: 'github_push',
      label: 'GitHub: subir',
      description: 'Upload everything prepared for a branch in ONE commit (the user approves it once, seeing every file). Call it once, when the work is complete — not after each edit. On the default branch only if the user asked for it; otherwise prefer a new branch and github_create_pull_request (which pushes for you).',
      parameters: Type.Object({
        repo: repoParam,
        branch: Type.String(),
        message: Type.String({ description: 'Commit message: a short title line, then optional details.' })
      }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const result = await pushStaged(repo, String(params.branch || '').trim(), params.message).catch((error) => {
          if (/no ha aprobado/.test(error.message)) throw new Error('El usuario no ha aprobado la subida. Los cambios siguen preparados (sin subir); pregúntale qué quiere cambiar.');
          throw error;
        });
        if (!result) throw new Error('No hay nada preparado en ' + repo + '@' + params.branch + '. Prepara cambios con github_edit_file o github_write_files.');
        return textResult(result.text, { repo, branch: result.branch, sha: result.sha });
      }
    },
    {
      name: 'github_create_pull_request',
      label: 'GitHub: abrir PR',
      description: 'Open a pull request from a branch. If that branch has prepared changes they are uploaded first in one commit, and the user approves both together.',
      parameters: Type.Object({
        repo: repoParam,
        head: Type.String({ description: 'Branch with the changes.' }),
        base: Type.Optional(Type.String({ description: 'Target branch (default branch if omitted).' })),
        title: Type.String(),
        body: Type.Optional(Type.String({ description: 'Description in Markdown.' })),
        commit_message: Type.Optional(Type.String({ description: 'Message for the commit of the prepared changes (the PR title if omitted).' })),
        draft: Type.Optional(Type.Boolean())
      }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const base = params.base || await defaultBranch(repo);
        const prLine = params.head + ' → ' + base + ' · «' + params.title + '»' + (params.draft ? ' (borrador)' : '');
        let pushed = null;
        if (stageCount(stage.get(repo, params.head))) {
          pushed = await pushStaged(repo, params.head, params.commit_message || params.title, { title: 'Subir y abrir pull request', extra: 'Pull request: ' + prLine });
        } else {
          const compare = await gh('GET', '/repos/' + repo + '/compare/' + encodeURIComponent(base) + '...' + encodeURIComponent(params.head));
          await ask({
            title: 'Abrir pull request',
            summary: repo + ' · ' + prLine,
            items: (compare.files || []).slice(0, 30).map((file) => ({ path: file.filename, status: file.status, added: file.additions, removed: file.deletions })),
            kind: 'pr'
          });
        }
        const pr = await gh('POST', '/repos/' + repo + '/pulls', { title: params.title, head: params.head, base, body: params.body || '', draft: !!params.draft });
        return textResult((pushed ? pushed.text + '\n' : '') + 'PR #' + pr.number + ' abierta: ' + pr.html_url, { repo, number: pr.number });
      }
    },
    {
      name: 'github_ci_status',
      label: 'GitHub: estado de la CI',
      description: 'Results of the GitHub Actions runs (build, tests) of a branch or commit: each workflow, its jobs and, when something failed, the failing steps and error messages. Use it after pushing to check the change works.',
      parameters: Type.Object({
        repo: repoParam,
        ref: Type.Optional(Type.String({ description: 'Branch or commit sha (default branch if omitted).' }))
      }),
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const ref = params.ref || await defaultBranch(repo);
        const query = /^[0-9a-f]{7,40}$/i.test(ref) ? 'head_sha=' + ref : 'branch=' + encodeURIComponent(ref);
        const data = await gh('GET', '/repos/' + repo + '/actions/runs?per_page=20&' + query);
        const latest = new Map();
        (data.workflow_runs || []).forEach((run) => { if (!latest.has(run.workflow_id)) latest.set(run.workflow_id, run); });
        if (!latest.size) return textResult('No hay ejecuciones de GitHub Actions para ' + repo + '@' + ref + '.');
        const lines = [];
        for (const run of latest.values()) {
          lines.push('• ' + run.name + ' · ' + (run.conclusion || run.status) + ' · commit ' + run.head_sha.slice(0, 7) + ' · ' + run.html_url);
          if (run.conclusion && run.conclusion !== 'success' && run.conclusion !== 'skipped') {
            const jobs = await gh('GET', '/repos/' + repo + '/actions/runs/' + run.id + '/jobs').catch(() => ({ jobs: [] }));
            for (const job of jobs.jobs || []) {
              if (job.conclusion === 'success' || job.conclusion === 'skipped') continue;
              lines.push('  – ' + job.name + ': ' + (job.conclusion || job.status) + ((job.steps || []).filter((step) => step.conclusion === 'failure').map((step) => ' · falla «' + step.name + '»').join('')));
              const annotations = await gh('GET', '/repos/' + repo + '/check-runs/' + job.id + '/annotations').catch(() => []);
              (annotations || []).slice(0, 25).forEach((note) => lines.push('    ' + (note.path && note.path !== '.github' ? note.path + ':' + note.start_line + ' ' : '') + String(note.message || '').split('\n').slice(0, 3).join(' ')));
            }
          }
        }
        return textResult(clip(lines.join('\n'), MAX_READ_CHARS));
      }
    },
    {
      name: 'github_release_android',
      label: 'GitHub: publicar la APK de Inhouse Learn',
      description: 'Publish a new Android APK of THIS app (Inhouse Learn, ' + LEARN_REPO + ') on update channel A, so installed apps offer it in their updater. It runs the whole release on GitHub: checks that main raises versionCode above channel A and that its "Android app" build is green (starting one if there is none), has the permanent key sign that exact commit in ' + SIGN_REPO + ' ("Sign Inhouse Learn"), runs the "Android app" publish (verify, emulator, release android-v<version>, updates/A.json) and checks the result. Before calling it, push to main the change with versionCode and versionName raised in android/app/build.gradle.kts. Web-only changes need no APK: they are live as soon as they reach main. The user always confirms. Never channel B. Takes about 10 minutes.',
      parameters: Type.Object({
        changelog: Type.String({ description: 'Tiny English changelog shown by the updater: 2-10 words, at most 120 characters, e.g. "AMOLED night mode and theme-aware system bars."' })
      }),
      executionMode: 'sequential',
      execute: async (id, params, signal, onUpdate) => {
        const changelog = String(params.changelog || '').trim();
        const words = changelog.split(/\s+/).filter(Boolean).length;
        if (!changelog || changelog.length > 120 || words < 2 || words > 10) throw new Error('El changelog debe tener 2–10 palabras y como mucho 120 caracteres, en inglés.');
        const log = [];
        const step = (text) => {
          log.push(text);
          if (typeof onUpdate === 'function') onUpdate(textResult(log.join('\n'), { phase: text }));
        };
        used(LEARN_REPO);
        // 1. What main holds, and the channel it has to beat.
        const sha = await branchSha(LEARN_REPO, 'main');
        if (!sha) throw new Error('No se encontró la rama main de ' + LEARN_REPO + '.');
        const gradle = ((await readRemote(LEARN_REPO, 'android/app/build.gradle.kts', sha)) || {}).text || '';
        const code = Number((gradle.match(/versionCode\s*=\s*(\d+)/) || [])[1]);
        const version = (gradle.match(/versionName\s*=\s*"([^"]+)"/) || [])[1];
        if (!code || !version) throw new Error('No se pudo leer versionCode/versionName de android/app/build.gradle.kts en main.');
        let published = 0;
        try { published = Number(JSON.parse(((await readRemote(LEARN_REPO, 'updates/A.json', sha)) || {}).text).latest.versionCode) || 0; } catch (_) {}
        if (code <= published) throw new Error('main tiene versionCode ' + code + ' (' + version + ') y el canal A ya tiene ' + published + '. Sube versionCode y versionName en android/app/build.gradle.kts (nunca se reutiliza ni se baja), súbelo a main y vuelve a llamar a esta herramienta.');
        const tag = 'android-v' + version;
        const existing = await gh('GET', '/repos/' + LEARN_REPO + '/releases/tags/' + encodeURIComponent(tag)).catch((error) => { if (error.status === 404) return null; throw error; });
        if (existing) throw new Error('La release ' + tag + ' ya existe y una release publicada no se reemplaza: sube la versión.');
        step('main ' + sha.slice(0, 7) + ' · versión ' + version + ' (versionCode ' + code + '; el canal A tiene ' + published + ')');
        // 2. The user decides, whatever the approval mode of the chat.
        await ask({
          title: 'Publicar la APK ' + version + ' en el canal A',
          summary: LEARN_REPO + '@main ' + sha.slice(0, 7) + ' · versionCode ' + code + '\n«' + changelog + '»\nSe firma con la clave permanente y las apps instaladas la verán en su actualizador. No se puede deshacer.',
          items: [],
          kind: 'release',
          always: true,
          mainBranch: true,
          confirmText: 'Publicar'
        });
        // 3. A green build of this exact commit.
        let build = await latestRun(LEARN_REPO, 'android.yml', sha);
        if (!build || (build.status === 'completed' && build.conclusion !== 'success')) {
          if (build) step('El último build de este commit falló: lo repito.');
          build = await dispatch(LEARN_REPO, 'android.yml', 'main', { publish: 'false' }, sha);
        }
        step('Build de Android: ' + build.html_url);
        await waitRun(LEARN_REPO, build, 'el build de Android', step);
        // 4. The permanent key signs that commit in the repository that holds it.
        let sign = await dispatch(SIGN_REPO, 'sign-inhouse-learn.yml', 'main', { ref: sha }, null);
        step('Firmando en ' + SIGN_REPO + ': ' + sign.html_url);
        sign = await waitRun(SIGN_REPO, sign, 'la firma', step);
        const staged = 'learn-signed-' + version + '-' + sha.slice(0, 7);
        await gh('GET', '/repos/' + SIGN_REPO + '/releases/tags/' + encodeURIComponent(staged)).catch(() => {
          throw new Error('La firma terminó pero no aparece la prerelease ' + staged + ' en ' + SIGN_REPO + '. No se ha publicado nada.');
        });
        if (await branchSha(LEARN_REPO, 'main') !== sha) throw new Error('main ha cambiado mientras se firmaba: la firma solo vale para ' + sha.slice(0, 7) + '. No se ha publicado nada; vuelve a llamar a esta herramienta para firmar el commit nuevo.');
        // 5. Publish on channel A.
        let publish = await dispatch(LEARN_REPO, 'android.yml', 'main', { publish: 'true', changelog }, sha);
        step('Publicando en el canal A: ' + publish.html_url);
        publish = await waitRun(LEARN_REPO, publish, 'la publicación', step);
        // 6. Check what the installed apps will read.
        let latest = null;
        try { latest = JSON.parse(((await readRemote(LEARN_REPO, 'updates/A.json', 'main')) || {}).text).latest; } catch (_) {}
        if (!latest || Number(latest.versionCode) !== code) throw new Error('La publicación terminó pero updates/A.json no tiene versionCode ' + code + '. Revisa ' + publish.html_url);
        const release = await gh('GET', '/repos/' + LEARN_REPO + '/releases/tags/' + encodeURIComponent(tag));
        return textResult([
          'APK ' + version + ' (versionCode ' + code + ') publicada en el canal A.',
          'Release: ' + release.html_url,
          'APK: ' + latest.apkUrl,
          'SHA-256: ' + latest.apkSha256,
          'Commit: ' + sha,
          'Firma: ' + sign.html_url,
          'Publicación: ' + publish.html_url,
          'Las apps instaladas la ofrecerán en su actualizador (o en Ajustes → Actualizaciones).'
        ].join('\n'), { version, versionCode: code, sha, release: release.html_url });
      }
    },
    {
      name: 'github_screenshot',
      label: 'GitHub: capturas reales',
      description: 'Take REAL screenshots of any web project: a branch or commit of any GitHub repository the token can read (public or private), or any public URL. GitHub Actions opens the page in Chromium (phone, tablet or desktop; light or dark colour scheme), runs optional steps (click, fill, press, wait, scroll, eval) and photographs the screen or one element. A static site is served from the repository root (or `serve`); a project that needs building takes `setup` (e.g. "npm ci && npm run build") and `serve` (e.g. "dist"), or `start` for its own server on port 8765. For this app (' + LEARN_REPO + ', the default) it can also replay a conversation through the real renderer. Use it after you change a project (push first, then photograph that branch) or whenever the user wants to see how something looks; then show every picture in the chat with an image block (or one gallery block). Takes about 1-3 minutes. A private repository gets a small workflow file installed once (the user approves it) so its code and pictures stay private.',
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: 'Repository "owner/name" to photograph (default ' + LEARN_REPO + ', this app).' })),
        ref: Type.Optional(Type.String({ description: 'Branch or commit (default the repository\'s default branch). Push your changes there first.' })),
        url: Type.Optional(Type.String({ description: 'A public https address to photograph instead of a repository (a deployed site, GitHub Pages…).' })),
        setup: Type.Optional(Type.String({ description: 'Shell command run in the checkout before serving, e.g. "npm ci && npm run build".' })),
        serve: Type.Optional(Type.String({ description: 'Folder of the checkout to serve, e.g. "dist" (default the root).' })),
        start: Type.Optional(Type.String({ description: 'Command that starts the project\'s own server on port 8765, e.g. "npm ci && npx vite --port 8765 --host 127.0.0.1" (instead of serving files).' })),
        shots: Type.Array(Type.Object({
          name: Type.String({ description: 'Short name, e.g. "Menú +, oscuro".' }),
          path: Type.Optional(Type.String({ description: 'Page to open, relative to the site, e.g. "about.html" or "#/settings" (default the home page).' })),
          device: Type.Optional(Type.String({ description: '"phone" (default), "tablet" or "desktop".' })),
          theme: Type.Optional(Type.String({ description: '"light" (default) or "dark" (prefers-color-scheme; in this app, its AMOLED theme).' })),
          messages: Type.Optional(Type.Array(Type.Object({
            user: Type.String(),
            assistant: Type.String({ description: 'The answer to draw, exactly as the model would write it.' })
          }), { description: 'Only for this app: a conversation to show (up to 6 turns).' })),
          steps: Type.Optional(Type.Array(Type.Object({
            click: Type.Optional(Type.String({ description: 'CSS selector to click, e.g. "#plus-btn".' })),
            fill: Type.Optional(Type.Array(Type.String(), { description: '[selector, text]' })),
            press: Type.Optional(Type.String({ description: 'Key, e.g. "Escape".' })),
            scroll: Type.Optional(Type.String({ description: 'CSS selector to scroll into view.' })),
            eval: Type.Optional(Type.String({ description: 'JavaScript run in the page.' })),
            wait: Type.Optional(Type.Number({ description: 'Milliseconds to wait after the step (max 5000).' }))
          }), { description: 'What to do before the picture (open a menu, type…), up to 20.' })),
          selector: Type.Optional(Type.String({ description: 'Photograph only this element.' })),
          fullPage: Type.Optional(Type.Boolean())
        }), { description: '1 to 6 pictures.', minItems: 1, maxItems: 6 })
      }),
      executionMode: 'sequential',
      execute: async (id, params, signal, onUpdate) => {
        const shots = (params.shots || []).slice(0, 6);
        if (!shots.length) throw new Error('Pide al menos una captura.');
        const log = [];
        const step = (text) => {
          log.push(text);
          if (typeof onUpdate === 'function') onUpdate(textResult(log.join('\n'), { phase: text }));
        };
        const url = String(params.url || '').trim();
        if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new Error('url debe ser una dirección http(s) pública.');
        if (url && /^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|\[::1\])/i.test(url)) throw new Error('Esa dirección solo existe en tu ordenador: GitHub Actions no puede abrirla. Usa el repositorio (repo + ref) o una dirección pública.');
        const repo = url ? '' : used(repoOf(params.repo || LEARN_REPO));
        const ref = String(params.ref || '').trim();
        if (ref && !/^[A-Za-z0-9._/-]{1,120}$/.test(ref)) throw new Error('ref debe ser una rama o un commit.');
        const serve = String(params.serve || '').trim().replace(/^\.?\/+|\/+$/g, '');
        if (serve && (!/^[A-Za-z0-9._/-]{1,120}$/.test(serve) || serve.includes('..'))) throw new Error('serve debe ser una carpeta del repositorio, como "dist".');
        const setup = String(params.setup || '').trim().slice(0, 1000);
        const start = String(params.start || '').trim().slice(0, 1000);
        // Public projects and URLs run in this app's repository; a private one
        // runs in itself, so its code and its pictures never become public.
        const info = repo ? await gh('GET', '/repos/' + repo) : null;
        const own = !info || !info.private || repo.toLowerCase() === LEARN_REPO;
        const runner = own ? LEARN_REPO : repo;
        const workflow = own ? 'screenshots.yml' : PRIVATE_SHOT_WORKFLOW;
        const where = url || repo + '@' + (ref || (info && info.default_branch) || 'main');
        const label = (shot) => '· ' + shot.name + (shot.path ? ' — ' + shot.path : '') + ' (' + (shot.device || 'phone') + ', ' + (shot.theme === 'dark' ? 'oscuro' : 'claro') + ')';
        if (!own) {
          const main = info.default_branch;
          const wanted = await readRemote(LEARN_REPO, '.github/workflows/screenshots.yml', 'main');
          if (!wanted) throw new Error('No encuentro el workflow de capturas en ' + LEARN_REPO + '.');
          const current = await readRemote(repo, '.github/workflows/' + PRIVATE_SHOT_WORKFLOW, main);
          if (!current || current.text !== wanted.text) {
            step('Instalando el workflow de capturas en ' + repo + '…');
            try {
              await commitFiles({
                repo, branch: main,
                message: (current ? 'Update' : 'Add') + ' the Inhouse screenshots workflow\n\nReal screenshots for the Inhouse Learn chat, taken and kept inside this private repository (branch screenshots).',
                files: [{ path: '.github/workflows/' + PRIVATE_SHOT_WORKFLOW, content: wanted.text }],
                title: current ? 'Actualizar las capturas en ' + repo : 'Instalar las capturas en ' + repo,
                extra: repo + ' es privado: para que su código y sus fotos no salgan de él, las capturas se hacen dentro (un workflow, una vez). Las fotos se guardan en su rama screenshots.\n' + shots.map(label).join('\n')
              });
            } catch (error) {
              if (error.status === 403 || error.status === 404) throw new Error('No he podido instalar el workflow de capturas en ' + repo + ' (' + error.message + '). El token necesita en ese repositorio Contents y Workflows de lectura y escritura, y Actions de lectura y escritura.');
              throw error;
            }
            await sleep(4000);
          }
        }
        await ask({
          title: 'Hacer capturas',
          summary: where + (setup ? '\nAntes: ' + setup : '') + (start ? '\nServidor: ' + start : '') + (serve ? '\nCarpeta: ' + serve : '') + '\n' + shots.map(label).join('\n') + '\nGitHub Actions abre esa página en Chromium y guarda las fotos en la rama screenshots de ' + runner + '.',
          items: [],
          kind: 'screenshot',
          confirmText: 'Hacer capturas'
        });
        // Folders sort by date on the screenshots branch (old ones are pruned there).
        const now = new Date();
        const folder = 'shot-' + now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + '-' + Math.random().toString(36).slice(2, 6);
        const inputs = { ref, id: folder, shots: JSON.stringify(shots) };
        if (url) inputs.url = url;
        if (repo && own && repo.toLowerCase() !== LEARN_REPO) inputs.repo = repo;
        if (setup) inputs.setup = setup;
        if (serve) inputs.serve = serve;
        if (start) inputs.start = start;
        let run = null;
        // A workflow file that was just added takes a few seconds to be dispatchable.
        for (let attempt = 0; !run; attempt++) {
          try { run = await dispatch(runner, workflow, own ? 'main' : info.default_branch, inputs, null); } catch (error) {
            if (own || attempt >= 5 || (error.status !== 404 && error.status !== 422)) throw error;
            await sleep(5000);
          }
        }
        step('Haciendo las capturas: ' + run.html_url);
        run = await waitRun(runner, run, 'el trabajo de capturas', step);
        const manifestFile = await readRemote(runner, folder + '/manifest.json', 'screenshots');
        let manifest = null;
        try { manifest = JSON.parse(manifestFile.text); } catch (_) {}
        if (!manifest || !Array.isArray(manifest.shots)) throw new Error('Las capturas terminaron pero no aparece ' + folder + '/manifest.json en la rama screenshots de ' + runner + ': ' + run.html_url);
        const base = 'https://raw.githubusercontent.com/' + runner + '/screenshots/' + folder + '/';
        const done = manifest.shots.filter((shot) => shot.file);
        const lines = manifest.shots.map((shot) => shot.file
          ? '· ' + shot.name + ' (' + shot.device + ', ' + (shot.theme === 'dark' ? 'oscuro' : 'claro') + '): ' + base + encodeURIComponent(shot.file) + (shot.pageErrors ? ' — errores en la página: ' + shot.pageErrors.join(' | ') : '')
          : '· ' + shot.name + ': no se pudo hacer (' + shot.error + ')');
        return textResult([
          done.length + ' de ' + manifest.shots.length + ' capturas reales de ' + where + ':',
          ...lines,
          '',
          'Enséñalas en el chat ahora: un bloque visual image por captura ({"type":"image","src":"<url>","alt":"…","caption":"…"}) o un solo gallery. Son fotos de verdad de esa versión; di qué se ve y qué ha cambiado.' + (own ? '' : ' (El repositorio es privado: la app las abre con el token del usuario.)')
        ].join('\n'), { repo, url, ref, folder, run: run.html_url, images: done.map((shot) => base + encodeURIComponent(shot.file)) });
      }
    },
    {
      name: 'github_list_issues',
      label: 'GitHub: issues y PRs',
      description: 'List open issues and pull requests of a repository, or read one (with its comments) by number.',
      parameters: Type.Object({
        repo: repoParam,
        number: Type.Optional(Type.Number({ description: 'Read this issue or PR.' })),
        state: Type.Optional(Type.String({ description: '"open" (default), "closed" or "all".' }))
      }),
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        if (params.number) {
          const issue = await gh('GET', '/repos/' + repo + '/issues/' + Number(params.number));
          const comments = await gh('GET', '/repos/' + repo + '/issues/' + Number(params.number) + '/comments?per_page=30');
          return textResult(clip('#' + issue.number + ' ' + issue.title + ' (' + issue.state + (issue.pull_request ? ', PR' : '') + ', @' + issue.user.login + ')\n\n' + (issue.body || '') +
            comments.map((comment) => '\n\n— @' + comment.user.login + ':\n' + comment.body).join(''), MAX_READ_CHARS));
        }
        const state = ['open', 'closed', 'all'].includes(params.state) ? params.state : 'open';
        const issues = await gh('GET', '/repos/' + repo + '/issues?per_page=50&state=' + state);
        return textResult(issues.length ? issues.map((issue) => '#' + issue.number + (issue.pull_request ? ' [PR]' : '') + ' ' + issue.title + ' · @' + issue.user.login).join('\n') : 'No hay issues ' + (state === 'open' ? 'abiertas' : '') + '.');
      }
    },
    {
      name: 'github_comment',
      label: 'GitHub: comentar',
      description: 'Post a comment on an issue or pull request. The user approves it.',
      parameters: Type.Object({ repo: repoParam, number: Type.Number(), body: Type.String({ description: 'Comment in Markdown.' }) }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        await ask({ title: 'Comentar en GitHub', summary: repo + ' #' + params.number + '\n\n' + String(params.body).slice(0, 600), items: [], kind: 'comment' });
        const comment = await gh('POST', '/repos/' + repo + '/issues/' + Number(params.number) + '/comments', { body: params.body });
        return textResult('Comentario publicado: ' + comment.html_url);
      }
    }
  ];
}

// For the connect dialog: who the token belongs to.
export async function githubWhoAmI(token) {
  const response = await fetch(API + '/user', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(response.status === 401 ? 'Ese token no es válido.' : 'GitHub respondió ' + response.status + '.');
  return response.json();
}

// Pushes a stage entry from the app (the pending-changes card): same commit path.
export async function githubPushStaged(ctx, repo, branch, message) {
  const tools = createGithubTools(ctx);
  return tools.find((tool) => tool.name === 'github_push').execute('app', { repo, branch, message });
}
