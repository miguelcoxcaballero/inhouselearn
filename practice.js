/* ─── Practice visuals ───────────────────────────────────────────────
   Six more ```visual types where the student does something, not just
   reads: match (pairs), order (steps in sequence), categorize (items into
   groups), fill (blanks in a text), estimate (guess a number with a slider)
   and truefalse (a quick round). The model writes the right answer in the
   natural place (pairs side by side, steps in order, the right word first in
   a blank); the card shuffles with a seed taken from the spec, so it looks
   the same on every redraw and never gives the answer away by position.
   Progress lives in vizState like the other cards.

   Loaded after visuals.js; registers its renderers there. */

function practiceMark(ok) {
  if (typeof haptic === 'function') haptic(ok ? 'success' : 'error');
}

function practiceDone(text) {
  return '<div class="px-done">' + text + '</div>';
}

/* ─── match ── */

function vizMatch(spec, state) {
  const pairs = (Array.isArray(spec.pairs) ? spec.pairs : []).filter((pair) => pair && pair.left != null && pair.right != null).slice(0, 8);
  if (pairs.length < 2) return null;
  const right = vizShuffle(pairs.map((_, k) => k), JSON.stringify(spec), true);
  if (!state.matched) state.matched = {};
  if (state.misses == null) state.misses = 0;
  const el = vizElement('<div class="viz viz-practice viz-match">' + vizHead('match', spec.title || 'Empareja', '<span class="viz-count"></span>') +
    '<div class="px-hint">Toca uno de la izquierda y después su pareja.</div>' +
    '<div class="px-match"><div class="px-col">' + pairs.map((pair, k) => '<button type="button" class="px-item" data-side="l" data-k="' + k + '">' + vizInline(pair.left) + '</button>').join('') + '</div>' +
    '<div class="px-col">' + right.map((k) => '<button type="button" class="px-item" data-side="r" data-k="' + k + '">' + vizInline(pairs[k].right) + '</button>').join('') + '</div></div>' +
    '<div class="px-result"></div></div>');
  let selected = null;
  const update = () => interactiveUpdate(el, () => {
    const done = Object.keys(state.matched).length;
    el.querySelectorAll('.px-item').forEach((button) => {
      const k = Number(button.dataset.k);
      const matched = state.matched[k] != null;
      button.classList.toggle('matched', matched);
      button.style.setProperty('--c', matched ? VIZ_COLORS[Object.keys(state.matched).indexOf(String(k)) % VIZ_COLORS.length] : '');
      button.disabled = matched;
      button.classList.toggle('selected', !!selected && selected.side === button.dataset.side && selected.k === k);
    });
    el.querySelector('.viz-count').textContent = done + '/' + pairs.length;
    el.querySelector('.px-result').innerHTML = done === pairs.length ? practiceDone(state.misses ? '¡Hecho! Con ' + state.misses + (state.misses === 1 ? ' fallo.' : ' fallos.') : '¡Perfecto, sin fallos!') : '';
  });
  el.addEventListener('click', (event) => {
    const button = event.target.closest('.px-item');
    if (!button || button.disabled) return;
    const pick = { side: button.dataset.side, k: Number(button.dataset.k) };
    if (!selected || selected.side === pick.side) { selected = pick; update(); return; }
    if (selected.k === pick.k) { state.matched[pick.k] = true; practiceMark(true); }
    else {
      state.misses += 1;
      practiceMark(false);
      [button, el.querySelector('.px-item.selected')].forEach((node) => { if (node) { node.classList.add('wrong'); setTimeout(() => node.classList.remove('wrong'), 450); } });
    }
    selected = null;
    update();
  });
  update();
  return el;
}

/* ─── order ── */

