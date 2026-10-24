/* ─── Encima del cuadro de texto ──────────────────────────────────────
   Lo que vive justo encima de donde se escribe (#composer-dock):

   • La aprobación de un cambio (dockApprove): una tarjeta con el título, el
     resumen y los archivos con sus +/−, en vez de un diálogo a pantalla
     completa. Se puede seguir escribiendo mientras está abierta.
   • Los cambios de GitHub preparados y sin subir (githubStageStore): el
     modelo los prepara con github_edit_file / github_write_files y los sube
     de una vez; si queda algo sin subir, aquí está con «Subir» y «Descartar».
   • La cola: lo que se escribe mientras el modelo trabaja espera aquí y sale
     solo cuando termina del todo el turno anterior. «Ahora» lo mete en el
     turno que está en marcha (steer de pi: entra en cuanto acaba la llamada
     o la herramienta en curso, sin cancelar nada); Ctrl/Cmd+Enter hace lo
     mismo desde el cuadro.

   Y, en el hilo, la actividad en vivo de las herramientas (renderLiveSteps):
   qué está haciendo ahora, en qué archivo y desde hace cuánto.

   Loaded before the main script of index.html; uses its globals at call
   time (appState, elements, createMessage, runAssistantTurn, haptic…). */

/* ─── El contenedor ─────────────────────────────────────────────────── */

function composerDockEl() {
  let dock = document.getElementById('composer-dock');
  if (dock) return dock;
  const shell = document.querySelector('.composer-shell');
  if (!shell || !shell.parentNode) return null;
  dock = document.createElement('div');
  dock.className = 'composer-dock';
  dock.id = 'composer-dock';
  dock.innerHTML = '<div class="dock-slot" id="dock-approval"></div><div class="dock-slot" id="dock-stage"></div><div class="dock-slot" id="dock-queue"></div>';
  shell.parentNode.insertBefore(dock, shell);
  dock.addEventListener('click', onDockClick);
  return dock;
}

function dockIcon(name) {
  const paths = {
    queue: '<path d="M4 7h11M4 12h11M4 17h7M17 14v6M14 17h6"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/>',
    check: '<path d="M4 12.5 9.5 18 20 6.5"/>',
    branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="M7 5l11 7-11 7z"/>'
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || '') + '</svg>';
}

function renderComposerDock() {
  if (!composerDockEl()) return;
  renderQueueSlot();
  renderStageSlot();
}

function onDockClick(event) {
  const button = event.target.closest('[data-dock]');
  if (!button) return;
  const action = button.dataset.dock;
  const id = button.dataset.id || '';
  if (action === 'steer') queueSteer(id);
  else if (action === 'remove') queueRemove(id);
  else if (action === 'edit') queueEdit(id);
  else if (action === 'resume') queueResume();
  else if (action === 'approve' || action === 'reject') dockApprovalAnswer(action === 'approve');
  else if (action === 'push') stagePush(button.dataset.repo, button.dataset.branch);
  else if (action === 'discard') stageDiscard(button.dataset.repo, button.dataset.branch);
}

/* ─── Cola y steer ──────────────────────────────────────────────────── */

const messageQueue = { items: [], paused: false };

// What is in the composer becomes a queued message. steerNow: straight into
// the turn that is running. Returns false when there was nothing written.
function queueFromComposer(steerNow) {
  const text = elements.composer.value.trim();
  const attachments = (appState.composerAttachments || []).slice();
  if (!text && !attachments.length) return false;
  if (appState.attachmentBusy) {
    setComposerStatus('Espera a que terminen de procesarse los adjuntos.');
    return true;
  }
  const item = { id: uid('queued'), chatId: appState.activeChatId, text, attachments, steering: false };
  messageQueue.items.push(item);
  elements.composer.value = '';
  resetComposerAttachments();
  autoResizeComposer();
  haptic('select');
  if (steerNow) {
    queueSteer(item.id);
  } else {
    messageQueue.paused = false;
    updateSendUi();
  }
  return true;
}

function queueBuildMessage(item) {
  const parts = buildUserMessageParts(item.text, item.attachments);
  return createMessage('user', item.text || item.attachments.map((att) => att.name).join(', '), false, {
    parts,
    attachments: item.attachments
  });
}

