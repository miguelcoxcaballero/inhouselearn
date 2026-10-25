/* Estudio (InhouseStudy): lo que sirve entre chats para estudiar de verdad.
   - Asignaturas: nombre, fecha de examen, horas por semana y temas con su peso;
     cada tema guarda su dominio (0-1) y cuándo se vio por última vez.
   - Memoria: lo que el modelo sabe del usuario (objetivos, preferencias,
     datos, cómo aprende), siempre visible y borrable en «Lo que sé de ti».
   - Errores: cada fallo con su tema, tipo y causa; los más caros primero.
   - Plan: del día de hoy al examen, con sesiones de estudio y repasos
     espaciados (1, 3, 7, 14 días) dentro de las horas del usuario. Se calcula
     siempre de nuevo a partir del estado, así que un día perdido se reparte solo.
   - Lagunas: temas ordenados por peso × lo que falta por dominar.
   - Hoy: lo que toca hoy en todas las asignaturas.
   - recall: búsqueda (BM25) en todos los mensajes de todos los chats.
   El modelo nunca decide el estado: informa de resultados (acertó / falló) y
   la app calcula el dominio. Todo vive en este navegador (localStorage
   `inhouse-learn-study`) y en study.json de la carpeta de Drive, mezclado por
   elemento (gana el más reciente; lo borrado queda marcado). */