function vizSequence(spec, state) {
  const items = (Array.isArray(spec.items) ? spec.items : []).map((item) => (typeof item === 'object' && item ? item.text : item)).filter((item) => item != null).slice(0, 10);
  if (items.length < 3) return null;
  if (!state.order) state.order = vizShuffle(items.map((_, k) => k), JSON.stringify(spec), true);
  const el = vizElement('<div class="viz viz-practice viz-order">' + vizHead('order', spec.title || 'Ordena') +
    '<div class="px-hint">' + escapeHtml(spec.hint || 'Ponlo en orden: usa las flechas o toca dos para intercambiarlos.') + '</div><ol class="px-list"></ol>' +
    '<div class="viz-foot"><button type="button" class="viz-btn ghost" data-px="solve">Ver solución</button><button type="button" class="viz-btn ok" data-px="check">Comprobar</button></div>' +
    '<div class="px-result"></div>' + (spec.explanation ? '<div class="px-expl">' + vizBlock(spec.explanation) + '</div>' : '') + '</div>');
  let picked = -1;
  const list = el.querySelector('.px-list');
  const render = () => interactiveUpdate(el, () => {
    list.innerHTML = state.order.map((k, pos) => '<li data-motion-key="order:' + k + '" class="px-row' + (state.checked ? (k === pos ? ' right' : ' wrong') : '') + (picked === pos ? ' selected' : '') + '">' +
      '<span class="px-pos">' + (pos + 1) + '</span><button type="button" class="px-text" data-swap="' + pos + '">' + vizInline(items[k]) + '</button>' +
      '<span class="px-arrows"><button type="button" class="px-arrow" data-move="' + pos + ':-1" aria-label="Subir"' + (pos === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button type="button" class="px-arrow" data-move="' + pos + ':1" aria-label="Bajar"' + (pos === state.order.length - 1 ? ' disabled' : '') + '>↓</button></span></li>').join('');
    if (window.renderMathInElement) enhanceRichContent(list, { renderMath: true, latexPreview: false });
    const all = state.order.every((k, pos) => k === pos);
    el.classList.toggle('solved', !!state.checked && all);
    el.querySelector('.px-result').innerHTML = state.checked ? practiceDone(all ? '¡Orden correcto!' : state.order.filter((k, pos) => k === pos).length + ' de ' + items.length + ' en su sitio. Mueve los rojos.') : '';
  });
  el.addEventListener('click', (event) => {
    const move = event.target.closest('[data-move]');
    const swap = event.target.closest('[data-swap]');
    const action = event.target.closest('[data-px]');
    if (move) {
      const [pos, dir] = move.dataset.move.split(':').map(Number);
      const order = state.order;
      [order[pos], order[pos + dir]] = [order[pos + dir], order[pos]];
      state.checked = false; picked = -1;
    } else if (swap) {
      const pos = Number(swap.dataset.swap);
      if (picked < 0) picked = pos;
      else { [state.order[picked], state.order[pos]] = [state.order[pos], state.order[picked]]; picked = -1; state.checked = false; }
    } else if (action) {
      if (action.dataset.px === 'solve') state.order = items.map((_, k) => k);
      state.checked = true;
      practiceMark(state.order.every((k, pos) => k === pos));
    } else return;
    render();
  });
  render();
  return el;
}

/* ─── categorize ── */

function vizCategorize(spec, state) {
  const categories = (Array.isArray(spec.categories) ? spec.categories : []).map(String).slice(0, 4);
  const items = (Array.isArray(spec.items) ? spec.items : []).filter((item) => item && item.text != null && Number.isInteger(Number(item.category)) && Number(item.category) < categories.length).slice(0, 16);
  if (categories.length < 2 || items.length < 3) return null;
  const pool = vizShuffle(items.map((_, k) => k), JSON.stringify(spec));
  if (!state.placed) state.placed = {};
  const el = vizElement('<div class="viz viz-practice viz-categorize">' + vizHead('categorize', spec.title || 'Clasifica', '<span class="viz-count"></span>') +
    '<div class="px-hint">Toca un elemento y luego su grupo.</div><div class="px-pool"></div>' +
    '<div class="px-buckets" style="--n:' + categories.length + '">' + categories.map((name, c) => '<div class="px-bucket" role="button" tabindex="0" aria-label="Grupo ' + escapeHtml(name) + '" data-cat="' + c + '" style="--c:' + VIZ_COLORS[c % VIZ_COLORS.length] + '"><b>' + vizInline(name) + '</b><span class="px-in"></span></div>').join('') + '</div>' +
    '<div class="viz-foot"><button type="button" class="viz-btn ghost" data-px="retry" hidden>Volver a intentar los fallos</button><button type="button" class="viz-btn ok" data-px="check">Comprobar</button></div><div class="px-result"></div></div>');
  let selected = -1;
  const chip = (k) => '<button type="button" class="px-chip' + (selected === k ? ' selected' : '') +
    (state.checked && state.placed[k] != null ? (state.placed[k] === Number(items[k].category) ? ' right' : ' wrong') : '') + '" data-item="' + k + '">' + vizInline(items[k].text) + '</button>';
  const render = () => interactiveUpdate(el, () => {
    const free = pool.filter((k) => state.placed[k] == null);
    el.querySelector('.px-pool').innerHTML = free.length ? free.map(chip).join('') : '<span class="px-empty">Todo colocado.</span>';
    el.querySelectorAll('.px-bucket').forEach((bucket) => {
      const c = Number(bucket.dataset.cat);
      bucket.querySelector('.px-in').innerHTML = pool.filter((k) => state.placed[k] === c).map(chip).join('');
    });
    enhanceRichContent(el.querySelector('.px-buckets'), { renderMath: true, latexPreview: false });
    enhanceRichContent(el.querySelector('.px-pool'), { renderMath: true, latexPreview: false });
    const placed = Object.keys(state.placed).length;
    el.querySelector('.viz-count').textContent = placed + '/' + items.length;
    const wrong = pool.filter((k) => state.placed[k] != null && state.placed[k] !== Number(items[k].category)).length;
    el.querySelector('[data-px="retry"]').hidden = !(state.checked && wrong);
    el.querySelector('.px-result').innerHTML = state.checked ? practiceDone(wrong ? wrong + (wrong === 1 ? ' mal colocado (en rojo).' : ' mal colocados (en rojo).') : placed === items.length ? '¡Todo bien clasificado!' : 'Lo colocado está bien; faltan ' + (items.length - placed) + '.') : '';
  });
  el.addEventListener('click', (event) => {
    const item = event.target.closest('[data-item]');
    const bucket = event.target.closest('.px-bucket');
    const action = event.target.closest('[data-px]');
    if (item) {
      // A placed item goes back to the tray, already picked up.
      const k = Number(item.dataset.item);
      if (state.placed[k] != null) { delete state.placed[k]; state.checked = false; selected = k; }
      else selected = selected === k ? -1 : k;
    } else if (bucket && selected >= 0) {
      state.placed[selected] = Number(bucket.dataset.cat);
      selected = -1;
      state.checked = false;
    } else if (action) {
      if (action.dataset.px === 'retry') pool.forEach((k) => { if (state.placed[k] != null && state.placed[k] !== Number(items[k].category)) delete state.placed[k]; });
      state.checked = action.dataset.px === 'check';
      if (state.checked) practiceMark(pool.every((k) => state.placed[k] == null || state.placed[k] === Number(items[k].category)) && Object.keys(state.placed).length === items.length);
    } else return;
    render();
  });
  el.addEventListener('keydown', (event) => {
    const bucket = event.target.closest('.px-bucket');
    if (bucket && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); bucket.click(); }
  });
  render();
  return el;
}

/* ─── fill ── */

// "La derivada de [[2x|x|2]] …": the first option of each blank is the right one.
function vizFill(spec, state) {
  const text = String(spec.text || '');
  const blanks = [];
  const marked = text.replace(/\[\[([^\]]+)\]\]/g, (match, inner) => {
    const options = inner.split('|').map((item) => item.trim()).filter(Boolean).slice(0, 6);
    if (!options.length) return match;
    blanks.push(options);
    return '\u0001' + (blanks.length - 1) + '\u0001';
  });
  if (!blanks.length) return null;
  if (!state.answers) state.answers = {};
  let html = vizBlock(marked);
  html = html.replace(/\u0001(\d+)\u0001/g, (match, k) => {
    const options = blanks[Number(k)];
    const shown = options.length > 1 ? vizShuffle(options, JSON.stringify(spec) + k) : options;
    return '<select class="px-blank" data-blank="' + k + '" aria-label="Hueco ' + (Number(k) + 1) + '"><option value="">…</option>' +
      shown.map((option) => '<option value="' + escapeHtml(option) + '">' + escapeHtml(option) + '</option>').join('') + '</select>';
  });
  const el = vizElement('<div class="viz viz-practice viz-fill">' + vizHead('fill', spec.title || 'Completa los huecos') + '<div class="px-text-block">' + html + '</div>' +
    '<div class="viz-foot"><button type="button" class="viz-btn ghost" data-px="solve">Ver solución</button><button type="button" class="viz-btn ok" data-px="check">Comprobar</button></div>' +
    '<div class="px-result"></div>' + (spec.explanation ? '<div class="px-expl">' + vizBlock(spec.explanation) + '</div>' : '') + '</div>');
  const selects = Array.from(el.querySelectorAll('select'));
  const render = () => interactiveUpdate(el, () => {
    selects.forEach((select) => {
      const k = Number(select.dataset.blank);
      select.value = state.answers[k] || '';
      select.classList.toggle('right', !!state.checked && state.answers[k] === blanks[k][0]);
      select.classList.toggle('wrong', !!state.checked && state.answers[k] !== blanks[k][0]);
    });
    const right = blanks.filter((options, k) => state.answers[k] === options[0]).length;
    el.classList.toggle('solved', !!state.checked && right === blanks.length);
    el.querySelector('.px-result').innerHTML = state.checked ? practiceDone(right === blanks.length ? '¡Todo correcto!' : right + ' de ' + blanks.length + ' bien.') : '';
  });
  el.addEventListener('change', (event) => {
    const select = event.target.closest('select');
    if (!select) return;
    state.answers[select.dataset.blank] = select.value;
    state.checked = false;
    render();
  });
  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-px]');
    if (!action) return;
    if (action.dataset.px === 'solve') blanks.forEach((options, k) => { state.answers[k] = options[0]; });
    state.checked = true;
    practiceMark(blanks.every((options, k) => state.answers[k] === options[0]));
    render();
  });
  render();
  return el;
}