function queueRemove(id) {
  messageQueue.items = messageQueue.items.filter((item) => item.id !== id || item.steering);
  renderComposerDock();
}

// Back into the composer to change it (only when the composer is empty).
function queueEdit(id) {
  const item = messageQueue.items.find((entry) => entry.id === id);
  if (!item || item.steering) return;
  if (elements.composer.value.trim() || (appState.composerAttachments || []).length) {
    showToast('Cola', 'Vacía el cuadro de texto para editar este mensaje.');
    return;
  }
  messageQueue.items = messageQueue.items.filter((entry) => entry !== item);
  elements.composer.value = item.text;
  appState.composerAttachments = item.attachments.slice();
  renderComposerAttachments();
  autoResizeComposer();
  updateSendUi();
  elements.composer.focus();
}

// Sends a queued message as a normal turn (the composer path of handleSend).
function queueDispatch(item) {
  messageQueue.items = messageQueue.items.filter((entry) => entry !== item);
  const chat = appState.chats.find((entry) => entry.id === item.chatId);
  if (!chat) { renderComposerDock(); return; }
  if (!ensureProviderReady(chat) || !guidedModelReady(chat)) {
    messageQueue.items.unshift(item);
    messageQueue.paused = true;
    renderComposerDock();
    return;
  }
  if (chat.id !== appState.activeChatId) {
    appState.activeChatId = chat.id;
    renderHistory();
  }
  const message = queueBuildMessage(item);
  if (chat.guidedLearning) guidedBeforeUserTurn(chat, item.text);
  haptic('send');
  runAssistantTurn(chat, message);
  renderComposerDock();
}

function queueDrain() {
  if (appState.busy || messageQueue.paused || !messageQueue.items.length) {
    renderComposerDock();
    return;
  }
  queueDispatch(messageQueue.items[0]);
}

// «Ahora»: into the running turn when it is this chat's; otherwise it goes first.
async function queueSteer(id) {
  const item = messageQueue.items.find((entry) => entry.id === id);
  if (!item || item.steering) return;
  if (!appState.busy) {
    messageQueue.paused = false;
    queueDispatch(item);
    return;
  }
  const active = appState.activeTurn;
  const chat = appState.chats.find((entry) => entry.id === item.chatId);
  if (!active || !chat || active.chatId !== item.chatId || !active.turn.steering || typeof active.turn.steering.steer !== 'function') {
    // Another chat (or a turn that cannot take it): it is next, right after this one.
    messageQueue.items = [item].concat(messageQueue.items.filter((entry) => entry !== item));
    messageQueue.paused = false;
    renderComposerDock();
    return;
  }
  item.steering = true;
  renderComposerDock();
  const message = queueBuildMessage(item);
  if (chat.guidedLearning) guidedBeforeUserTurn(chat, item.text);
  const model = InhousePi.getModel(resolveRequestModelId(chat));
  const piMessage = await piUserMessage(message, model.input.includes('image'));
  item.message = message;
  item.piMessage = piMessage;
  if (appState.activeTurn !== active || typeof active.turn.steering.steer !== 'function') {
    // The turn ended while this was being prepared: it is sent as the next one.
    item.steering = false;
    renderComposerDock();
    return;
  }
  active.turn.steering.steer(piMessage);
  haptic('light');
}

// The engine delivered a steered message: the app message that goes in the thread.
function queueSteerDelivered(piMessage) {
  const item = messageQueue.items.find((entry) => entry.piMessage === piMessage);
  if (!item) return null;
  messageQueue.items = messageQueue.items.filter((entry) => entry !== item);
  renderComposerDock();
  return item.message;
}

// The user pressed Stop: the queue waits until they resume it.
function queueStopped() {
  if (messageQueue.items.length) messageQueue.paused = true;
}

function queueResume() {
  messageQueue.paused = false;
  queueDrain();
}

// End of every turn (runAssistantTurn): steers that arrived too late go first,
// then the queue continues unless the turn was stopped or failed.
function queueAfterTurn(turn, outcome) {
  const late = (turn && turn.steering && turn.steering.undelivered) || [];
  late.slice().reverse().forEach((piMessage) => {
    const item = messageQueue.items.find((entry) => entry.piMessage === piMessage);
    if (!item) return;
    item.steering = false;
    item.piMessage = null;
    messageQueue.items = [item].concat(messageQueue.items.filter((entry) => entry !== item));
  });
  if (outcome === 'error' && messageQueue.items.length) messageQueue.paused = true;
  window.setTimeout(queueDrain, 0);
}

