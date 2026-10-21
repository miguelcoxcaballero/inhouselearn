// Conector de GitHub: herramientas de pi para leer y cambiar repositorios con
// la API REST de GitHub desde el navegador, con el token del usuario.
// Toda escritura (commit, rama, PR, comentario) pasa antes por ctx.confirm():
// la app enseña qué se va a cambiar y el usuario decide.
import { Type } from '@earendil-works/pi-ai';

const API = 'https://api.github.com';
const MAX_READ_CHARS = 30000;
const MAX_LIST = 400;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

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

// ctx: { token(): string, confirm({ title, summary, items }) → Promise<boolean>, onRepo?(repo), signal? }
export function createGithubTools(ctx) {
  async function gh(method, path, body, extraHeaders) {
    const token = ctx.token();
    if (!token) throw new Error('GitHub no está conectado: pide al usuario que lo conecte en el menú + → GitHub.');
    const response = await fetch(API + path, {
      method,
      headers: Object.assign({
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }, body ? { 'Content-Type': 'application/json' } : {}, extraHeaders || {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctx.signal
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok) {
      const message = (data && data.message) || text.slice(0, 200) || 'error';
      const hint = response.status === 401 ? ' (el token no es válido o caducó)'
        : response.status === 403 ? ' (el token no tiene permiso para esto: hace falta Contents y Pull requests de lectura y escritura en ese repositorio)'
          : response.status === 404 ? ' (no existe, o el token no tiene acceso a ese repositorio)' : '';
      const error = new Error('GitHub ' + response.status + ': ' + message + hint);
      error.status = response.status;
      throw error;
    }
    return data;
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

  async function readText(repo, path, ref) {
    try {
      const data = await gh('GET', '/repos/' + repo + '/contents/' + enc(path) + (ref ? '?ref=' + encodeURIComponent(ref) : ''));
      if (Array.isArray(data)) return { dir: data };
      if (data.encoding === 'base64' && data.content) return { text: decodeBase64(data.content), sha: data.sha, size: data.size };
      if (data.download_url) {
        const raw = await gh('GET', '/repos/' + repo + '/git/blobs/' + data.sha);
        return { text: decodeBase64(raw.content), sha: data.sha, size: data.size };
      }
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

  // One commit with any number of files (git data API): blobs → tree → commit → ref.
  async function commitFiles(params) {
    const repo = used(repoOf(params.repo));
    const branch = String(params.branch || '').trim();
    if (!branch) throw new Error('Falta la rama.');
    const files = (params.files || []).map((file) => ({ path: cleanPath(file.path), content: String(file.content == null ? '' : file.content) }));
    const deletes = (params.delete || []).map(cleanPath);
    if (!files.length && !deletes.length) throw new Error('No hay archivos que cambiar.');
    const main = await defaultBranch(repo);
    let head = await branchSha(repo, branch);
    const base = String(params.base || '').trim() || main;
    const creating = !head;
    const sourceRef = creating ? base : branch;
    const items = [];
    for (const file of files) {
      const old = await readText(repo, file.path, sourceRef);
      const stats = lineStats(old && old.text, file.content);
      items.push({ path: file.path, status: old && !old.dir ? 'modificado' : 'nuevo', added: stats.added, removed: stats.removed });
    }
    deletes.forEach((path) => items.push({ path, status: 'borrado', added: 0, removed: 0 }));
    await ask({
      title: 'Commit en GitHub',
      summary: repo + ' · rama ' + branch + (creating ? ' (nueva, desde ' + base + ')' : '') + (branch === main ? ' · ¡es la rama principal!' : '') + '\n«' + params.message + '»',
      items
    });
    if (creating) {
      const baseSha = await branchSha(repo, base);
      if (!baseSha) throw new Error('No existe la rama base ' + base + '.');
      await gh('POST', '/repos/' + repo + '/git/refs', { ref: 'refs/heads/' + branch, sha: baseSha });
      head = baseSha;
    }
    const parent = await gh('GET', '/repos/' + repo + '/git/commits/' + head);
    const tree = [];
    for (const file of files) {
      const blob = await gh('POST', '/repos/' + repo + '/git/blobs', { content: file.content, encoding: 'utf-8' });
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    deletes.forEach((path) => tree.push({ path, mode: '100644', type: 'blob', sha: null }));
    const newTree = await gh('POST', '/repos/' + repo + '/git/trees', { base_tree: parent.tree.sha, tree });
    const commit = await gh('POST', '/repos/' + repo + '/git/commits', { message: String(params.message || 'Update'), tree: newTree.sha, parents: [head] });
    await gh('PATCH', '/repos/' + repo + '/git/refs/heads/' + enc(branch), { sha: commit.sha });
    return textResult('Commit ' + commit.sha.slice(0, 7) + ' en ' + repo + '@' + branch + (creating ? ' (rama creada desde ' + base + ')' : '') + ': ' +
      items.map((item) => item.path + ' (' + item.status + ', +' + item.added + ' −' + item.removed + ')').join(', ') + '\nhttps://github.com/' + repo + '/commit/' + commit.sha,
    { repo, branch, sha: commit.sha });
  }

  const repoParam = Type.String({ description: 'Repository as "owner/name".' });

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
      description: 'List the files of a repository (whole tree), optionally only under a folder. Use it to find where things are before reading.',
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
        const shown = files.slice(0, MAX_LIST).map((item) => item.path + (item.size > 100000 ? ' (' + Math.round(item.size / 1024) + ' KB)' : ''));
        return textResult(repo + '@' + ref + ' · ' + files.length + ' archivos' + (tree.truncated ? ' (árbol truncado por GitHub)' : '') + '\n' + shown.join('\n') + (files.length > MAX_LIST ? '\n… (' + (files.length - MAX_LIST) + ' más: filtra con path)' : ''));
      }
    },
    {
      name: 'github_read_file',
      label: 'GitHub: leer archivo',
      description: 'Read a file of a repository (or list a folder). Lines are numbered; long files can be read by line range.',
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
        const file = await readText(repo, path, params.ref);
        if (!file) throw new Error('No existe ' + path + ' en ' + repo + (params.ref ? '@' + params.ref : '') + '. Usa github_list_files.');
        if (file.dir) return textResult(path + '/\n' + file.dir.map((item) => item.name + (item.type === 'dir' ? '/' : '')).join('\n'));
        const lines = file.text.split('\n');
        const from = Math.max(1, Number(params.from_line) || 1);
        const to = Math.min(lines.length, Number(params.to_line) || lines.length);
        const body = lines.slice(from - 1, to).map((line, index) => String(from + index).padStart(5) + '  ' + line).join('\n');
        return textResult(repo + '/' + path + ' · ' + lines.length + ' líneas' + (from > 1 || to < lines.length ? ' · ' + from + '–' + to : '') + '\n' + clip(body, MAX_READ_CHARS), { repo, path });
      }
    },
    {
      name: 'github_search_code',
      label: 'GitHub: buscar código',
      description: 'Search code in a repository (GitHub code search on the default branch). Returns paths and matching fragments.',
      parameters: Type.Object({ repo: repoParam, query: Type.String({ description: 'Words or identifiers to find.' }) }),
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const data = await gh('GET', '/search/code?per_page=20&q=' + encodeURIComponent(params.query + ' repo:' + repo), null, { Accept: 'application/vnd.github.text-match+json' });
        if (!data.items.length) return textResult('Sin resultados para «' + params.query + '» en ' + repo + '. Prueba otras palabras o github_list_files.');
        return textResult(data.items.map((item) => item.path + (item.text_matches || []).slice(0, 2).map((match) => '\n   ' + match.fragment.replace(/\s+/g, ' ').slice(0, 200)).join('')).join('\n'));
      }
    },
    {
      name: 'github_commit_files',
      label: 'GitHub: commit',
      description: 'Write files to a repository in ONE commit: create or replace whole files and delete files. If the branch does not exist it is created from base (default branch). Prefer a new branch plus a pull request over committing to the default branch. Read files before replacing them; content must be the complete new file. The user approves every commit.',
      parameters: Type.Object({
        repo: repoParam,
        branch: Type.String({ description: 'Branch to commit to (created if missing), e.g. "fix/typo-readme".' }),
        message: Type.String({ description: 'Commit message.' }),
        files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String({ description: 'Complete new file content.' }) }))),
        delete: Type.Optional(Type.Array(Type.String({ description: 'Path to delete.' }))),
        base: Type.Optional(Type.String({ description: 'Branch to start a new branch from (default branch if omitted).' }))
      }),
      executionMode: 'sequential',
      execute: async (id, params) => commitFiles(params)
    },
    {
      name: 'github_edit_file',
      label: 'GitHub: editar archivo',
      description: 'Replace one exact fragment of a file and commit it (old_text must appear exactly once in the file on that branch, or on base when the branch is new). Good for small changes in big files. The user approves every commit.',
      parameters: Type.Object({
        repo: repoParam,
        branch: Type.String({ description: 'Branch to commit to (created from base if missing).' }),
        path: Type.String(),
        old_text: Type.String({ description: 'Exact text to replace.' }),
        new_text: Type.String({ description: 'Replacement.' }),
        message: Type.String({ description: 'Commit message.' }),
        base: Type.Optional(Type.String())
      }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const path = cleanPath(params.path);
        const exists = await branchSha(repo, params.branch);
        const ref = exists ? params.branch : (params.base || await defaultBranch(repo));
        const file = await readText(repo, path, ref);
        if (!file || file.dir) throw new Error('No existe ' + path + ' en ' + repo + '@' + ref + '.');
        const count = params.old_text ? file.text.split(params.old_text).length - 1 : 0;
        if (count !== 1) throw new Error(count ? 'Ese texto aparece ' + count + ' veces en ' + path + ': incluye más contexto.' : 'No encuentro ese texto en ' + path + '@' + ref + '. Léelo con github_read_file y copia el fragmento exacto.');
        return commitFiles({ repo, branch: params.branch, base: params.base, message: params.message, files: [{ path, content: file.text.replace(params.old_text, () => params.new_text) }] });
      }
    },
    {
      name: 'github_create_pull_request',
      label: 'GitHub: abrir PR',
      description: 'Open a pull request from a branch. The user approves it.',
      parameters: Type.Object({
        repo: repoParam,
        head: Type.String({ description: 'Branch with the changes.' }),
        base: Type.Optional(Type.String({ description: 'Target branch (default branch if omitted).' })),
        title: Type.String(),
        body: Type.Optional(Type.String({ description: 'Description in Markdown.' })),
        draft: Type.Optional(Type.Boolean())
      }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const repo = used(repoOf(params.repo));
        const base = params.base || await defaultBranch(repo);
        const compare = await gh('GET', '/repos/' + repo + '/compare/' + encodeURIComponent(base) + '...' + encodeURIComponent(params.head));
        await ask({
          title: 'Abrir pull request',
          summary: repo + ' · ' + params.head + ' → ' + base + '\n«' + params.title + '»' + (params.draft ? ' (borrador)' : ''),
          items: (compare.files || []).slice(0, 30).map((file) => ({ path: file.filename, status: file.status, added: file.additions, removed: file.deletions }))
        });
        const pr = await gh('POST', '/repos/' + repo + '/pulls', { title: params.title, head: params.head, base, body: params.body || '', draft: !!params.draft });
        return textResult('PR #' + pr.number + ' abierta: ' + pr.html_url, { repo, number: pr.number });
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
        await ask({ title: 'Comentar en GitHub', summary: repo + ' #' + params.number + '\n\n' + String(params.body).slice(0, 600), items: [] });
        const comment = await gh('POST', '/repos/' + repo + '/issues/' + Number(params.number) + '/comments', { body: params.body });
        return textResult('Comentario publicado: ' + comment.html_url);
      }
    }
  ];
}

// For the connect dialog: who the token belongs to.
export async function githubWhoAmI(token) {
  const response = await fetch(API + '/user', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(response.status === 401 ? 'Ese token no es válido.' : 'GitHub respondió ' + response.status + '.');
  return response.json();
}