/* ─── estimate ── */

function vizEstimate(spec, state) {
  const min = Number(spec.min), max = Number(spec.max), answer = Number(spec.answer);
  if (!isFinite(min) || !isFinite(max) || !(max > min) || !isFinite(answer)) return null;
  const step = Number(spec.step) > 0 ? Number(spec.step) : (max - min) / 100;
  const tolerance = Number(spec.tolerance) > 0 ? Number(spec.tolerance) : (max - min) * 0.05;
  const unit = spec.unit ? ' ' + String(spec.unit) : '';
  if (state.guess == null) state.guess = Math.round(((min + max) / 2) / step) * step;
  const pct = (value) => Math.max(0, Math.min(100, (value - min) / (max - min) * 100));
  const el = vizElement('<div class="viz viz-practice viz-estimate">' + vizHead('estimate', spec.title || '') +
    '<div class="viz-check-q">' + vizBlock(spec.question || '¿Cuánto crees que es?') + '</div>' +
    '<div class="px-guess"><b class="px-guess-value"></b></div>' +
    '<div class="px-track"><input type="range" min="' + min + '" max="' + max + '" step="' + step + '" aria-label="Tu estimación"><span class="px-real" hidden></span></div>' +
    '<div class="px-scale"><span>' + escapeHtml(vizFmt(min) + unit) + '</span><span>' + escapeHtml(vizFmt(max) + unit) + '</span></div>' +
    '<div class="viz-foot"><button type="button" class="viz-btn ghost" data-px="again" hidden>Otra vez</button><button type="button" class="viz-btn ok" data-px="lock">Fijar mi respuesta</button></div>' +
    '<div class="px-result"></div><div class="px-expl" hidden>' + vizBlock(spec.explanation || '') + '</div></div>');
  const input = el.querySelector('input');
  const render = () => interactiveUpdate(el, () => {
    input.value = state.guess;
    input.disabled = !!state.locked;
    el.querySelector('.px-guess-value').textContent = vizFmt(Number(state.guess)) + unit;
    const real = el.querySelector('.px-real');
    real.hidden = !state.locked;
    real.style.left = pct(answer) + '%';
    real.textContent = vizFmt(answer) + unit;
    el.querySelector('[data-px="lock"]').hidden = !!state.locked;
    el.querySelector('[data-px="again"]').hidden = !state.locked;
    el.querySelector('.px-expl').hidden = !state.locked || !spec.explanation;
    const off = Math.abs(Number(state.guess) - answer);
    el.querySelector('.px-result').innerHTML = state.locked
      ? practiceDone((off <= tolerance ? '¡Muy cerca! ' : off <= tolerance * 3 ? 'No está mal. ' : 'Lejos. ') + 'Era ' + vizFmt(answer) + unit + '; te has desviado ' + vizFmt(off) + unit + '.') : '';
  });
  input.addEventListener('input', () => { state.guess = Number(input.value); if (typeof haptic === 'function') haptic('drag'); render(); });
  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-px]');
    if (!action) return;
    state.locked = action.dataset.px === 'lock';
    if (state.locked) practiceMark(Math.abs(Number(state.guess) - answer) <= tolerance * 3);
    render();
  });
  render();
  return el;
}