function renderQueueSlot() {
  const slot = document.getElementById('dock-queue');
  if (!slot) return;
  const items = messageQueue.items;
  if (!items.length) { slot.innerHTML = ''; return; }
  const head = messageQueue.paused
    ? '<div class="dock-queue-head paused">' + dockIcon('pause') + '<span>En pausa · ' + items.length + (items.length === 1 ? ' mensaje' : ' mensajes') + ' en la cola</span>' +
      '<button type="button" class="dock-link" data-dock="resume">' + dockIcon('play') + 'Seguir</button></div>'
    : items.every((item) => item.steering)
      ? '<div class="dock-queue-head">' + dockIcon('bolt') + '<span>Entra en cuanto acabe el paso en curso</span></div>'
      : '<div class="dock-queue-head">' + dockIcon('queue') + '<span>' + (items.length === 1 ? 'En la cola' : items.length + ' en la cola') + ' · salen cuando termine la respuesta</span></div>';
  slot.innerHTML = '<div class="dock-card dock-queue">' + head + '<ol class="dock-queue-list">' + items.map((item) => {
    const files = item.attachments.length ? '<span class="dock-queue-files">' + item.attachments.length + (item.attachments.length === 1 ? ' archivo' : ' archivos') + '</span>' : '';
    const chatNote = item.chatId !== appState.activeChatId ? '<span class="dock-queue-files">otro chat</span>' : '';
    return '<li class="dock-queue-item' + (item.steering ? ' steering' : '') + '">' +
      '<span class="dock-queue-text" title="' + escapeHtml(item.text) + '">' + escapeHtml(item.text || '(solo archivos)') + '</span>' + files + chatNote +
      (item.steering
        ? '<span class="dock-queue-state">' + dockIcon('bolt') + 'Entrando…</span>'
        : '<button type="button" class="dock-btn steer" data-dock="steer" data-id="' + item.id + '" title="Que lo atienda ya, sin esperar a que termine (Ctrl+Enter)">' + dockIcon('bolt') + '<span>Ahora</span></button>' +
          '<button type="button" class="dock-icon-btn" data-dock="edit" data-id="' + item.id + '" aria-label="Editar">' + dockIcon('edit') + '</button>' +
          '<button type="button" class="dock-icon-btn" data-dock="remove" data-id="' + item.id + '" aria-label="Quitar de la cola">' + dockIcon('close') + '</button>') +
      '</li>';
  }).join('') + '</ol></div>';
}

/* ─── Aprobación encima del cuadro ──────────────────────────────────── */

const dockApproval = { pending: null };

// { title, message, items: [{ path, status, added, removed }], danger, confirmText, cancelText } → Promise<boolean>
function dockApprove(request) {
  const slot = composerDockEl() && document.getElementById('dock-approval');
  if (!slot) return confirmDialog(request);
  if (dockApproval.pending) dockApproval.pending.resolve(false);
  return new Promise((resolve) => {
    const signal = appState.activeController && appState.activeController.signal;
    const finish = (value) => {
      if (!dockApproval.pending || dockApproval.pending.resolve !== finish) return;
      dockApproval.pending = null;
      slot.innerHTML = '';
      if (signal) signal.removeEventListener('abort', onAbort);
      refreshLiveSteps();
      resolve(value);
    };
    const onAbort = () => finish(false);
    if (signal) signal.addEventListener('abort', onAbort);
    dockApproval.pending = { resolve: finish };
    const items = Array.isArray(request.items) ? request.items : [];
    const added = items.reduce((sum, item) => sum + (Number(item.added) || 0), 0);
    const removed = items.reduce((sum, item) => sum + (Number(item.removed) || 0), 0);
    slot.innerHTML = '<div class="dock-card dock-approve' + (request.danger ? ' danger' : '') + '" role="alertdialog" aria-live="assertive" aria-label="' + escapeHtml(request.title || 'Aprobar') + '">' +
      '<div class="dock-approve-head"><b>' + escapeHtml(request.title || 'Aprobar') + '</b>' +
      (items.length ? '<span class="dock-approve-stats">' + items.length + (items.length === 1 ? ' archivo' : ' archivos') + (added ? ' · <span class="add">+' + added + '</span>' : '') + (removed ? ' <span class="del">−' + removed + '</span>' : '') + '</span>' : '') + '</div>' +
      (request.message ? '<p class="dock-approve-msg">' + escapeHtml(request.message) + '</p>' : '') +
      (items.length ? '<ul class="dock-approve-files">' + items.map((item) => '<li><span class="st">' + escapeHtml(item.status || '') + '</span><code>' + escapeHtml(item.path || '') + '</code>' +
        (item.added ? '<span class="add">+' + Number(item.added) + '</span>' : '') + (item.removed ? '<span class="del">−' + Number(item.removed) + '</span>' : '') + '</li>').join('') + '</ul>' : '') +
      '<div class="dock-approve-actions"><button type="button" class="dock-btn" data-dock="reject">' + escapeHtml(request.cancelText || 'No') + '</button>' +
      '<button type="button" class="dock-btn primary" data-dock="approve">' + escapeHtml(request.confirmText || 'Aprobar') + '</button></div></div>';
    haptic('select');
    refreshLiveSteps();
  });
}

