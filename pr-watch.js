/* pr-watch.js — Seguimiento autónomo de pull requests (InhousePrWatch).

   El modelo sigue un PR con github_watch_prs (engine/src/github.js → ctx.watch,
   montado en githubContext de index.html). Mientras la app está abierta, este
   módulo mira cada PR seguido cada 10 minutos (y al volver a la app):
   - fusionado → una nota en su chat («PR fusionado»), noticia en el índice,
     notificación (Android en segundo plano o la del navegador si la dio) y deja
     de seguirlo; sin gastar ninguna petición al modelo;
   - cerrado sin fusionar → nota + aviso; en «Acceso total» un turno para ver
     por qué y arreglarlo si se puede;
   - comentarios o revisiones de otra persona → en «Acceso total» (y GitHub
     activo en el chat) un turno automático en la cola de ese chat para que el
     modelo lo resuelva solo; en otro modo, solo una nota y el aviso.
   Lo seguido vive en este dispositivo (localStorage), así que dos dispositivos
   nunca responden dos veces; un cerrojo evita lo mismo entre pestañas. Cada PR
   tiene un tope de turnos automáticos (MAX_ROUNDS) para que un bot que comenta
   en bucle no gaste sin fin. Los comentarios del propio usuario (su login) no
   cuentan: así lo que publica el modelo no vuelve a disparar otro turno.
   Test: tests/web/pr-watch.cjs. */