/* ─── truefalse ── */

function vizTrueFalse(spec, state) {
  const statements = (Array.isArray(spec.statements) ? spec.statements : []).filter((item) => item && item.text != null && typeof item.answer === 'boolean').slice(0, 10);
  if (!statements.length) return null;
  if (!state.answers) state.answers = {};
  const el = vizElement('<div class="viz viz-practice viz-truefalse">' + vizHead('truefalse', spec.title || '¿Verdadero o falso?', '<span class="viz-count"></span>') +
    '<ol class="px-tf">' + statements.map((item, k) => '<li class="px-tf-row" data-row="' + k + '"><div class="px-tf-text">' + vizInline(item.text) + '</div>' +
      '<div class="px-tf-buttons"><button type="button" class="px-tf-btn" data-answer="' + k + ':1">Verdadero</button><button type="button" class="px-tf-btn" data-answer="' + k + ':0">Falso</button></div>' +
      '<div class="px-tf-expl">' + vizBlock(item.explanation || '') + '</div></li>').join('') + '</ol><div class="px-result"></div></div>');
  const render = () => interactiveUpdate(el, () => {
    let right = 0;
    statements.forEach((item, k) => {
      const row = el.querySelector('[data-row="' + k + '"]');
      const given = state.answers[k];
      const done = given != null;
      const ok = done && given === item.answer;
      if (ok) right += 1;
      row.classList.toggle('right', ok);
      row.classList.toggle('wrong', done && !ok);
      row.querySelectorAll('.px-tf-btn').forEach((button) => {
        const value = button.dataset.answer.endsWith(':1');
        button.disabled = done;
        button.classList.toggle('chosen', done && value === given);
        button.classList.toggle('truth', done && value === item.answer);
      });
    });
    const answered = Object.keys(state.answers).length;
    el.querySelector('.viz-count').textContent = right + '/' + statements.length;
    el.querySelector('.px-result').innerHTML = answered === statements.length ? practiceDone(right === statements.length ? '¡Pleno!' : right + ' de ' + statements.length + ' bien.') : '';
  });
  el.addEventListener('click', (event) => {
    const button = event.target.closest('[data-answer]');
    if (!button || button.disabled) return;
    const [k, value] = button.dataset.answer.split(':');
    state.answers[k] = value === '1';
    practiceMark(state.answers[k] === statements[Number(k)].answer);
    render();
  });
  render();
  return el;
}