function dockApprovalAnswer(value) {
  if (dockApproval.pending) dockApproval.pending.resolve(value);
}

/* ─── Cambios de GitHub preparados ──────────────────────────────────── */

// Per chat, in this browser: { 'repo@branch': entry } (engine/src/github.js).
// Whole files can be staged (index.html alone is ~0.6 MB), so they live in
// IndexedDB, not in localStorage (≈5 MB shared with the chats, which then
// could not be saved either). The engine reads and writes synchronously: a
// memory copy answers at once and every write goes to IndexedDB behind it.
// Stages left in localStorage by older pages move to IndexedDB on start.
function githubStagePrefix() { return STORAGE_KEY + '::githubStage::'; }
const githubStageCache = new Map();
let githubStageDbPromise = null;

function githubStageDb() {
  if (!githubStageDbPromise) {
    githubStageDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB no disponible'));
      const request = indexedDB.open('inhouse-learn-github-stage', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('stages');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    githubStageDbPromise.catch(() => {});
  }
  return githubStageDbPromise;
}

function githubStagePersist(key, map) {
  githubStageDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('stages', 'readwrite');
    if (Object.keys(map).length) tx.objectStore('stages').put(map, key); else tx.objectStore('stages').delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  })).catch((error) => console.warn('Cambios de GitHub preparados: no se pudieron guardar.', error));
}

function githubStageDrop(chatId) {
  const key = githubStagePrefix() + chatId;
  githubStageCache.delete(key);
  try { localStorage.removeItem(key); } catch (_) {}
  githubStagePersist(key, {});
}

// Start-up: everything staged into memory, and old localStorage copies moved over.
async function githubStageStart() {
  try {
    const db = await githubStageDb();
    await new Promise((resolve) => {
      const tx = db.transaction('stages', 'readonly');
      const store = tx.objectStore('stages');
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      tx.oncomplete = () => { keysReq.result.forEach((key, i) => { if (!githubStageCache.has(key)) githubStageCache.set(key, valsReq.result[i] || {}); }); resolve(); };
      tx.onerror = () => resolve();
    });
  } catch (_) {}
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(githubStagePrefix())) continue;
      let map = {};
      try { map = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) {}
      if (!githubStageCache.has(key)) { githubStageCache.set(key, map); githubStagePersist(key, map); }
      localStorage.removeItem(key);
    }
  } catch (_) {}
  if (typeof renderStageSlot === 'function') renderStageSlot();
}
document.addEventListener('DOMContentLoaded', () => { githubStageStart(); });

function githubStageStore(chat) {
  const key = githubStagePrefix() + (chat && chat.id);
  const read = () => {
    if (githubStageCache.has(key)) return JSON.parse(JSON.stringify(githubStageCache.get(key)));
    // Before start-up finished: an old copy may still be in localStorage.
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { return {}; }
  };
  const write = (map) => {
    githubStageCache.set(key, map);
    githubStagePersist(key, map);
  };
  const id = (repo, branch) => repo + '@' + branch;
  return {
    get: (repo, branch) => read()[id(repo, branch)] || null,
    put: (entry) => { const map = read(); map[id(entry.repo, entry.branch)] = entry; write(map); },
    remove: (repo, branch) => { const map = read(); delete map[id(repo, branch)]; write(map); },
    list: () => Object.values(read())
  };
}