(function () {
  const KEY = 'inhouse-learn-study';
  const DRIVE_PROPS = { inhouseLearn: 'study' };
  const DAY = 86400000;
  const DECAY_DAYS = 21;
  const REVIEW_GAPS = [1, 3, 7, 14, 30];
  const SESSION_MIN = 25;
  const COLORS = ['#E07A3C', '#2F7D6D', '#3B6FB6', '#9B4FB3', '#C2410C', '#4D7C0F', '#B4536A', '#0E7490'];
  const listeners = new Set();
  let drive = null;
  let driveId = '';
  let pushTimer = 0;
  let pulledAt = 0;

  const nowIso = () => new Date().toISOString();
  const uid = (prefix) => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  const dayKey = (date) => { const d = new Date(date); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const startOfDay = (date) => { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; };
  const norm = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

  function empty() { return { v: 1, spaces: [], memory: [], mistakes: [], done: [], frozen: [], updatedAt: '' }; }

  function read() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (data && data.v === 1) return Object.assign(empty(), data);
    } catch (_) {}
    return empty();
  }

  let state = read();

  function write(options) {
    state.updatedAt = nowIso();
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (error) { console.warn('Estudio: no se pudo guardar.', error); }
    listeners.forEach((fn) => { try { fn(state); } catch (_) {} });
    if (!(options && options.local)) schedulePush();
  }

  const alive = (list) => list.filter((item) => item && !item.deleted);

  /* ─── Drive ─────────────────────────────────────────────────────── */

  function mergeLists(mine, theirs) {
    const byId = new Map();
    (mine || []).forEach((item) => item && item.id && byId.set(item.id, item));
    (theirs || []).forEach((item) => {
      if (!item || !item.id) return;
      const local = byId.get(item.id);
      if (!local || String(item.updatedAt || '') > String(local.updatedAt || '')) byId.set(item.id, item);
    });
    return Array.from(byId.values());
  }

  function merge(remote) {
    if (!remote || remote.v !== 1) return false;
    const before = JSON.stringify(state);
    ['spaces', 'memory', 'mistakes', 'done', 'frozen'].forEach((key) => { state[key] = mergeLists(state[key], remote[key]); });
    if (JSON.stringify(state) === before) return false;
    write({ local: true });
    return true;
  }

  async function pull() {
    if (!drive) return false;
    try {
      const files = await drive.list(DRIVE_PROPS);
      if (!files.length) return false;
      files.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      driveId = files[0].id;
      let changed = false;
      for (const file of files) {
        const text = await drive.download(file.id);
        try { changed = merge(JSON.parse(text)) || changed; } catch (_) {}
      }
      pulledAt = Date.now();
      return changed;
    } catch (error) {
      console.warn('Estudio: no se pudo leer de Drive.', error);
      return false;
    }
  }

  function schedulePush() {
    if (!drive) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 1500);
  }

  async function push() {
    if (!drive) return;
    try {
      if (!driveId && !pulledAt) await pull();
      driveId = (await drive.upload('study.json', JSON.stringify(state), DRIVE_PROPS, driveId || undefined)) || driveId;
    } catch (error) {
      console.warn('Estudio: no se pudo guardar en Drive.', error);
    }
  }

  /* ─── Asignaturas y temas ───────────────────────────────────────── */

  function spaces() { return alive(state.spaces); }
  function space(id) { return spaces().find((item) => item.id === id) || null; }
  function spaceOfChat(chatId) { return spaces().find((item) => (item.chatIds || []).includes(chatId)) || null; }
  function findSpace(ref) {
    if (!ref) return null;
    const key = norm(ref);
    return space(ref) || spaces().find((item) => norm(item.name) === key) || spaces().find((item) => norm(item.name).includes(key)) || null;
  }

  // { name, examDate 'YYYY-MM-DD', hoursWeek, topics: [{ name, weight }] }; the
  // topics keep their mastery when they keep their name.
  function saveSpace(input) {
    const now = nowIso();
    const existing = input.id ? state.spaces.find((item) => item.id === input.id) : findSpace(input.name);
    const target = existing || { id: uid('sp'), createdAt: now, chatIds: [], color: COLORS[spaces().length % COLORS.length], topics: [] };
    if (typeof input.name === 'string' && input.name.trim()) target.name = input.name.trim().slice(0, 80);
    if (!target.name) throw new Error('La asignatura necesita un nombre.');
    if (input.examDate !== undefined) target.examDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.examDate || '')) ? input.examDate : '';
    if (input.hoursWeek !== undefined) target.hoursWeek = Math.max(0.5, Math.min(80, Number(input.hoursWeek) || 4));
    if (!target.hoursWeek) target.hoursWeek = 4;
    if (typeof input.rules === 'string') target.rules = input.rules.slice(0, 2000);
    if (typeof input.color === 'string' && input.color) target.color = input.color;
    if (Array.isArray(input.topics)) {
      const old = new Map((target.topics || []).map((topic) => [norm(topic.name), topic]));
      target.topics = input.topics.map((topic) => (typeof topic === 'string' ? { name: topic } : topic))
        .filter((topic) => topic && String(topic.name || '').trim()).slice(0, 60).map((topic) => {
          const before = old.get(norm(topic.name));
          return {
            id: before ? before.id : uid('tp'),
            name: String(topic.name).trim().slice(0, 100),
            weight: Math.max(0.1, Math.min(10, Number(topic.weight) || (before && before.weight) || 1)),
            mastery: before ? before.mastery : 0,
            seenAt: before ? before.seenAt : '',
            results: before ? before.results : []
          };
        });
    }
    target.updatedAt = now;
    if (!existing) state.spaces.push(target);
    // New topics, hours or date: today's list is made again.
    state.frozen = (state.frozen || []).filter((item) => !item.id.startsWith(target.id + '|'));
    write();
    return target;
  }

  function removeSpace(id) {
    const target = state.spaces.find((item) => item.id === id);
    if (!target) return false;
    target.deleted = true;
    target.updatedAt = nowIso();
    write();
    return true;
  }

  function linkChat(spaceId, chatId) {
    let changed = false;
    state.spaces.forEach((item) => {
      const has = (item.chatIds || []).includes(chatId);
      if (item.id === spaceId && !has) { item.chatIds = (item.chatIds || []).concat(chatId); item.updatedAt = nowIso(); changed = true; }
      if (item.id !== spaceId && has) { item.chatIds = item.chatIds.filter((id) => id !== chatId); item.updatedAt = nowIso(); changed = true; }
    });
    if (changed) write();
  }

  function findTopic(sp, ref) {
    if (!sp) return null;
    const key = norm(ref);
    return (sp.topics || []).find((topic) => topic.id === ref || norm(topic.name) === key) ||
      (sp.topics || []).find((topic) => norm(topic.name).includes(key) || key.includes(norm(topic.name))) || null;
  }

  // What the topic is worth today: what was mastered fades without practice.
  function effectiveMastery(topic, now) {
    if (!topic || !topic.seenAt) return 0;
    const days = Math.max(0, ((now || Date.now()) - Date.parse(topic.seenAt)) / DAY);
    return clamp01(topic.mastery) * Math.exp(-days / DECAY_DAYS);
  }

  function band(topic, now) {
    if (!topic.seenAt) return 'sin tocar';
    const m = effectiveMastery(topic, now);
    return m >= 0.7 ? 'sólido' : m >= 0.4 ? 'en camino' : 'frágil';
  }

  // A result from practice: correct answers raise the mastery, mistakes lower
  // it (exponential average); seen today either way.
  function recordResult(spaceRef, topicRef, correct, note) {
    const sp = findSpace(spaceRef);
    if (!sp) throw new Error('No existe la asignatura «' + spaceRef + '».');
    const topic = findTopic(sp, topicRef);
    if (!topic) throw new Error('«' + topicRef + '» no es un tema de ' + sp.name + ' (temas: ' + (sp.topics || []).map((t) => t.name).join(', ') + ').');
    const base = effectiveMastery(topic);
    topic.mastery = clamp01(base + (correct ? 0.25 * (1 - base) : -0.3 * base));
    topic.seenAt = nowIso();
    topic.results = (topic.results || []).concat({ at: topic.seenAt, ok: !!correct }).slice(-40);
    sp.updatedAt = topic.seenAt;
    write();
    if (!correct && note) logMistake({ space: sp.id, topic: topic.name, cause: note });
    return { space: sp, topic, mastery: topic.mastery };
  }

  /* ─── Memoria y errores ─────────────────────────────────────────── */

  const MEMORY_KINDS = ['objetivo', 'preferencia', 'dato', 'aprendizaje'];

  function memory(spaceId) {
    return alive(state.memory).filter((item) => !spaceId || !item.spaceId || item.spaceId === spaceId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function remember(input) {
    const text = String(input.text || '').trim().slice(0, 300);
    if (!text) throw new Error('Falta qué recordar.');
    const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : 'dato';
    const now = nowIso();
    const same = alive(state.memory).find((item) => norm(item.text) === norm(text));
    const item = same || { id: uid('mem'), createdAt: now };
    Object.assign(item, { text, kind, spaceId: input.spaceId || item.spaceId || '', source: input.source || item.source || null, updatedAt: now });
    if (!same) state.memory.push(item);
    write();
    return item;
  }

  function forget(ref) {
    const key = norm(ref);
    const item = alive(state.memory).find((entry) => entry.id === ref) || alive(state.memory).find((entry) => norm(entry.text).includes(key));
    if (!item) return null;
    item.deleted = true;
    item.updatedAt = nowIso();
    write();
    return item;
  }

  function logMistake(input) {
    const sp = findSpace(input.space);
    const topic = sp ? findTopic(sp, input.topic) : null;
    const now = nowIso();
    const item = {
      id: uid('err'), at: now, updatedAt: now,
      spaceId: sp ? sp.id : '', topic: topic ? topic.name : String(input.topic || '').trim().slice(0, 100),
      type: String(input.type || '').trim().slice(0, 60), cause: String(input.cause || '').trim().slice(0, 300),
      chatId: input.chatId || ''
    };
    if (!item.topic && !item.cause) throw new Error('Di al menos el tema o la causa del error.');
    state.mistakes.push(item);
    if (state.mistakes.length > 600) state.mistakes = state.mistakes.slice(-600);
    write();
    return item;
  }

  function mistakes(spaceId) {
    return alive(state.mistakes).filter((item) => !spaceId || item.spaceId === spaceId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  // The most expensive mistakes: how often × how recent × the topic's weight.
  function costlyMistakes(spaceId, limit) {
    const groups = new Map();
    mistakes(spaceId).forEach((item) => {
      const key = item.spaceId + '|' + norm(item.topic) + '|' + norm(item.type || item.cause).slice(0, 40);
      const sp = space(item.spaceId);
      const topic = sp ? findTopic(sp, item.topic) : null;
      const age = (Date.now() - Date.parse(item.at)) / DAY;
      const entry = groups.get(key) || { topic: item.topic, type: item.type, cause: item.cause, spaceId: item.spaceId, count: 0, score: 0, last: item.at };
      entry.count++;
      entry.score += Math.exp(-age / 30) * (topic ? topic.weight : 1);
      if (item.at > entry.last) entry.last = item.at;
      groups.set(key, entry);
    });
    return Array.from(groups.values()).sort((a, b) => b.score - a.score).slice(0, limit || 5);
  }

  /* ─── Lagunas y plan ────────────────────────────────────────────── */

  function daysToExam(sp, now) {
    if (!sp || !sp.examDate) return null;
    return Math.round((startOfDay(sp.examDate + 'T00:00:00') - startOfDay(now || Date.now())) / DAY);
  }

  function gaps(sp, now) {
    const total = (sp.topics || []).reduce((sum, topic) => sum + topic.weight, 0) || 1;
    return (sp.topics || []).map((topic) => {
      const m = effectiveMastery(topic, now);
      return { topic, mastery: m, band: band(topic, now), share: topic.weight / total, priority: (topic.weight / total) * (1 - m) * (topic.seenAt ? 1 : 1.15) };
    }).sort((a, b) => b.priority - a.priority);
  }

  const doneKey = (spaceId, date, topicId, kind) => spaceId + '|' + date + '|' + topicId + '|' + kind;
  function isDone(spaceId, date, topicId, kind) {
    const key = doneKey(spaceId, date, topicId, kind);
    return alive(state.done).some((item) => item.id === key);
  }

  function markDone(spaceId, date, topicId, kind, value) {
    const key = doneKey(spaceId, date, topicId, kind);
    const existing = state.done.find((item) => item.id === key);
    if (value === false) {
      if (existing && !existing.deleted) { existing.deleted = true; existing.updatedAt = nowIso(); write(); }
      return;
    }
    if (existing && !existing.deleted) return;
    if (existing) { existing.deleted = false; existing.updatedAt = nowIso(); } else state.done.push({ id: key, updatedAt: nowIso() });
    const sp = space(spaceId);
    const topic = sp && (sp.topics || []).find((t) => t.id === topicId);
    // A session done counts as practice: seen today, a small step up.
    if (topic && kind !== 'simulacro') {
      const base = effectiveMastery(topic);
      topic.mastery = clamp01(base + (kind === 'estudio' ? 0.2 : 0.1) * (1 - base));
      topic.seenAt = nowIso();
      sp.updatedAt = topic.seenAt;
    }
    write();
  }

  // From today to the exam: each topic gets study sessions by what is missing
  // and its weight, the most urgent first, then reviews 1, 3, 7, 14 and 30
  // days later; the day before the exam is for a mock exam. Never more than the
  // day's minutes (hours per week / 7). Without an exam date: the next 14 days.
  function plan(sp, options) {
    const now = (options && options.now) || Date.now();
    const today = startOfDay(now);
    const left = daysToExam(sp, now);
    const horizon = left === null ? 14 : Math.max(0, left);
    const perDay = Math.max(SESSION_MIN, Math.round((sp.hoursWeek || 4) * 60 / 7));
    const days = [];
    for (let i = 0; i <= Math.min(horizon, 180); i++) {
      const date = new Date(today.getTime() + i * DAY);
      days.push({ date: dayKey(date), offset: i, minutes: 0, items: [], exam: left !== null && i === left });
    }
    if (!days.length) return { days, perDay, left };
    const usable = left === null ? days : days.filter((day) => day.offset < left);
    // Very little time a day: one short review may go over it (better than none).
    const fits = (day, minutes) => day.minutes + minutes <= perDay + (perDay < 40 && minutes <= 10 ? 10 : 0) || !day.items.length;
    // With time to spare, study leaves ~20 minutes a day for the reviews.
    const studyCap = left !== null && left < 10 ? perDay : Math.max(SESSION_MIN, perDay - 20);
    const fitsStudy = (day) => day.minutes + SESSION_MIN <= studyCap || !day.items.length;
    const put = (day, item) => { day.items.push(item); day.minutes += item.minutes; };
    // Mock exam the day before (or the only day left).
    if (left !== null && left >= 1) put(days[left - 1], { kind: 'simulacro', topicId: '', topic: 'Simulacro de examen', minutes: Math.min(perDay, 60) });
    const order = gaps(sp, now);
    // Study sessions interleaved: round after round, each topic (most urgent
    // first) takes the earliest day after its previous session that has room,
    // so days mix topics instead of one topic for days on end.
    const need = order.map((gap) => Math.max(gap.topic.seenAt ? 0 : 1, Math.round((1 - gap.mastery) * (1 + gap.share * order.length) * 1.5)));
    const next = order.map(() => 0);
    const first = order.map(() => -1);
    for (let round = 0; need.some((n, i) => n > round); round++) {
      order.forEach((gap, index) => {
        if (need[index] <= round) return;
        for (let i = next[index]; i < usable.length; i++) {
          const day = usable[i];
          if (day.items.some((item) => item.topicId === gap.topic.id) || !fitsStudy(day)) continue;
          put(day, { kind: 'estudio', topicId: gap.topic.id, topic: gap.topic.name, minutes: SESSION_MIN });
          if (first[index] < 0) first[index] = i;
          next[index] = i + 1;
          return;
        }
        need[index] = round; // no room left before the exam
      });
    }
    // Then the reviews, 1, 3, 7, 14 and 30 days after the first session (or
    // after the last time a topic already started was seen).
    order.forEach((gap, index) => {
      const anchor = first[index] >= 0 ? first[index] : gap.topic.seenAt ? Math.round((startOfDay(gap.topic.seenAt) - today) / DAY) : null;
      if (anchor === null) return;
      REVIEW_GAPS.forEach((step) => {
        let i = anchor + step;
        if (i < 0) return;
        while (i < usable.length && (!fits(usable[i], 10) || usable[i].items.some((item) => item.topicId === gap.topic.id))) i++;
        if (i < usable.length) put(usable[i], { kind: 'repaso', topicId: gap.topic.id, topic: gap.topic.name, minutes: 10 });
      });
    });
    // Free days before an exam: a short review of what is weakest that day.
    if (left !== null && order.length) {
      usable.forEach((day, index) => {
        if (day.items.length || index === 0) return;
        const pick = order.find((gap) => !usable.slice(Math.max(0, index - 1), index + 2).some((other) => other.items.some((item) => item.topicId === gap.topic.id)) && gap.mastery < 0.85) || null;
        if (pick) put(day, { kind: 'repaso', topicId: pick.topic.id, topic: pick.topic.name, minutes: 15 });
      });
    }
    // Today's list stays as it was first made today (marking one done or a
    // result in a chat must not reshuffle what the user is looking at).
    if (days[0] && !(options && options.fresh)) {
      const id = sp.id + '|' + days[0].date;
      const frozen = (state.frozen || []).find((item) => item.id === id);
      if (frozen) {
        days[0].items = frozen.items.map((item) => Object.assign({}, item));
        days[0].minutes = days[0].items.reduce((sum, item) => sum + item.minutes, 0);
      } else if (!(options && options.now)) {
        state.frozen = (state.frozen || []).filter((item) => !item.id.startsWith(sp.id + '|') || item.id.slice(-10) >= dayKey(Date.now() - 7 * DAY));
        state.frozen.push({ id, items: days[0].items.map((item) => ({ kind: item.kind, topicId: item.topicId, topic: item.topic, minutes: item.minutes })), updatedAt: nowIso() });
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
        schedulePush();
      }
    }
    days.forEach((day) => day.items.forEach((item) => { item.done = isDone(sp.id, day.date, item.topicId, item.kind); }));
    return { days, perDay, left };
  }

  // Everything due today, every subject.
  function today(now) {
    const key = dayKey(now || Date.now());
    return spaces().map((sp) => {
      const p = plan(sp, { now });
      const day = p.days.find((d) => d.date === key) || { items: [], minutes: 0 };
      return { space: sp, left: p.left, items: day.items, minutes: day.minutes, gaps: gaps(sp, now).slice(0, 6) };
    });
  }

  /* ─── Recall: búsqueda en todos los chats ───────────────────────── */

  const STOP = new Set('a al algo con de del el ella ellos en es esa ese eso esta este esto fue ha hay la las le lo los mas me mi muy no nos o para pero por que se si sin sobre su sus te tu un una uno y ya the of and to in is it for on with'.split(' '));
  const terms = (text) => norm(text).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter((word) => word.length > 1 && !STOP.has(word));

  // chats: [{ id, title, messages: [{ id, role, content, createdAt }] }]
  function recall(chats, query, options) {
    const q = terms(query);
    if (!q.length) return [];
    const docs = [];
    (chats || []).forEach((chat) => (chat.messages || []).forEach((message) => {
      const text = String(message.content || '');
      if (!text.trim() || (options && options.exclude === chat.id)) return;
      // Long answers are split in pieces so a hit points to the right part.
      for (let i = 0; i < text.length; i += 1200) {
        const part = text.slice(i, i + 1400);
        docs.push({ chat, message, part, words: terms(part) });
      }
    }));
    if (!docs.length) return [];
    const avg = docs.reduce((sum, doc) => sum + doc.words.length, 0) / docs.length || 1;
    const df = new Map();
    docs.forEach((doc) => new Set(doc.words).forEach((word) => df.set(word, (df.get(word) || 0) + 1)));
    const scored = docs.map((doc) => {
      const tf = new Map();
      doc.words.forEach((word) => tf.set(word, (tf.get(word) || 0) + 1));
      let score = 0;
      q.forEach((word) => {
        const f = tf.get(word) || 0;
        if (!f) return;
        const idf = Math.log(1 + (docs.length - df.get(word) + 0.5) / (df.get(word) + 0.5));
        score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * doc.words.length / avg));
      });
      return { doc, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    const seen = new Set();
    const out = [];
    for (const { doc, score } of scored) {
      const key = doc.chat.id + '|' + doc.message.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const lower = norm(doc.part);
      const at = Math.max(0, Math.min(...q.map((word) => { const i = lower.indexOf(word); return i < 0 ? Infinity : i; })) - 160);
      out.push({ chatId: doc.chat.id, title: doc.chat.title || 'Chat', messageId: doc.message.id, role: doc.message.role, date: doc.message.createdAt || '', score: Math.round(score * 100) / 100, snippet: (at > 0 ? '…' : '') + doc.part.slice(Number.isFinite(at) ? at : 0, (Number.isFinite(at) ? at : 0) + 420).replace(/\s+/g, ' ').trim() + '…' });
      if (out.length >= ((options && options.limit) || 6)) break;
    }
    return out;
  }

  /* ─── Lo que el modelo lee al empezar ───────────────────────────── */

  // A short brief (a few hundred characters): what it knows of the user and,
  // in a subject's chat, where they stand and what is due today.
  function brief(chatId) {
    const sp = chatId ? spaceOfChat(chatId) : null;
    const lines = [];
    const mem = memory(sp && sp.id).slice(0, 14);
    if (mem.length) lines.push('Lo que sabes del usuario (memoria; ids para memory_forget): ' + mem.map((item) => '[' + item.id.slice(-5) + '] (' + item.kind + ') ' + item.text).join(' · '));
    if (sp) {
      const left = daysToExam(sp);
      const g = gaps(sp);
      const day = today().find((entry) => entry.space.id === sp.id);
      lines.push('Este chat es de la asignatura «' + sp.name + '»' + (left !== null ? ' · examen el ' + sp.examDate + ' (' + (left >= 0 ? 'faltan ' + left + ' días' : 'ya pasó') + ')' : '') + ' · ' + sp.hoursWeek + ' h/semana.' +
        (g.length ? ' Temas (peso · estado): ' + g.slice(0, 12).map((x) => x.topic.name + ' ' + x.topic.weight + ' · ' + x.band).join('; ') + '.' : '') +
        (day && day.items.length ? ' Hoy toca: ' + day.items.map((item) => item.kind + ' ' + item.topic + (item.done ? ' (hecho)' : '')).join(', ') + '.' : '') +
        (sp.rules ? ' Reglas del usuario para esta asignatura: ' + sp.rules : ''));
      const costly = costlyMistakes(sp.id, 3);
      if (costly.length) lines.push('Sus errores más caros: ' + costly.map((m) => m.topic + (m.type ? ' (' + m.type + ')' : '') + (m.cause ? ': ' + m.cause : '') + ' ×' + m.count).join(' · ') + '.');
    } else if (spaces().length) {
      lines.push('Asignaturas del usuario: ' + spaces().map((s) => s.name + (s.examDate ? ' (examen ' + s.examDate + ')' : '')).join(', ') + '.');
    }
    return lines.join('\n');
  }

  window.InhouseStudy = {
    get state() { return state; },
    configureDrive: (adapter) => { drive = adapter || null; },
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    pull, push, merge,
    spaces, space, findSpace, saveSpace, removeSpace, linkChat, spaceOfChat, findTopic,
    effectiveMastery, band, recordResult, gaps, plan, today, daysToExam, markDone, isDone,
    memory, remember, forget, MEMORY_KINDS,
    logMistake, mistakes, costlyMistakes,
    recall, brief, dayKey,
    _reset: () => { state = empty(); write({ local: true }); }
  };
})();
