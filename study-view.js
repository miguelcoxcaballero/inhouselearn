/* Pantalla «Estudio» (study.js guarda y calcula; esto lo enseña).
   Se abre con el botón de encima de la cuenta, en el menú de chats, y tapa
   el chat sin cambiarlo: «Chats» vuelve a donde estabas. Cuatro pestañas:
   Hoy (lo que toca en todas las asignaturas, con «Empezar»), Asignaturas
   (examen, horas, temas con su estado, lagunas y los próximos días), Lo que
   sé de ti (la memoria, borrable) y Errores (los más caros primero).
   «Empezar» abre un chat nuevo de esa asignatura con la tarea ya escrita. */
(function () {
  const S = () => window.InhouseStudy;
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TABS = [['hoy', 'Hoy'], ['asignaturas', 'Asignaturas'], ['memoria', 'Sobre ti'], ['errores', 'Errores']];
  const KIND_LABEL = { estudio: 'Estudiar', repaso: 'Repasar', simulacro: 'Simulacro' };
  const MEMORY_LABEL = { objetivo: 'Objetivos', preferencia: 'Preferencias', dato: 'Sobre ti', aprendizaje: 'Cómo aprendes' };
  const BAND_CLASS = { 'sin tocar': 'none', 'frágil': 'weak', 'en camino': 'mid', 'sólido': 'strong' };
  const view = { tab: 'hoy', editing: null, open: false };
  try { view.tab = sessionStorage.getItem('study::tab') || 'hoy'; } catch (_) {}

  const ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };

  function fmtDate(key, opts) {
    try { return new Date(key + 'T12:00:00').toLocaleDateString('es-ES', opts || { weekday: 'short', day: 'numeric', month: 'short' }); } catch (_) { return key; }
  }
  const left = (n) => n === null ? '' : n < 0 ? 'ya pasó' : n === 0 ? 'hoy' : n === 1 ? 'mañana' : n + ' días';

  function root() {
    let el = document.getElementById('study-view');
    if (!el) {
      el = document.createElement('section');
      el.id = 'study-view';
      el.className = 'study-view hidden';
      el.setAttribute('aria-label', 'Estudio');
      document.body.appendChild(el);
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      el.addEventListener('submit', onSubmit);
      el.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !view.editing) close(); });
    }
    return el;
  }

  function open(tab) {
    if (tab) view.tab = tab;
    view.open = true;
    const el = root();
    el.classList.remove('hidden');
    document.documentElement.classList.add('study-open');
    if (typeof setChatsDrawer === 'function') setChatsDrawer(false);
    render();
    const pulled = S() && S().pull();
    if (pulled && pulled.then) pulled.then((changed) => { if (changed && view.open) render(); });
    // Focus inside (Escape closes, Tab starts at the tabs) without a ring on «Hoy».
    el.setAttribute('tabindex', '-1');
    setTimeout(() => el.focus({ preventScroll: true }), 30);
  }

  function close() {
    view.open = false;
    view.editing = null;
    root().classList.add('hidden');
    document.documentElement.classList.remove('study-open');
  }

  function setTab(tab) {
    view.tab = tab;
    view.editing = null;
    try { sessionStorage.setItem('study::tab', tab); } catch (_) {}
    render();
  }

  /* ─── Pestañas ──────────────────────────────────────────────────── */

  function renderToday() {
    const study = S();
    const days = study.today();
    const all = days.flatMap((d) => d.items.map((item) => Object.assign({ space: d.space }, item)));
    const pending = all.filter((item) => !item.done);
    const minutes = pending.reduce((sum, item) => sum + item.minutes, 0);
    const date = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    if (!days.length) {
      return '<div class="study-hero"><span class="study-kicker">' + esc(date) + '</span><h2>Organiza lo que estudias</h2>' +
        '<p>Dile a la app qué examen tienes y cuánto tiempo hay: ella reparte el estudio y los repasos hasta ese día. También vale decírselo a un chat: «tengo examen de Análisis el 15 de diciembre».</p>' +
        '<button type="button" class="study-btn primary" data-study="new-space">' + ICON.plus + 'Nueva asignatura</button></div>' +
        '<ol class="study-how">' +
        '<li><span>1</span><div><b>Una asignatura, una fecha</b><small>Sus temas y cuánto pesa cada uno en el examen.</small></div></li>' +
        '<li><span>2</span><div><b>Un plan que se rehace solo</b><small>Sesiones intercaladas y repasos a 1, 3, 7 y 14 días, dentro de tus horas.</small></div></li>' +
        '<li><span>3</span><div><b>Chats que saben por dónde vas</b><small>Cada respuesta tuya cuenta; tus errores más caros salen primero.</small></div></li></ol>';
    }
    const doneCount = all.length - pending.length;
    const costly = study.costlyMistakes('', 3);
    const head = '<div class="study-hero compact"><span class="study-kicker">' + esc(date) + '</span><h2>' +
      (pending.length ? pending.length + (pending.length === 1 ? ' cosa' : ' cosas') + ' para hoy · ' + minutes + ' min' : all.length ? 'Hoy ya está hecho' : 'Hoy no toca nada') + '</h2>' +
      (all.length ? '<div class="study-progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + all.length + '" aria-valuenow="' + doneCount + '" aria-label="Hecho hoy"><span style="width:' + Math.round(doneCount / all.length * 100) + '%"></span></div><p class="study-progress-text">' + doneCount + ' de ' + all.length + ' hecha' + (all.length === 1 ? '' : 's') + '</p>' : '') +
      (pending.length ? '<button type="button" class="study-btn primary" data-study="start" data-space="' + esc(pending[0].space.id) + '" data-topic="' + esc(pending[0].topicId) + '" data-kind="' + esc(pending[0].kind) + '">' + ICON.play + 'Empezar por ' + esc(KIND_LABEL[pending[0].kind].toLowerCase() + ' ' + pending[0].topic) + '</button>' : '') + '</div>';
    const cards = days.map((d) => {
      const sp = d.space;
      const items = d.items.length ? '<ul class="study-today">' + d.items.map((item) => '<li class="' + (item.done ? 'done' : '') + '">' +
        '<button type="button" class="study-check" role="checkbox" aria-checked="' + (item.done ? 'true' : 'false') + '" aria-label="Hecho" data-study="done" data-space="' + esc(sp.id) + '" data-topic="' + esc(item.topicId) + '" data-kind="' + esc(item.kind) + '">' + ICON.check + '</button>' +
        '<span class="study-today-text"><b>' + esc(KIND_LABEL[item.kind]) + '</b> ' + esc(item.topic) + '<small>' + item.minutes + ' min</small></span>' +
        (item.done ? '' : '<button type="button" class="study-btn small" data-study="start" data-space="' + esc(sp.id) + '" data-topic="' + esc(item.topicId) + '" data-kind="' + esc(item.kind) + '">Empezar</button>') + '</li>').join('') + '</ul>'
        : '<p class="study-muted">Hoy no toca nada de esta asignatura.</p>';
      const todayTopics = new Set(d.items.map((item) => item.topicId));
      const weak = d.gaps.filter((g) => g.band !== 'sólido' && !todayTopics.has(g.topic.id)).slice(0, 3);
      return '<article class="study-card" style="--sp:' + esc(sp.color) + '"><header class="study-card-head"><span class="study-dot"></span><b>' + esc(sp.name) + '</b>' +
        (d.left !== null ? '<span class="study-pill' + (d.left <= 7 ? ' soon' : '') + '">Examen ' + esc(left(d.left)) + '</span>' : '') + '</header>' + items +
        (weak.length ? '<p class="study-muted">Después, lo que más rinde: ' + weak.map((g) => '<span class="study-chip">' + esc(g.topic.name) + ' <span class="study-band ' + BAND_CLASS[g.band] + '">' + esc(g.band) + '</span></span>').join(' · ') + '</p>' : '') + '</article>';
    }).join('');
    const warm = costly.length ? '<article class="study-card warm"><header class="study-card-head"><b>Tus errores más caros</b></header><ul class="study-errors">' +
      costly.map((m) => '<li><span class="study-err-text"><b>' + esc(m.topic || 'Sin tema') + '</b>' + (m.cause ? ' · ' + esc(m.cause) : '') + '</span><span class="study-count" title="Veces">×' + m.count + '</span></li>').join('') + '</ul>' +
      '<button type="button" class="study-btn small" data-study="warmup">' + ICON.play + 'Calentamiento de 3 min</button></article>' : '';
    return head + cards + warm;
  }

  function topicRows(sp) {
    const gaps = S().gaps(sp);
    if (!gaps.length) return '<p class="study-muted">Sin temas todavía: edítala y añádelos.</p>';
    return '<ol class="study-topics">' + gaps.map((g) => '<li><span class="study-topic-name">' + esc(g.topic.name) + '</span>' +
      '<span class="study-bar' + (g.topic.seenAt ? '' : ' untouched') + '" title="Dominio ' + Math.round(g.mastery * 100) + ' %"><span style="width:' + Math.round(g.mastery * 100) + '%"></span></span>' +
      '<span class="study-band ' + BAND_CLASS[g.band] + '">' + esc(g.band) + '</span><small class="study-weight">peso ' + g.topic.weight + '</small></li>').join('') + '</ol>';
  }

  function planStrip(sp) {
    const p = S().plan(sp);
    const days = p.days.slice(0, 10);
    if (!days.length) return '';
    return '<h4 class="study-label">Próximos días</h4><div class="study-strip" role="list" aria-label="Próximos días">' + days.map((day, index) => '<div class="study-day' + (index === 0 ? ' today' : '') + (day.exam ? ' exam' : '') + '" role="listitem">' +
      '<span class="study-day-date">' + esc(index === 0 ? 'Hoy' : fmtDate(day.date, { weekday: 'short', day: 'numeric' })) + '</span>' +
      (day.exam ? '<span class="study-day-item exam">Examen</span>' : day.items.length ? day.items.map((item) => '<span class="study-day-item ' + item.kind + (item.done ? ' done' : '') + '" title="' + esc(KIND_LABEL[item.kind] + ' ' + item.topic) + '">' + (item.kind === 'repaso' ? '<i aria-hidden="true">↻</i>' : '') + esc(item.kind === 'simulacro' ? 'Simulacro' : item.topic) + '</span>').join('') : '<span class="study-day-free">libre</span>') + '</div>').join('') + '</div>';
  }

  function renderSpaces() {
    const study = S();
    if (view.editing) return renderForm(view.editing === 'new' ? null : study.space(view.editing));
    const list = study.spaces();
    const add = '<button type="button" class="study-btn" data-study="new-space">' + ICON.plus + 'Nueva asignatura</button>';
    if (!list.length) return '<div class="study-hero"><h2>Sin asignaturas</h2><p>Cada asignatura tiene su examen, tus horas y sus temas; sus chats saben por dónde vas.</p>' + add + '</div>';
    return list.map((sp) => {
      const n = study.daysToExam(sp);
      const chats = (sp.chatIds || []).map((id) => ((typeof appState !== 'undefined' && appState.chats) || []).find((chat) => chat.id === id)).filter(Boolean);
      return '<article class="study-card" style="--sp:' + esc(sp.color) + '"><header class="study-card-head"><span class="study-dot"></span><b>' + esc(sp.name) + '</b>' +
        (n !== null ? '<span class="study-pill' + (n <= 7 ? ' soon' : '') + '">Examen ' + esc(fmtDate(sp.examDate, { day: 'numeric', month: 'short' })) + ' · ' + esc(left(n)) + '</span>' : '') +
        '<button type="button" class="study-edit" data-study="edit" data-space="' + esc(sp.id) + '">Editar</button></header>' +
        '<p class="study-sub">' + sp.hoursWeek + ' h a la semana · ' + (sp.topics || []).length + ((sp.topics || []).length === 1 ? ' tema' : ' temas') + '</p>' +
        topicRows(sp) + planStrip(sp) +
        (chats.length ? '<p class="study-chats">Chats: ' + chats.slice(0, 6).map((chat) => '<a href="?c=' + esc(chat.id) + '" data-study="open-chat" data-chat="' + esc(chat.id) + '">' + esc(chat.title || 'Chat') + '</a>').join(' · ') + '</p>' : '') +
        '<div class="study-actions"><button type="button" class="study-btn small" data-study="start" data-space="' + esc(sp.id) + '" data-kind="simulacro">' + ICON.play + 'Simulacro</button>' +
        '<button type="button" class="study-btn small" data-study="start" data-space="' + esc(sp.id) + '" data-kind="chat">Nuevo chat de la asignatura</button></div></article>';
    }).join('') + '<div class="study-foot">' + add + '</div>';
  }

  function renderForm(sp) {
    const topics = sp ? (sp.topics || []).map((t) => t.name + (t.weight !== 1 ? ' · ' + t.weight : '')).join('\n') : '';
    return '<form class="study-card study-form" data-study-form="' + esc(sp ? sp.id : '') + '">' +
      '<header class="study-card-head"><b>' + (sp ? 'Editar ' + esc(sp.name) : 'Nueva asignatura') + '</b></header>' +
      '<label>Nombre<input name="name" required maxlength="80" value="' + esc(sp ? sp.name : '') + '" placeholder="Análisis II"></label>' +
      '<div class="study-form-row"><label>Examen<input name="examDate" type="date" value="' + esc(sp ? sp.examDate || '' : '') + '"></label>' +
      '<label>Horas por semana<input name="hoursWeek" type="number" min="0.5" max="80" step="0.5" value="' + esc(sp ? sp.hoursWeek : 4) + '"></label></div>' +
      '<label>Temas <small>(uno por línea; «· 3» al final para su peso en el examen)</small><textarea name="topics" rows="6" placeholder="Límites · 2&#10;Derivadas · 3&#10;Integrales · 3">' + esc(topics) + '</textarea></label>' +
      '<label>Cómo quieres que te enseñe <small>(opcional)</small><textarea name="rules" rows="2" placeholder="Solo pistas, nunca la solución entera">' + esc(sp ? sp.rules || '' : '') + '</textarea></label>' +
      '<div class="study-actions">' + (sp ? '<button type="button" class="study-btn small danger" data-study="delete-space" data-space="' + esc(sp.id) + '">Borrar</button>' : '') +
      '<span class="study-grow"></span><button type="button" class="study-btn small ghost" data-study="cancel">Cancelar</button><button type="submit" class="study-btn small primary">Guardar</button></div></form>';
  }

  function renderMemory() {
    const study = S();
    const items = study.memory();
    const groups = study.MEMORY_KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind)]).filter(([, list]) => list.length);
    const form = '<form class="study-add" data-study-memory><input name="text" maxlength="300" placeholder="Añade algo que deba saber de ti" aria-label="Añadir a la memoria"><button type="submit" class="study-btn small">Añadir</button></form>';
    if (!groups.length) return '<div class="study-hero"><span class="study-kicker">Lo que sé de ti</span><h2>Aún no sé nada de ti</h2><p>Cuando le cuentes a un chat tus objetivos, cómo te gusta aprender o qué estudias, lo recordará para los demás chats. Aquí lo ves todo y lo borras cuando quieras.</p></div>' + form;
    return '<div class="study-hero compact"><span class="study-kicker">Lo que sé de ti</span><h2>' + items.length + (items.length === 1 ? ' cosa' : ' cosas') + ' que recuerdo</h2><p>Los chats lo usan sin repetírtelo. Borra lo que no quieras que recuerde.</p></div>' + groups.map(([kind, list]) => '<section class="study-mem-group"><h3>' + esc(MEMORY_LABEL[kind]) + '</h3><ul class="study-mem">' + list.map((item) => {
      const sp = item.spaceId ? study.space(item.spaceId) : null;
      const chat = item.source && item.source.chatId && typeof appState !== 'undefined' && (appState.chats || []).find((c) => c.id === item.source.chatId);
      return '<li><span class="study-mem-text">' + esc(item.text) + '<small>' + (sp ? esc(sp.name) + ' · ' : '') + (chat ? 'de <a href="?c=' + esc(chat.id) + '" data-study="open-chat" data-chat="' + esc(chat.id) + '">' + esc(chat.title || 'un chat') + '</a> · ' : '') + esc(fmtDate(String(item.updatedAt).slice(0, 10), { day: 'numeric', month: 'short' })) + '</small></span>' +
        '<button type="button" class="study-icon" data-study="forget" data-id="' + esc(item.id) + '" aria-label="Olvidar" title="Olvidar">' + ICON.close + '</button></li>';
    }).join('') + '</ul></section>').join('') + form;
  }

  function renderErrors() {
    const study = S();
    const costly = study.costlyMistakes('', 6);
    const recent = study.mistakes('').slice(0, 30);
    if (!recent.length) return '<div class="study-hero"><h2>Sin errores apuntados</h2><p>Cuando practiques en un chat de una asignatura, cada fallo se apunta con su causa. Aquí verás los que más te cuestan, para atacarlos primero.</p></div>';
    return '<article class="study-card warm"><header class="study-card-head"><b>Los que más te cuestan</b></header><ol class="study-errors">' +
      costly.map((m) => { const sp = study.space(m.spaceId); return '<li><span class="study-err-text"><b>' + esc(m.topic || 'Sin tema') + '</b>' + (m.type ? ' · ' + esc(m.type) : '') + (m.cause ? ' · ' + esc(m.cause) : '') + (sp ? '<small>' + esc(sp.name) + '</small>' : '') + '</span><span class="study-count" title="Veces">×' + m.count + '</span></li>'; }).join('') +
      '</ol><button type="button" class="study-btn small" data-study="warmup">' + ICON.play + 'Calentamiento de 3 min</button></article>' +
      '<section class="study-mem-group"><h3>Últimos</h3><ul class="study-mem">' + recent.map((m) => '<li><span class="study-mem-text">' + esc(m.topic || '') + (m.cause ? ': ' + esc(m.cause) : '') + '<small>' + esc(fmtDate(String(m.at).slice(0, 10), { day: 'numeric', month: 'short' })) + '</small></span></li>').join('') + '</ul></section>';
  }

  function render() {
    if (!view.open || !S()) return;
    const el = root();
    const body = view.tab === 'asignaturas' ? renderSpaces() : view.tab === 'memoria' ? renderMemory() : view.tab === 'errores' ? renderErrors() : renderToday();
    const scroll = el.querySelector('.study-body');
    const top = scroll ? scroll.scrollTop : 0;
    el.innerHTML = '<header class="study-top"><button type="button" class="study-back" data-study="close">' + ICON.back + '<span>Chats</span></button><h1>Estudio</h1><span aria-hidden="true"></span></header>' +
      '<nav class="study-tabs" role="tablist">' + TABS.map(([id, label]) => '<button type="button" role="tab" class="study-tab" aria-selected="' + (view.tab === id ? 'true' : 'false') + '" data-study="tab" data-tab="' + id + '">' + esc(label) + '</button>').join('') + '</nav>' +
      '<div class="study-body"><div class="study-inner">' + body + '</div></div>';
    const next = el.querySelector('.study-body');
    if (next && top) next.scrollTop = top;
  }

  /* ─── Acciones ──────────────────────────────────────────────────── */

  function taskFor(sp, topic, kind) {
    if (kind === 'simulacro') return 'Simulacro de examen de ' + sp.name + ': mira primero study_overview y hazme un examen con el reparto de pesos de los temas, como el día del examen (una pregunta cada vez, sin pistas ni soluciones hasta que entregue). Al final corrígelo, dime en qué paso fallé en cada pregunta y registra cada resultado con study_result.';
    if (kind === 'repaso') return 'Repaso de «' + topic.name + '» (' + sp.name + '): hazme 4 preguntas de recuerdo, una a una, sin darme la respuesta hasta que conteste. Registra cada resultado con study_result y, si fallo, explícame justo lo que me falta.';
    if (kind === 'estudio') return 'Vamos a estudiar «' + topic.name + '» (' + sp.name + '). Parte de lo que ya sé (study_overview y mis errores), explícamelo paso a paso con un ejemplo y termina con 3 preguntas para comprobar que lo he entendido; registra cada respuesta con study_result.';
    return '';
  }

  function start(spaceId, topicId, kind) {
    const study = S();
    const sp = study.space(spaceId);
    if (!sp) return;
    const topic = (sp.topics || []).find((t) => t.id === topicId) || null;
    const text = kind === 'chat' ? '' : taskFor(sp, topic || { name: '' }, kind);
    close();
    if (typeof window.startStudyChat === 'function') window.startStudyChat(sp.id, text);
  }

  function warmup() {
    close();
    if (typeof window.startStudyChat === 'function') window.startStudyChat('', 'Calentamiento de 3 minutos: mira mis errores más caros con study_overview y ponme 3 ejercicios cortos que ataquen justo esos fallos, uno a uno. Registra cada resultado con study_result.');
  }

  function onClick(event) {
    const button = event.target.closest('[data-study]');
    if (!button) return;
    const action = button.dataset.study;
    const study = S();
    if (action === 'open-chat') {
      event.preventDefault();
      close();
      if (typeof window.inhouseLearnOpenChat === 'function') window.inhouseLearnOpenChat(button.dataset.chat);
      return;
    }
    if (action === 'close') return close();
    if (action === 'tab') return setTab(button.dataset.tab);
    if (action === 'new-space') { view.tab = 'asignaturas'; view.editing = 'new'; return render(); }
    if (action === 'edit') { view.editing = button.dataset.space; return render(); }
    if (action === 'cancel') { view.editing = null; return render(); }
    if (action === 'delete-space') {
      const sp = study.space(button.dataset.space);
      const ask = typeof confirmDialog === 'function' ? confirmDialog({ title: 'Borrar asignatura', message: 'Se borra «' + (sp ? sp.name : '') + '» con su plan y su progreso. Sus chats se quedan.', confirmText: 'Borrar', cancelText: 'Cancelar', danger: true }) : Promise.resolve(true);
      return ask.then((ok) => { if (ok) { study.removeSpace(button.dataset.space); view.editing = null; render(); } });
    }
    if (action === 'done') {
      const today = study.dayKey(Date.now());
      const was = button.getAttribute('aria-checked') === 'true';
      study.markDone(button.dataset.space, today, button.dataset.topic, button.dataset.kind, !was);
      if (typeof haptic === 'function') haptic(was ? 'light' : 'success');
      return render();
    }
    if (action === 'start') return start(button.dataset.space, button.dataset.topic, button.dataset.kind);
    if (action === 'warmup') return warmup();
    if (action === 'forget') { study.forget(button.dataset.id); return render(); }
  }

  function onChange() {}

  function onSubmit(event) {
    const form = event.target;
    event.preventDefault();
    const study = S();
    if (form.hasAttribute('data-study-memory')) {
      const text = form.elements.text.value.trim();
      if (text) study.remember({ text, kind: 'dato', source: null });
      return render();
    }
    if (form.hasAttribute('data-study-form')) {
      const topics = form.elements.topics.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const match = /^(.*?)\s*[·:|-]\s*(\d+(?:[.,]\d+)?)\s*$/.exec(line);
        return match ? { name: match[1].trim(), weight: Number(match[2].replace(',', '.')) } : { name: line, weight: 1 };
      });
      try {
        study.saveSpace({ id: form.dataset.studyForm || undefined, name: form.elements.name.value, examDate: form.elements.examDate.value, hoursWeek: Number(form.elements.hoursWeek.value), topics, rules: form.elements.rules.value });
        view.editing = null;
        render();
      } catch (error) {
        form.elements.name.setCustomValidity(error.message);
        form.reportValidity();
        form.elements.name.setCustomValidity('');
      }
    }
  }

  // The sidebar button says what is left today.
  function refreshButton() {
    const btn = document.getElementById('study-btn');
    const sub = document.getElementById('study-btn-sub');
    if (!btn || !sub || !S()) return;
    const days = S().today();
    const pending = days.flatMap((d) => d.items).filter((item) => !item.done);
    sub.textContent = !days.length ? 'Plan, repasos y lo que sé de ti' : pending.length ? 'Hoy: ' + pending.length + ' · ' + pending.reduce((sum, item) => sum + item.minutes, 0) + ' min' : 'Hoy ya está hecho';
    btn.classList.toggle('has-today', pending.length > 0);
  }

  function boot() {
    const btn = document.getElementById('study-btn');
    if (btn) btn.addEventListener('click', () => open());
    if (S()) S().onChange(() => { refreshButton(); if (view.open && !view.editing) render(); });
    refreshButton();
    setInterval(refreshButton, 60000);
  }

  window.InhouseStudyView = { open, close, render, refreshButton, get isOpen() { return view.open; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