// «repo@branch» → { state: 'up' | 'done', count, repo, branch }: mientras el
// botón sube, la misma tarjeta enseña el progreso; al terminar, un instante de
// «Subido» con su tilde antes de desaparecer.
const pushBusy = new Map();

function stageKey(repo, branch) { return repo + '@' + branch; }

function renderStageSlot() {
  const slot = document.getElementById('dock-stage');
  if (!slot) return;
  const chat = getActiveChat();
  // While the model works it uploads them itself: the card is only for what it left.
  const entries = chat && !appState.busy && typeof githubToken === 'function' && githubToken()
    ? githubStageStore(chat).list().filter((entry) => Object.keys(entry.files || {}).length || (entry.deletes || []).length)
    : [];
  const cards = entries.map((entry) => {
    const busy = pushBusy.get(stageKey(entry.repo, entry.branch));
    const paths = Object.keys(entry.files || {}).concat((entry.deletes || []).map((path) => path + ' (borrar)'));
    const repo = escapeHtml(entry.repo);
    const branch = escapeHtml(entry.branch);
    const head = '<div class="dock-stage-head">' + dockIcon('branch') + '<span><b>' + paths.length +
      (paths.length === 1 ? ' cambio preparado' : ' cambios preparados') + '</b> · ' + repo + ' · rama ' + branch + ' · ' +
      (busy ? 'subiendo…' : 'sin subir') + '</span></div>';
    const files = '<div class="dock-stage-files">' + paths.slice(0, 8).map((path) => '<code>' + escapeHtml(path) + '</code>').join('') +
      (paths.length > 8 ? '<span>+' + (paths.length - 8) + ' más</span>' : '') + '</div>';
    const actions = busy
      ? '<div class="dock-approve-actions"><button type="button" class="dock-btn primary busy" disabled aria-busy="true">' +
          '<span class="dock-spinner" aria-hidden="true"></span>' +
          '<span class="dock-btn-label">Subiendo ' + paths.length + (paths.length === 1 ? ' archivo' : ' archivos') + '…</span>' +
          '<span class="dock-progress" aria-hidden="true"></span></button></div>'
      : '<div class="dock-approve-actions"><button type="button" class="dock-btn" data-dock="discard" data-repo="' + repo + '" data-branch="' + branch + '">Descartar</button>' +
        '<button type="button" class="dock-btn primary" data-dock="push" data-repo="' + repo + '" data-branch="' + branch + '">' +
        dockIcon('upload') + 'Subir en un commit</button></div>';
    return '<div class="dock-card dock-stage' + (busy ? ' dock-stage-busy' : '') + '">' + head + files + actions + '</div>';
  });
  pushBusy.forEach((item) => {
    if (item.state !== 'done') return;
    if (entries.some((entry) => stageKey(entry.repo, entry.branch) === item.key)) return;
    cards.push('<div class="dock-card dock-stage dock-stage-done">' +
      '<div class="dock-stage-head">' + dockIcon('check') + '<span><b>Subido</b> · ' + escapeHtml(item.repo) + ' · rama ' + escapeHtml(item.branch) +
      ' · ' + item.count + (item.count === 1 ? ' archivo' : ' archivos') + '</span></div></div>');
  });
  slot.innerHTML = cards.join('');
}