Object.assign(VIZ_RENDERERS, {
  match: vizMatch, pairs: vizMatch, order: vizSequence, sequence: vizSequence, categorize: vizCategorize, classify: vizCategorize,
  fill: vizFill, cloze: vizFill, estimate: vizEstimate, guess: vizEstimate, truefalse: vizTrueFalse, true_false: vizTrueFalse
});
Object.assign(VIZ_KIND_LABEL, { match: 'Empareja', order: 'Ordena', categorize: 'Clasifica', fill: 'Completa', estimate: 'Estima', truefalse: 'Verdadero o falso' });
Object.assign(VIZ_ICON, {
  match: '<circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 7h3a3 3 0 0 1 3 3v4a3 3 0 0 0 3 3"/>',
  order: '<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><path d="M4 6h1v4M4 10h2M4 14h2l-2 4h2"/>',
  categorize: '<rect x="3" y="12" width="7" height="8" rx="1.5"/><rect x="14" y="12" width="7" height="8" rx="1.5"/><path d="M6.5 8V4M17.5 8V4M6.5 4h11"/>',
  fill: '<path d="M4 7h16M4 12h5M15 12h5M4 17h10"/><rect x="9" y="10" width="6" height="4" rx="1"/>',
  estimate: '<path d="M4 18a8 8 0 0 1 16 0"/><path d="M12 18l4-6"/><circle cx="12" cy="18" r="1.4"/>',
  truefalse: '<polyline points="3 12 6 15 11 9"/><line x1="15" y1="9" x2="21" y2="15"/><line x1="21" y1="9" x2="15" y2="15"/>'
});