(function () {
  'use strict';
  const KEY = 'inhouse-learn-pr-watch';
  const LOCK = 'inhouse-learn-pr-watch-lock';
  const EVERY = 10 * 60 * 1000;
  const MAX_ROUNDS = 8;
  const BODY_MAX = 1500;
  const TEXT_MAX = 7000;
  const tab = Math.random().toString(36).slice(2);
  let running = false;
  let lastTick = 0;
  let retry = 0;

  const load = () => { try { const value = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(value) ? value : []; } catch (_) { return []; } };
  const save = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) {} };
  const same = (entry, repo, number) => String(entry.repo).toLowerCase() === String(repo).toLowerCase() && Number(entry.number) === Number(number);
  const g = (name) => (typeof window[name] === 'function' ? window[name] : null);

  function add(chatId, repo, number) {
    const list = load();
    const entry = list.find((item) => same(item, repo, number));
    if (entry) entry.chatId = chatId;
    else list.push({ repo: String(repo), number: Number(number), chatId, since: new Date(Date.now() - 60000).toISOString(), seen: [], rounds: 0, added: Date.now() });
    save(list);
    // Desktop: the browser's own notification for «fusionado», if the user allows it.
    try { if (!ANDROID() && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch (_) {}
    return list.find((item) => same(item, repo, number));
  }

  function remove(repo, number) {
    const list = load();
    const next = list.filter((item) => !same(item, repo, number));
    save(next);
    return next.length !== list.length;
  }

  function list(chatId) {
    return load().filter((item) => !chatId || item.chatId === chatId).map((item) => ({ repo: item.repo, number: item.number, chatId: item.chatId, rounds: item.rounds || 0 }));
  }

  function update(repo, number, change) {
    const all = load();
    const entry = all.find((item) => same(item, repo, number));
    if (!entry) return;
    change(entry);
    save(all);
  }

  function ANDROID() { try { return typeof ANDROID_APP !== 'undefined' && !!ANDROID_APP; } catch (_) { return false; } }

  function autoFor(chat) {
    return !!chat && !!chat.github && typeof approvalModeOf === 'function' && approvalModeOf(chat) === 'full';
  }

  function takeLock() {
    const now = Date.now();
    try {
      const current = JSON.parse(localStorage.getItem(LOCK) || 'null');
      if (current && current.tab !== tab && current.until > now) return false;
      localStorage.setItem(LOCK, JSON.stringify({ tab, until: now + 4 * 60 * 1000 }));
    } catch (_) {}
    return true;
  }

  async function gh(path) {
    const token = g('githubToken') ? window.githubToken() : (typeof githubToken === 'function' ? githubToken() : '');
    if (!token) { const error = new Error('GitHub no está conectado'); error.status = 0; throw error; }
    const response = await fetch('https://api.github.com' + path, {
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (!response.ok) { const error = new Error('GitHub ' + response.status); error.status = response.status; throw error; }
    return response.json();
  }

  function login() {
    try { return typeof githubLogin === 'function' ? githubLogin() : ''; } catch (_) { return ''; }
  }

  // New reviews and comments of other people since the last look.
  async function inspect(entry, me) {
    const base = '/repos/' + entry.repo;
    const since = encodeURIComponent(entry.since || new Date(entry.added || Date.now()).toISOString());
    const [pr, talk, code, reviews] = await Promise.all([
      gh(base + '/pulls/' + entry.number),
      gh(base + '/issues/' + entry.number + '/comments?per_page=100&since=' + since),
      gh(base + '/pulls/' + entry.number + '/comments?per_page=100&since=' + since),
      gh(base + '/pulls/' + entry.number + '/reviews?per_page=100')
    ]);
    const seen = new Set(entry.seen || []);
    const mine = (user) => !!user && !!me && String(user.login).toLowerCase() === String(me).toLowerCase();
    const after = (date) => !!date && new Date(date).getTime() > new Date(entry.since || 0).getTime() - 60000;
    const items = [];
    (talk || []).forEach((comment) => {
      if (mine(comment.user) || seen.has('c' + comment.id)) return;
      items.push({ key: 'c' + comment.id, kind: 'comentario', who: comment.user.login, bot: comment.user.type === 'Bot', body: comment.body || '', url: comment.html_url });
    });
    (code || []).forEach((comment) => {
      if (mine(comment.user) || seen.has('r' + comment.id)) return;
      items.push({ key: 'r' + comment.id, kind: 'comentario en el código (id ' + comment.id + ', ' + comment.path + ':' + (comment.line || comment.original_line || '?') + ')', who: comment.user.login, bot: comment.user.type === 'Bot', body: comment.body || '', url: comment.html_url });
    });
    (reviews || []).forEach((review) => {
      if (mine(review.user) || seen.has('v' + review.id) || !after(review.submitted_at)) return;
      if (review.state === 'COMMENTED' && !review.body) return;
      items.push({ key: 'v' + review.id, kind: 'revisión ' + review.state, who: review.user.login, bot: review.user.type === 'Bot', body: review.body || '', url: review.html_url });
    });
    return { pr, items };
  }

  function chatOf(id) {
    try { return appState.chats.find((chat) => chat.id === id) || null; } catch (_) { return null; }
  }

  // A short assistant note in the chat: no model request.
  function note(chat, text) {
    if (!chat || typeof createMessage !== 'function') return;
    const message = createMessage('assistant', text, false);
    message.prWatch = true;
    chat.messages.push(message);
    chat.updatedAt = new Date().toISOString();
    if (typeof markChatUnreadIfAway === 'function') markChatUnreadIfAway(chat.id);
    if (typeof saveState === 'function') saveState();
    if (typeof renderHistory === 'function') renderHistory();
    if (chat.id === appState.activeChatId && typeof renderThread === 'function') renderThread();
  }

  function notify(title, text, chatId) {
    try {
      if (ANDROID()) {
        if (document.hidden && typeof androidAppMessage === 'function') androidAppMessage({ type: 'answered', title, text: String(text).slice(0, 240), chat: chatId || '' });
      } else if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        const shown = new Notification(title, { body: text, tag: 'pr-' + title });
        shown.onclick = () => { window.focus(); if (chatId && typeof window.inhouseLearnOpenChat === 'function') window.inhouseLearnOpenChat(chatId); };
      }
    } catch (_) {}
    try { (window.__inhouseNotices = window.__inhouseNotices || []).push({ title, message: text }); } catch (_) {}
  }

  // A turn in that chat's queue, written as an automatic message (never as the user's own words).
  function enqueue(chat, text) {
    if (typeof messageQueue !== 'object' || !messageQueue || typeof queueDrain !== 'function') return false;
    if (messageQueue.items.some((item) => item.auto && item.chatId === chat.id && item.text === text)) return true;
    messageQueue.items.push({ id: (typeof uid === 'function' ? uid('queued') : 'queued-' + Date.now()), chatId: chat.id, text, attachments: [], steering: false, auto: true });
    messageQueue.paused = false;
    queueDrain();
    return true;
  }

  const clipBody = (text) => { const value = String(text || '').trim(); return value.length > BODY_MAX ? value.slice(0, BODY_MAX) + '…' : value; };
  const prLink = (entry, pr) => '[#' + entry.number + ' ' + (pr.title || '') + '](' + (pr.html_url || ('https://github.com/' + entry.repo + '/pull/' + entry.number)) + ')';

  function feedbackTask(entry, pr, items) {
    let text = '🔔 Seguimiento automático de PR (no lo ha escrito el usuario): hay novedades en ' + entry.repo + '#' + entry.number + ' «' + pr.title + '» (rama ' + (pr.head ? pr.head.label : '?') + ').\n';
    for (const item of items) {
      const line = '\n— @' + item.who + (item.bot ? ' (bot)' : '') + ' · ' + item.kind + ':\n' + (clipBody(item.body) || '(sin texto)') + '\n';
      if (text.length + line.length > TEXT_MAX) { text += '\n(Hay más: léelos con github_pr_activity.)\n'; break; }
      text += line;
    }
    return text + [
      '',
      'Resuélvelo tú solo, sin preguntar al usuario (no está mirando):',
      '1. Lee el PR entero con github_pr_activity y el código afectado.',
      '2. Si piden cambios, hazlos en esa rama del fork, súbelos con github_push, compílalos y pruébalos con github_run hasta que pasen; si cambia algo de lo que dice la descripción, actualízala con github_update_pull_request.',
      '3. Responde a cada persona con github_comment (a un comentario del código, con reply_to = su id), en su idioma, breve: qué has cambiado y el commit. Si es una pregunta, contéstala solo con lo comprobado.',
      '4. Si un comentario no pide nada (un agradecimiento, un aviso de un bot sin fallo), no respondas.',
      '5. Si te piden algo que no puedes hacer bien (probar en una consola o en una GPU real, una decisión del usuario), dilo en el PR con honestidad y avísalo aquí.',
      'Al terminar, escribe al usuario 1–3 líneas: qué pedían y qué has hecho, con enlaces.'
    ].join('\n');
  }

  function closedTask(entry, pr) {
    return '🔔 Seguimiento automático de PR (no lo ha escrito el usuario): ' + entry.repo + '#' + entry.number + ' «' + pr.title + '» se ha cerrado sin fusionar.\n' +
      'Mira con github_pr_activity los últimos comentarios y la razón. Si fue algo que se puede arreglar (límite de PR abiertos, un conflicto, la CI, la plantilla), arréglalo y reábrelo con github_update_pull_request (state: open) o abre otro PR y vuelve a seguirlo con github_watch_prs. Si un mantenedor lo rechazó a propósito, no insistas. Díselo al usuario en 1–3 líneas.';
  }

  function apply(entry, result, startedAt) {
    const { pr, items } = result;
    const chat = chatOf(entry.chatId);
    if (pr.merged) {
      remove(entry.repo, entry.number);
      note(chat, '✅ **PR fusionado** · ' + prLink(entry, pr) + ' en ' + entry.repo + (pr.merged_by ? ', por @' + pr.merged_by.login : '') + '. Ya no lo sigo.');
      notify('PR fusionado', '#' + entry.number + ' ' + pr.title + ' · ' + entry.repo, entry.chatId);
      return;
    }
    if (pr.state === 'closed') {
      remove(entry.repo, entry.number);
      notify('PR cerrado sin fusionar', '#' + entry.number + ' ' + pr.title + ' · ' + entry.repo, entry.chatId);
      if (chat && autoFor(chat) && (entry.rounds || 0) < MAX_ROUNDS) enqueue(chat, closedTask(entry, pr));
      else note(chat, '⚠️ **PR cerrado sin fusionar** · ' + prLink(entry, pr) + ' en ' + entry.repo + '. Ya no lo sigo.');
      return;
    }
    update(entry.repo, entry.number, (stored) => {
      stored.since = new Date(startedAt - 120000).toISOString();
      stored.seen = (stored.seen || []).concat(items.map((item) => item.key)).slice(-400);
      stored.title = pr.title;
    });
    if (!items.length) return;
    const people = Array.from(new Set(items.map((item) => '@' + item.who))).join(', ');
    notify('Novedades en tu PR', people + ' en #' + entry.number + ' ' + pr.title, entry.chatId);
    if (chat && autoFor(chat) && (entry.rounds || 0) < MAX_ROUNDS) {
      update(entry.repo, entry.number, (stored) => { stored.rounds = (stored.rounds || 0) + 1; });
      enqueue(chat, feedbackTask(entry, pr, items));
    } else {
      const why = !chat ? '' : autoFor(chat) ? ' Ya he respondido ' + MAX_ROUNDS + ' veces de forma automática en este PR: este lo dejo para ti.' : ' Pon el chat en «Acceso total» para que lo resuelva yo solo.';
      note(chat, '💬 **Novedades en tu PR** · ' + prLink(entry, pr) + ': ' + people + '.' + why);
    }
  }

  async function tick() {
    if (running) return;
    let ready = false;
    try { ready = !!appState.stateLoaded; } catch (_) {}
    const entries = load();
    if (!ready || !entries.length) return;
    // Never in the middle of a turn, nor while the user is typing: try again in a minute.
    let busy = false;
    try { busy = !!appState.busy || !!(elements.composer && elements.composer.value.trim()); } catch (_) {}
    if (busy) { clearTimeout(retry); retry = setTimeout(tick, 60000); return; }
    if (!takeLock()) return;
    running = true;
    lastTick = Date.now();
    const me = login();
    try {
      for (const entry of entries) {
        const startedAt = Date.now();
        let result;
        try { result = await inspect(entry, me); } catch (error) {
          if (error && error.status === 0) break;
          continue;
        }
        apply(entry, result, startedAt);
      }
    } finally {
      running = false;
    }
  }

  setTimeout(tick, 15000);
  setInterval(tick, EVERY);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastTick > 2 * 60 * 1000) setTimeout(tick, 3000);
  });

  window.InhousePrWatch = { add, remove, list, autoFor, tick, MAX_ROUNDS };
})();