async function stagePush(repo, branch) {
  const chat = getActiveChat();
  const key = stageKey(repo, branch);
  if (!chat || appState.busy || !githubToken() || pushBusy.has(key)) return;
  const entry = githubStageStore(chat).get(repo, branch) || {};
  const count = Object.keys(entry.files || {}).length + (entry.deletes || []).length;
  // The button in the card is the whole loading screen: spinner, «Subiendo…»
  // and a bar that creeps until the commit lands (or the error comes back).
  pushBusy.set(key, { state: 'up', key, count, repo, branch });
  renderStageSlot();
  setComposerStatus('Subiendo ' + count + (count === 1 ? ' archivo' : ' archivos') + ' a GitHub…');
  let ok = false;
  try {
    // Pressing «Subir» is the approval: the card already lists every file.
    const ctx = Object.assign(githubContext(chat), { confirm: () => Promise.resolve(true) });
    const result = await InhousePi.githubPushStaged(ctx, repo, branch, '');
    const link = ((result.content || [])[0] || {}).text || '';
    ok = true;
    pushBusy.set(key, { state: 'done', key, count, repo, branch });
    renderStageSlot();
  } catch (error) {
    pushBusy.delete(key);
    renderStageSlot();
    showToast('GitHub', error.message);
  } finally {
    setComposerStatus('');
    // The tick stays long enough to be seen, then the card goes away.
    window.setTimeout(() => { pushBusy.delete(key); renderComposerDock(); }, ok ? 1300 : 0);
  }
}

async function stageDiscard(repo, branch) {
  const chat = getActiveChat();
  if (!chat || appState.busy) return;
  githubStageStore(chat).remove(repo, branch);
  renderComposerDock();
}

/* ─── Actividad en vivo de las herramientas ─────────────────────────── */

const liveStepTimes = new Map();

const STEP_TEXT = {
  github_list_repos: ['Mirando tus repositorios', 'Repositorios vistos'],
  github_list_files: ['Mirando los archivos de', 'Archivos de'],
  github_read_file: ['Leyendo', 'Leído'],
  github_grep: ['Buscando', 'Buscado'],
  github_search_code: ['Buscando', 'Buscado'],
  github_write_files: ['Preparando', 'Preparado'],
  github_edit_file: ['Preparando un cambio en', 'Cambio preparado en'],
  github_discard: ['Descartando lo preparado en', 'Descartado lo preparado en'],
  github_push: ['Subiendo a GitHub', 'Subido a GitHub'],
  github_create_pull_request: ['Abriendo el pull request', 'Pull request abierto'],
  github_ci_status: ['Mirando la CI de', 'CI revisada de'],
  github_list_issues: ['Leyendo las issues de', 'Issues de'],
  github_comment: ['Comentando en', 'Comentado en'],
  github_release_android: ['Publicando la APK', 'APK publicada'],
  github_screenshot: ['Haciendo capturas reales', 'Capturas hechas'],
  run_js: ['Ejecutando código', 'Código ejecutado'],
  write_file: ['Guardando', 'Guardado'],
  read_file: ['Leyendo', 'Leído'],
  edit_file: ['Editando', 'Editado'],
  list_files: ['Mirando los archivos del chat', 'Archivos del chat'],
  delete_file: ['Borrando', 'Borrado'],
  search_library: ['Buscando en tus archivos', 'Buscado en tus archivos'],
  read_library: ['Leyendo', 'Leído'],
  list_library: ['Mirando tu biblioteca', 'Biblioteca vista'],
  view_library_image: ['Mirando la imagen', 'Imagen vista'],
  drive_search: ['Buscando en tu Drive', 'Buscado en tu Drive'],
  drive_list: ['Mirando una carpeta de tu Drive', 'Carpeta de tu Drive'],
  drive_read: ['Leyendo de tu Drive', 'Leído de tu Drive'],
  drive_write_file: ['Guardando en tu Drive', 'Guardado en tu Drive'],
  drive_edit_file: ['Editando en tu Drive', 'Editado en tu Drive'],
  drive_organize: ['Organizando tu Drive', 'Drive organizado'],
  drive_shared_drives: ['Mirando tus unidades compartidas', 'Unidades compartidas'],
  extra_drive_search: ['Buscando en el Drive de la otra cuenta', 'Buscado en el Drive de la otra cuenta'],
  extra_drive_list: ['Mirando una carpeta de la otra cuenta', 'Carpeta de la otra cuenta'],
  extra_drive_read: ['Leyendo del Drive de la otra cuenta', 'Leído del Drive de la otra cuenta'],
  extra_drive_shared_drives: ['Mirando las unidades compartidas de la otra cuenta', 'Unidades compartidas de la otra cuenta'],
  extra_gmail_search: ['Buscando en el correo de la otra cuenta', 'Buscado en el correo de la otra cuenta'],
  extra_gmail_read: ['Leyendo un correo de la otra cuenta', 'Correo leído de la otra cuenta'],
  web_search: ['Buscando en internet', 'Buscado en internet'],
  web_fetch: ['Leyendo en internet', 'Leído en internet'],
  spawn_agents: ['Agentes trabajando en paralelo', 'Agentes terminados']
};

const GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.7 3.9 5.9 3.9 9.5s-1.3 6.8-3.9 9.5c-2.6-2.7-3.9-5.9-3.9-9.5S9.4 5.2 12 2.5z"/></svg>';
const isWebStep = (step) => !!step && /^web_/.test(step.name);

function baseName(path) {
  return String(path || '').split('/').filter(Boolean).pop() || String(path || '');
}

// { title, verb, target, where } for one step, in plain Spanish.
function describeToolStep(step) {
  if (!step || !STEP_TEXT[step.name]) return null;
  const args = step.args || {};
  const running = step.status === 'running';
  const verb = STEP_TEXT[step.name][running ? 0 : 1];
  const repoShort = args.repo ? String(args.repo).split('/').pop() : '';
  let target = '';
  const where = [];
  switch (step.name) {
    case 'github_read_file':
    case 'read_file':
      target = baseName(args.path);
      if (args.from_line || args.to_line) where.push('líneas ' + (args.from_line || 1) + '–' + (args.to_line || '…'));
      if (args.path && args.path.includes('/')) where.push(args.path.split('/').slice(0, -1).join('/'));
      break;
    case 'github_grep':
    case 'github_search_code':
      target = '«' + String(args.pattern || args.query || '').slice(0, 60) + '»';
      if (args.path) where.push('en ' + args.path);
      break;
    case 'github_write_files': {
      const paths = (args.files || []).map((file) => baseName(file.path)).concat((args.delete || []).map((path) => baseName(path) + ' (borrar)'));
      target = paths.length === 1 ? paths[0] : paths.length + ' archivos';
      if (args.branch) where.push('rama ' + args.branch);
      break;
    }
    case 'github_edit_file':
    case 'edit_file':
    case 'write_file':
    case 'delete_file':
      target = baseName(args.path);
      if (args.branch) where.push('rama ' + args.branch);
      break;
    case 'github_push':
      where.push('rama ' + (args.branch || ''));
      break;
    case 'github_create_pull_request':
      target = args.title ? '«' + String(args.title).slice(0, 60) + '»' : '';
      break;
    case 'github_list_files':
    case 'github_ci_status':
    case 'github_list_issues':
    case 'github_comment':
    case 'github_discard':
      target = repoShort;
      repoShort && args.path && where.push(args.path);
      break;
    case 'github_screenshot':
    case 'github_release_android':
      // What the release is doing right now (build, signature, publication…).
      target = running && step.progress ? String(step.progress).replace(/: https?:\/\/\S+$/, '').slice(0, 80) : '';
      break;
    case 'web_search':
      target = args.query ? '«' + String(args.query).slice(0, 70) + '»' : '';
      break;
    case 'web_fetch':
      try { target = new URL(String(args.url || '')).hostname.replace(/^www\./, ''); } catch (_) { target = ''; }
      break;
    case 'drive_search':
    case 'extra_drive_search':
    case 'extra_gmail_search':
      target = args.query ? '«' + String(args.query).slice(0, 60) + '»' : '';
      break;
    case 'search_library':
      target = args.query ? '«' + String(args.query).slice(0, 60) + '»' : '';
      break;
    case 'read_library':
    case 'view_library_image':
      target = args.ref || '';
      break;
    default:
      break;
  }
  if (repoShort && !['github_list_files', 'github_ci_status', 'github_list_issues', 'github_comment', 'github_discard'].includes(step.name)) where.push(repoShort);
  const title = [verb, target].filter(Boolean).join(' ') + (where.length ? ' · ' + where.join(' · ') : '');
  return { title, verb, target, where: where.join(' · ') };
}

function stepTime(step) {
  const now = Date.now();
  let entry = liveStepTimes.get(step.id);
  if (!entry) { entry = { start: now, end: 0 }; liveStepTimes.set(step.id, entry); }
  if (step.status !== 'running' && !entry.end) entry.end = now;
  return entry;
}

function formatSeconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
}

function renderLiveSteps(message, steps) {
  const list = steps || [];
  const running = list.filter((step) => step.status === 'running').pop() || null;
  const done = list.filter((step) => step.status !== 'running');
  const waiting = !!dockApproval.pending;
  const lead = running ? describeToolStep(running) : null;
  const writing = !running && !!String(message.content || '').trim();
  const leadTitle = running ? (lead ? lead.verb : (TOOL_LABELS[running.name] || running.name)) : (writing ? 'Escribiendo la respuesta' : 'Pensando el siguiente paso');
  const since = running ? stepTime(running).start : (done.length ? (stepTime(done[done.length - 1]).end || Date.now()) : Date.now());
  const counts = { read: 0, edit: 0, search: 0 };
  done.forEach((step) => {
    if (/read|list|view/.test(step.name)) counts.read++;
    else if (/grep|search/.test(step.name)) counts.search++;
    else if (/edit|write|push|delete/.test(step.name)) counts.edit++;
  });
  const tally = [counts.read && counts.read + (counts.read === 1 ? ' lectura' : ' lecturas'), counts.search && counts.search + (counts.search === 1 ? ' búsqueda' : ' búsquedas'), counts.edit && counts.edit + (counts.edit === 1 ? ' cambio' : ' cambios')].filter(Boolean).join(' · ');
  const history = done.slice(-5).map((step) => {
    const info = describeToolStep(step);
    const time = stepTime(step);
    const firstLine = String(step.output || '').split('\n')[0].slice(0, 90);
    return '<li class="live-done' + (step.status === 'error' ? ' error' : '') + (isWebStep(step) ? ' web' : '') + '"><span class="live-mark">' + (step.status === 'error' ? '✕' : isWebStep(step) ? GLOBE : '✓') + '</span>' +
      '<span class="live-done-title">' + escapeHtml(info ? info.title : (TOOL_LABELS[step.name] || step.name)) + '</span>' +
      (step.status === 'error' && firstLine ? '<span class="live-done-note">' + escapeHtml(firstLine) + '</span>' : '') +
      (time.end && time.end - time.start >= 1000 ? '<span class="live-done-time">' + formatSeconds(time.end - time.start) + '</span>' : '') + '</li>';
  }).join('');
  return '<div class="live-steps" data-live-steps="' + escapeHtml(message.id) + '">' +
    // On the internet: a turning globe instead of the spinner, unmistakable.
    '<div class="live-now' + (waiting ? ' waiting' : '') + (!waiting && isWebStep(running) ? ' web' : '') + '">' + (!waiting && isWebStep(running) ? '<span class="live-globe" title="En internet">' + GLOBE + '</span>' : '<span class="live-spin" aria-hidden="true"></span>') +
    '<span class="live-now-text"><b>' + escapeHtml(waiting ? 'Esperando tu aprobación' : leadTitle) + '</b>' +
    (!waiting && lead && lead.target ? ' <span class="live-target">' + escapeHtml(lead.target) + '</span>' : '') +
    (!waiting && lead && lead.where ? '<span class="live-where"> · ' + escapeHtml(lead.where) + '</span>' : '') +
    (waiting ? '<span class="live-where"> · encima del cuadro de texto</span>' : '') + '</span>' +
    '<span class="live-time" data-live-since="' + since + '">' + formatSeconds(Date.now() - since) + '</span></div>' +
    (history ? '<ol class="live-history">' + history + '</ol>' : '') +
    (done.length ? '<div class="live-tally">' + done.length + (done.length === 1 ? ' paso' : ' pasos') + (tally ? ' · ' + tally : '') + '</div>' : '') +
    '</div>';
}

// The approval card changes what the running step says.
function refreshLiveSteps() {
  if (typeof getActiveChat !== 'function') return;
  const chat = getActiveChat();
  const message = chat && chat.messages.find((item) => item.pending);
  if (!message) return;
  const el = findMessageElement(message.id);
  const slot = el && el.querySelector('.slot-steps');
  if (slot) slot.innerHTML = renderToolStepsMarkup(message);
}

window.setInterval(() => {
  document.querySelectorAll('[data-live-since]').forEach((el) => {
    el.textContent = formatSeconds(Date.now() - Number(el.dataset.liveSince));
  });
}, 1000);

