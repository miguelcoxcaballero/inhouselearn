/* ─── Visuals in the chat ────────────────────────────────────────────
   The model can put a ```visual block (JSON) in its answer and the chat
   shows it as an interactive card instead of code: function plots and
   formulas with sliders, charts, flashcards, step-by-step solutions,
   timelines, comparisons, a quick check question and key-idea cards.
   ```mermaid blocks become diagrams (mermaid loads the first time one
   appears). VISUALS_PROMPT tells the model the format. A block that does
   not parse stays as code.

   Everything is drawn from the spec with escaped text or sanitized
   markdown; expressions go through a small parser (vizCompile), never
   eval. Card state (slider values, flipped card, revealed steps) lives in
   vizState by message and block, so a redraw keeps it.

   Loaded before the main script of index.html; uses its globals at call
   time (renderMarkdown, escapeHtml). */

const VISUALS_PROMPT = [
  '## Interactive visuals (use them a lot)',
  'This chat turns a ```visual block (JSON) into an interactive card and a ```mermaid block into a diagram. Whenever an answer explains something that can be seen, played with or practised (a function or formula, data or a trend, a process or cycle, a comparison, dates, a procedure, terms to memorise), put ONE visual block where it helps and keep explaining in text around it. Most teaching answers in maths, science, economics, history, languages and exam prep should have one. Skip it only for small talk, one-line answers, or when the student asks for text only.',
  'Pick the type: a quantity that varies → plot (graph with sliders) or formula (sliders with live results); data, proportions, trends → chart; a procedure or worked solution → steps; dates and periods → timeline; A vs B → compare; terms, formulas or vocabulary to memorise → flashcards; overview of key points → cards; a quick self-check → check; processes, cycles, hierarchies, concept maps → mermaid.',
  'Formats (JSON with double quotes; LaTeX inside strings such as \\(x^2\\) is fine):',
  '- plot (graph of functions, with sliders): {"type":"plot","title":"…","x":[-6.3,6.3],"y":[-3,3],"functions":[{"expr":"a*sin(b*x)","label":"\\\\(a\\\\sin(bx)\\\\)"}],"params":{"a":{"min":0,"max":3,"value":1,"step":0.1,"label":"amplitud"}},"points":[{"x":0,"y":0,"label":"origen"}],"readouts":[{"label":"Periodo","expr":"2*pi/b","unit":"s"}]}. "y", "params", "points" and "readouts" are optional.',
  '- formula (a formula to play with, sliders and live results, no graph): {"type":"formula","title":"…","formula":"V = I\\\\,R","params":{"I":{"min":0,"max":5,"value":2,"label":"corriente (A)"},"R":{"min":1,"max":100,"value":10,"label":"resistencia (Ω)"}},"readouts":[{"label":"Tensión","expr":"I*R","unit":"V"}]}',
  '  expr: plain math with x and the param names; + - * / ^, parentheses, sin cos tan asin acos atan sqrt abs exp ln log (base 10) floor ceil min max, pi, e. Not LaTeX.',
  '- chart: {"type":"chart","kind":"bar|line|pie|scatter","title":"…","labels":["2021","2022"],"series":[{"name":"Ventas","values":[3,5]}],"unit":"€"}. scatter: values are [x,y] pairs and there are no labels.',
  '- flashcards (to memorise): {"type":"flashcards","title":"…","cards":[{"front":"…","back":"…"}]}',
  '- steps (a worked solution revealed one step at a time): {"type":"steps","title":"…","steps":[{"title":"…","body":"…"}]}',
  '- timeline: {"type":"timeline","title":"…","events":[{"date":"1789","title":"…","body":"…"}]}',
  '- compare (2–3 columns side by side): {"type":"compare","title":"…","columns":[{"title":"…","points":["…"]}]}',
  '- check (one quick question with instant feedback): {"type":"check","question":"…","options":["…","…"],"correct":0,"explanation":"…"}',
  '- cards (key ideas at a glance): {"type":"cards","title":"…","items":[{"icon":"⚡","title":"…","body":"…"}]}',
  'For processes, hierarchies, cycles and concept maps use a ```mermaid block (flowchart TD, mindmap, sequenceDiagram, timeline) with short labels in quotes.',
  'Text fields accept markdown and LaTeX \\( … \\). Prefer sliders with sensible ranges, real numbers and short labels. One or two visuals per answer at most.'
].join('\n');

const VISUALS_REMINDER = 'Before you answer: if this answer explains something visual, numeric, sequential or worth memorising, include one ```visual block (or a ```mermaid diagram) for it.';

const VIZ_FENCES = /^(visual|widget|viz|interactive|visualization)$/;
const VIZ_COLORS = ['#E07A3C', '#3B82F6', '#16A34A', '#9333EA', '#DC2626', '#0EA5E9', '#CA8A04', '#DB2777'];
const vizState = new Map();
const vizMermaidCache = new Map();
let vizMermaidPromise = null;
let vizSeq = 0;

function vizHash(text) {
  let h = 5381;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function vizInline(text) {
  return renderMarkdown(String(text == null ? '' : text)).trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1');
}

function vizBlock(text) {
  return renderMarkdown(String(text == null ? '' : text));
}

function vizFmt(value, digits) {
  if (typeof value !== 'number' || !isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return value.toExponential(2).replace('.', ',');
  const max = digits != null ? digits : abs < 1 ? 3 : abs < 100 ? 2 : 1;
  return value.toLocaleString('es-ES', { maximumFractionDigits: max });
}

// LaTeX commands that start like a JSON escape: \nabla is not "\n" + "abla".
const VIZ_LATEX_AFTER_N = /^(abla|eq|e(?![a-z])|u(?![a-z])|ot|eg|otin|exists|mid|leq|geq|subset|parallel|ewline|ormalsize)/;

// Models write LaTeX inside the JSON the natural way: "\(x^2\)", "\frac{1}{2}".
// That is invalid JSON, or worse, valid with \f, \t, \b turned into control
// characters. Inside strings, a backslash that is not a real JSON escape is
// kept as a backslash; raw line breaks become \n.
function vizRepairJson(raw) {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') { inString = false; out += ch; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r' || ch === '\t') { out += ' '; continue; }
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[i + 1] || '';
    const rest = raw.slice(i + 2, i + 14);
    let real = false;
    if (next === '"' || next === '/') real = true;
    else if (next === 'u') real = /^[0-9a-fA-F]{4}/.test(rest);
    else if (next === 'n') real = !VIZ_LATEX_AFTER_N.test(rest);
    else if ('tbfr'.includes(next) && next) real = !/^[a-zA-Z]/.test(rest);
    if (real) { out += ch + next; i++; continue; }
    out += '\\\\';
    // A LaTeX line break written as \\ stays a double backslash.
    if (next === '\\') { out += '\\\\'; i++; }
  }
  return out;
}

function parseVisualSpec(text, fallbackType) {
  const raw = String(text || '').trim().replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1');
  // Correctly escaped JSON ("\\frac", "\\(") goes first; otherwise the repaired text.
  const escaped = /\\\\[A-Za-z()[\]{},]/.test(raw);
  const attempts = escaped ? [raw, vizRepairJson(raw)] : [vizRepairJson(raw), raw];
  for (const attempt of attempts) {
    try {
      const spec = JSON.parse(attempt);
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
        if (typeof spec.type !== 'string' && fallbackType) spec.type = fallbackType;
        if (typeof spec.type === 'string') return spec;
      }
    } catch (_) {}
  }
  return null;
}

/* ─── Expressions ────────────────────────────────────────────────────── */

const VIZ_FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sec: (v) => 1 / Math.cos(v), csc: (v) => 1 / Math.sin(v), cot: (v) => 1 / Math.tan(v),
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2
};
const VIZ_CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

// "a*sin(b x) + 2x^2" → function(scope). Implicit products ("2x", "ax" with
// known names) are accepted; anything else is an error, never code.
function vizCompile(source, names) {
  const text = String(source == null ? '' : source)
    .replace(/\*\*/g, '^').replace(/π/g, 'pi').replace(/[·×]/g, '*').replace(/[−–]/g, '-').replace(/÷/g, '/')
    .replace(/^\s*[a-zA-Z]\w*\s*\(\s*x\s*\)\s*=/, '').replace(/^\s*y\s*=/, '');
  const tokens = [];
  const re = /\s*(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|[-+*/^(),])/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const match = re.exec(text);
    if (!match) throw new Error('Carácter no válido en «' + text + '»');
    tokens.push(match[1]);
    at = re.lastIndex;
  }
  const known = new Set(['x'].concat(names || []));
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isNum = (t) => /^[\d.]/.test(t || '');
  const isIdent = (t) => /^[A-Za-z_]/.test(t || '');
  const variable = (name) => {
    if (known.has(name)) return (s) => s[name];
    if (Object.prototype.hasOwnProperty.call(VIZ_CONSTS, name)) { const v = VIZ_CONSTS[name]; return () => v; }
    // "ax" → a·x when a and x are known names.
    const parts = [];
    let rest = name;
    const all = Array.from(known).concat(Object.keys(VIZ_CONSTS)).sort((a, b) => b.length - a.length);
    while (rest) {
      const hit = all.find((item) => rest.startsWith(item));
      if (!hit) throw new Error('Variable desconocida «' + name + '»');
      parts.push(variable(hit));
      rest = rest.slice(hit.length);
    }
    return (s) => parts.reduce((acc, part) => acc * part(s), 1);
  };
  function expr() {
    let left = term();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const a = left, b = term();
      left = op === '+' ? (s) => a(s) + b(s) : (s) => a(s) - b(s);
    }
    return left;
  }
  function term() {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t === '*' || t === '/') {
        next();
        const a = left, b = unary();
        left = t === '*' ? (s) => a(s) * b(s) : (s) => a(s) / b(s);
      } else if (isNum(t) || isIdent(t) || t === '(') {
        const a = left, b = power();
        left = (s) => a(s) * b(s);
      } else {
        return left;
      }
    }
  }
  function unary() {
    if (peek() === '-') { next(); const a = unary(); return (s) => -a(s); }
    if (peek() === '+') { next(); return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() === '^') {
      next();
      const exp = unary();
      return (s) => Math.pow(base(s), exp(s));
    }
    return base;
  }
  function primary() {
    const t = next();
    if (t === undefined) throw new Error('Expresión incompleta');
    if (isNum(t)) { const v = parseFloat(t); return () => v; }
    if (t === '(') {
      const inner = expr();
      if (next() !== ')') throw new Error('Falta un paréntesis');
      return inner;
    }
    if (isIdent(t)) {
      const fn = VIZ_FUNCS[t.toLowerCase()];
      if (fn && !known.has(t)) {
        if (peek() === '(') {
          next();
          const args = [expr()];
          while (peek() === ',') { next(); args.push(expr()); }
          if (next() !== ')') throw new Error('Falta un paréntesis');
          return (s) => fn.apply(null, args.map((arg) => arg(s)));
        }
        const arg = power();
        return (s) => fn(arg(s));
      }
      return variable(t);
    }
    throw new Error('No se entiende «' + t + '»');
  }
  const compiled = expr();
  if (pos < tokens.length) throw new Error('Sobra «' + tokens[pos] + '»');
  return (scope) => {
    try { return compiled(scope); } catch (_) { return NaN; }
  };
}

/* ─── Shared pieces ──────────────────────────────────────────────────── */

const VIZ_KIND_LABEL = {
  plot: 'Gráfica interactiva', formula: 'Fórmula interactiva', chart: 'Gráfico', flashcards: 'Tarjetas de memoria',
  steps: 'Paso a paso', timeline: 'Línea de tiempo', compare: 'Comparativa', check: 'Comprueba', cards: 'Ideas clave', mermaid: 'Diagrama'
};

const VIZ_ICON = {
  plot: '<path d="M3 3v18h18"/><path d="M7 15c2-6 4-6 6 0s4 6 6-2"/>',
  formula: '<path d="M4 7h6M7 4v6M14 6l6 6M20 6l-6 6M4 17h6M14 15h6M14 19h6"/>',
  chart: '<line x1="6" y1="20" x2="6" y2="11"/><line x1="12" y1="20" x2="12" y2="5"/><line x1="18" y1="20" x2="18" y2="14"/>',
  flashcards: '<rect x="3" y="6" width="14" height="12" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v10"/>',
  steps: '<path d="M4 20h4v-4h4v-4h4V8h4"/>',
  timeline: '<line x1="12" y1="3" x2="12" y2="21"/><circle cx="12" cy="7" r="2"/><circle cx="12" cy="16" r="2"/>',
  compare: '<rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/>',
  cards: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  mermaid: '<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M6.5 8v4h11v4"/>'
};

function vizHead(kind, title, extra) {
  return '<div class="viz-head"><span class="viz-kind"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (VIZ_ICON[kind] || VIZ_ICON.cards) + '</svg>' + escapeHtml(VIZ_KIND_LABEL[kind] || 'Vista') + '</span>' + (extra || '') + '</div>' +
    (title ? '<div class="viz-title">' + vizInline(title) + '</div>' : '');
}

function vizElement(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function vizNiceTicks(min, max, count) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return ticks;
}

function vizParams(raw) {
  const out = [];
  if (!raw || typeof raw !== 'object') return out;
  const entries = Array.isArray(raw) ? raw.map((item) => [item && item.name, item]) : Object.entries(raw);
  entries.forEach(([name, item]) => {
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) return;
    const cfg = typeof item === 'number' ? { value: item } : (item || {});
    let min = Number(cfg.min), max = Number(cfg.max), value = Number(cfg.value);
    if (!isFinite(value)) value = isFinite(min) && isFinite(max) ? (min + max) / 2 : 1;
    if (!isFinite(min)) min = Math.min(0, value * 2 - Math.abs(value) - 1);
    if (!isFinite(max) || max <= min) max = min + Math.max(1, Math.abs(value) * 2);
    value = Math.min(max, Math.max(min, value));
    let step = Number(cfg.step);
    if (!(step > 0)) step = (max - min) / 100;
    out.push({ name, min, max, value, step, label: cfg.label ? String(cfg.label) : '', unit: cfg.unit ? String(cfg.unit) : '' });
  });
  return out.slice(0, 6);
}

function vizSlidersMarkup(params, values) {
  if (!params.length) return '';
  return '<div class="viz-controls">' + params.map((param) =>
    '<label class="viz-slider"><span class="viz-slider-name"><b>' + escapeHtml(param.name) + '</b>' + (param.label ? '<small>' + escapeHtml(param.label) + '</small>' : '') + '</span>' +
    '<input type="range" min="' + param.min + '" max="' + param.max + '" step="' + param.step + '" value="' + values[param.name] + '" data-viz-param="' + escapeHtml(param.name) + '">' +
    '<output>' + vizFmt(values[param.name]) + (param.unit ? ' ' + escapeHtml(param.unit) : '') + '</output></label>').join('') + '</div>';
}

function vizReadouts(spec, names) {
  return (Array.isArray(spec.readouts) ? spec.readouts : []).slice(0, 6).map((item) => {
    try {
      return { label: String(item.label || item.expr || ''), unit: item.unit ? String(item.unit) : '', fn: vizCompile(item.expr, names), digits: item.digits };
    } catch (error) {
      return { label: String(item.label || ''), unit: '', fn: () => NaN, error: error.message };
    }
  });
}

function vizBindSliders(root, params, values, state, onChange) {
  root.querySelectorAll('input[data-viz-param]').forEach((input) => {
    const param = params.find((item) => item.name === input.dataset.vizParam);
    const output = input.parentElement.querySelector('output');
    input.addEventListener('input', () => {
      values[param.name] = Number(input.value);
      state.values = values;
      output.textContent = vizFmt(values[param.name]) + (param.unit ? ' ' + param.unit : '');
      onChange();
    });
  });
}

/* ─── plot and formula ───────────────────────────────────────────────── */

function vizPlot(spec, state) {
  const params = vizParams(spec.params);
  const names = params.map((param) => param.name);
  const values = state.values || Object.fromEntries(params.map((param) => [param.name, param.value]));
  const errors = [];
  const functions = (Array.isArray(spec.functions) ? spec.functions : spec.function ? [spec.function] : spec.expr ? [spec.expr] : [])
    .slice(0, 5).map((item, index) => {
      const def = typeof item === 'string' ? { expr: item } : (item || {});
      try {
        return { fn: vizCompile(def.expr, names), label: def.label || def.expr, color: def.color && /^#[0-9a-f]{3,8}$/i.test(def.color) ? def.color : VIZ_COLORS[index % VIZ_COLORS.length], dashed: !!def.dashed };
      } catch (error) {
        errors.push((def.expr || '?') + ': ' + error.message);
        return null;
      }
    }).filter(Boolean);
  const readouts = vizReadouts(spec, names);
  const isFormula = spec.type === 'formula' || !functions.length;
  const W = 640, H = 360, L = 46, R = 14, T = 14, B = 30;
  const xr = Array.isArray(spec.x) && spec.x.length === 2 && spec.x.every(isFinite) && spec.x[1] > spec.x[0] ? spec.x.map(Number)
    : Array.isArray(spec.domain) && spec.domain.length === 2 ? spec.domain.map(Number) : [-10, 10];
  const sample = (fn, count) => {
    const out = [];
    for (let i = 0; i <= count; i++) {
      const x = xr[0] + (xr[1] - xr[0]) * i / count;
      out.push([x, fn(Object.assign({ x }, values))]);
    }
    return out;
  };
  const autoY = () => {
    const ys = [];
    functions.forEach((f) => sample(f.fn, 200).forEach(([, y]) => { if (isFinite(y)) ys.push(y); }));
    (Array.isArray(spec.points) ? spec.points : []).forEach((p) => { const y = Number(Array.isArray(p) ? p[1] : p && p.y); if (isFinite(y)) ys.push(y); });
    if (!ys.length) return [-1, 1];
    ys.sort((a, b) => a - b);
    let lo = ys[Math.floor(ys.length * 0.03)], hi = ys[Math.ceil(ys.length * 0.97) - 1];
    if (!(hi - lo > 1e-9)) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    if (lo > 0 && lo < (hi - lo) * 0.35) lo = 0;
    if (hi < 0 && -hi < (hi - lo) * 0.35) hi = 0;
    return [lo, hi];
  };
  let yr = Array.isArray(spec.y) && spec.y.length === 2 && spec.y.every(isFinite) && spec.y[1] > spec.y[0] ? spec.y.map(Number) : (state.yr || autoY());
  const px = (x) => L + (x - xr[0]) / (xr[1] - xr[0]) * (W - L - R);
  const py = (y) => T + (yr[1] - y) / (yr[1] - yr[0]) * (H - T - B);
  const clipId = 'vizclip' + (++vizSeq);

  const axes = () => {
    const xt = vizNiceTicks(xr[0], xr[1], 8), yt = vizNiceTicks(yr[0], yr[1], 6);
    let g = '';
    xt.forEach((v) => { g += '<line class="viz-grid" x1="' + px(v) + '" y1="' + T + '" x2="' + px(v) + '" y2="' + (H - B) + '"/><text class="viz-tick" x="' + px(v) + '" y="' + (H - B + 17) + '" text-anchor="middle">' + escapeHtml(vizFmt(v)) + '</text>'; });
    yt.forEach((v) => { g += '<line class="viz-grid" x1="' + L + '" y1="' + py(v) + '" x2="' + (W - R) + '" y2="' + py(v) + '"/><text class="viz-tick" x="' + (L - 7) + '" y="' + (py(v) + 4) + '" text-anchor="end">' + escapeHtml(vizFmt(v)) + '</text>'; });
    if (yr[0] <= 0 && yr[1] >= 0) g += '<line class="viz-axis" x1="' + L + '" y1="' + py(0) + '" x2="' + (W - R) + '" y2="' + py(0) + '"/>';
    if (xr[0] <= 0 && xr[1] >= 0) g += '<line class="viz-axis" x1="' + px(0) + '" y1="' + T + '" x2="' + px(0) + '" y2="' + (H - B) + '"/>';
    g += '<rect class="viz-frame" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '"/>';
    return g;
  };
  const curves = () => functions.map((f) => {
    const pts = sample(f.fn, 480);
    const span = yr[1] - yr[0];
    let d = '', pen = false, prev = null;
    pts.forEach(([x, y]) => {
      const ok = isFinite(y) && Math.abs(y) < 1e7;
      if (ok && prev !== null && Math.abs(y - prev) > span * 3) pen = false;
      if (!ok) { pen = false; prev = null; return; }
      const cy = Math.max(T - span * 50, Math.min(H + span * 50, py(y)));
      d += (pen ? 'L' : 'M') + px(x).toFixed(1) + ' ' + cy.toFixed(1);
      pen = true;
      prev = y;
    });
    return '<path class="viz-curve' + (f.dashed ? ' dashed' : '') + '" d="' + d + '" stroke="' + f.color + '"/>';
  }).join('');
  const points = () => (Array.isArray(spec.points) ? spec.points : []).slice(0, 20).map((p, index) => {
    const x = Number(Array.isArray(p) ? p[0] : p && p.x), y = Number(Array.isArray(p) ? p[1] : p && p.y);
    const label = Array.isArray(p) ? p[2] : p && p.label;
    if (!isFinite(x) || !isFinite(y)) return '';
    return '<circle class="viz-point" cx="' + px(x) + '" cy="' + py(y) + '" r="4.5" fill="' + VIZ_COLORS[(index + 1) % VIZ_COLORS.length] + '"/>' +
      (label ? '<text class="viz-point-label" x="' + (px(x) + 8) + '" y="' + (py(y) - 8) + '">' + escapeHtml(String(label)) + '</text>' : '');
  }).join('');

  const legend = functions.length > 1 || (functions[0] && functions[0].label && spec.type !== 'formula')
    ? '<div class="viz-legend">' + functions.map((f) => '<span><i style="background:' + f.color + '"></i>' + vizInline(f.label) + '</span>').join('') + '</div>' : '';
  const figure = isFormula ? '' : '<div class="viz-figure"><svg viewBox="0 0 ' + W + ' ' + H + '" class="viz-svg" role="img" aria-label="' + escapeHtml(spec.title || 'Gráfica') + '">' +
    '<defs><clipPath id="' + clipId + '"><rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '"/></clipPath></defs>' +
    '<g class="viz-axes"></g><g class="viz-curves" clip-path="url(#' + clipId + ')"></g><g class="viz-points"></g>' +
    '<g class="viz-hover"><line class="viz-cross" y1="' + T + '" y2="' + (H - B) + '"/></g></svg><div class="viz-tip"></div>' +
    (spec.y ? '' : '<button type="button" class="viz-mini" data-viz-fit title="Ajustar la vista">Ajustar</button>') + '</div>';
  const formula = spec.formula ? '<div class="viz-formula">$$' + escapeHtml(String(spec.formula)) + '$$</div>' : '';
  const el = vizElement('<div class="viz viz-plot' + (isFormula ? ' viz-formula-only' : '') + '">' + vizHead(isFormula ? 'formula' : 'plot', spec.title) + formula + figure + legend +
    vizSlidersMarkup(params, values) + (readouts.length ? '<div class="viz-readouts">' + readouts.map((item, index) =>
      '<div class="viz-readout"><span>' + vizInline(item.label) + '</span><b data-viz-readout="' + index + '">—</b></div>').join('') + '</div>' : '') +
    (spec.caption ? '<div class="viz-caption">' + vizBlock(spec.caption) + '</div>' : '') +
    (errors.length ? '<div class="viz-error">No se pudo dibujar: ' + escapeHtml(errors.join(' · ')) + '</div>' : '') + '</div>');

  const draw = () => {
    if (!isFormula) {
      el.querySelector('.viz-axes').innerHTML = axes();
      el.querySelector('.viz-curves').innerHTML = curves();
      el.querySelector('.viz-points').innerHTML = points();
    }
    readouts.forEach((item, index) => {
      const target = el.querySelector('[data-viz-readout="' + index + '"]');
      if (target) target.textContent = item.error ? '—' : vizFmt(item.fn(Object.assign({ x: 0 }, values)), item.digits) + (item.unit ? ' ' + item.unit : '');
    });
  };
  draw();
  vizBindSliders(el, params, values, state, draw);
  const fit = el.querySelector('[data-viz-fit]');
  if (fit) fit.addEventListener('click', () => { yr = autoY(); state.yr = yr; draw(); });
  if (!isFormula && functions.length) {
    const svg = el.querySelector('svg');
    const tip = el.querySelector('.viz-tip');
    const hover = el.querySelector('.viz-hover');
    const cross = el.querySelector('.viz-cross');
    const move = (event) => {
      const box = svg.getBoundingClientRect();
      const sx = (event.clientX - box.left) / box.width * W;
      if (sx < L || sx > W - R) { hover.classList.remove('on'); tip.classList.remove('on'); return; }
      const x = xr[0] + (sx - L) / (W - L - R) * (xr[1] - xr[0]);
      cross.setAttribute('x1', sx); cross.setAttribute('x2', sx);
      hover.querySelectorAll('circle').forEach((dot) => dot.remove());
      const rows = functions.map((f) => {
        const y = f.fn(Object.assign({ x }, values));
        if (isFinite(y) && y >= yr[0] && y <= yr[1]) {
          hover.insertAdjacentHTML('beforeend', '<circle r="4" cx="' + sx + '" cy="' + py(y) + '" fill="' + f.color + '"/>');
        }
        return '<span><i style="background:' + f.color + '"></i>' + escapeHtml(vizFmt(y)) + '</span>';
      });
      tip.innerHTML = '<b>x = ' + escapeHtml(vizFmt(x)) + '</b>' + rows.join('');
      tip.style.left = Math.min(box.width - 10, Math.max(10, event.clientX - box.left)) + 'px';
      hover.classList.add('on');
      tip.classList.add('on');
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { hover.classList.remove('on'); tip.classList.remove('on'); });
  }
  return el;
}

/* ─── chart ──────────────────────────────────────────────────────────── */

function vizChart(spec, state) {
  const kind = /^(bar|line|pie|donut|scatter|area)$/.test(spec.kind) ? spec.kind : 'bar';
  let series = Array.isArray(spec.series) ? spec.series : Array.isArray(spec.values) ? [{ name: spec.name || '', values: spec.values }] : [];
  series = series.slice(0, 6).map((item, index) => ({
    name: String(item && item.name || ''), color: VIZ_COLORS[index % VIZ_COLORS.length],
    values: (Array.isArray(item && item.values) ? item.values : []).slice(0, 60)
  }));
  const labels = (Array.isArray(spec.labels) ? spec.labels : Array.isArray(spec.x) ? spec.x : []).slice(0, 60).map(String);
  const unit = spec.unit ? ' ' + String(spec.unit) : '';
  const W = 640, H = 340;
  let svg = '';
  let legend = '';
  if (kind === 'pie' || kind === 'donut') {
    const values = (series[0] ? series[0].values : []).map(Number).map((v) => (isFinite(v) && v > 0 ? v : 0));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const cx = 170, cy = 170, r = 140, ri = 78;
    let angle = -Math.PI / 2;
    values.forEach((value, index) => {
      const sweep = value / total * Math.PI * 2;
      if (!sweep) return;
      const a2 = angle + Math.min(sweep, Math.PI * 2 - 1e-4);
      const large = sweep > Math.PI ? 1 : 0;
      const p = (rad, a) => (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2);
      const color = VIZ_COLORS[index % VIZ_COLORS.length];
      svg += '<path class="viz-slice" fill="' + color + '" data-tip="' + escapeHtml((labels[index] || '') + ': ' + vizFmt(value) + unit + ' (' + vizFmt(value / total * 100, 1) + '%)') + '" d="M' + p(r, angle) + 'A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p(r, a2) + 'L' + p(ri, a2) + 'A' + ri + ' ' + ri + ' 0 ' + large + ' 0 ' + p(ri, angle) + 'Z"/>';
      angle += sweep;
    });
    // The total in the middle, unless the values are already percentages.
    if (!/%/.test(unit)) svg += '<text class="viz-pie-total" x="' + cx + '" y="' + (cy + 6) + '" text-anchor="middle">' + escapeHtml(vizFmt(total)) + escapeHtml(unit) + '</text>';
    legend = '<div class="viz-pie-legend">' + values.map((value, index) => '<div><i style="background:' + VIZ_COLORS[index % VIZ_COLORS.length] + '"></i><span>' + vizInline(labels[index] || '') + '</span><b>' + vizFmt(value / total * 100, 1) + '%</b></div>').join('') + '</div>';
    svg = '<svg viewBox="0 0 340 340" class="viz-svg viz-pie" role="img">' + svg + '</svg>';
  } else if (kind === 'scatter') {
    const all = [];
    series.forEach((s) => s.values.forEach((pt) => { if (Array.isArray(pt) && isFinite(pt[0]) && isFinite(pt[1])) all.push([Number(pt[0]), Number(pt[1])]); }));
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    const ext = (arr) => { let lo = Math.min.apply(null, arr), hi = Math.max.apply(null, arr); if (!(hi > lo)) { lo -= 1; hi += 1; } const pad = (hi - lo) * 0.08; return [lo - pad, hi + pad]; };
    const xr = all.length ? ext(xs) : [0, 1], yr = all.length ? ext(ys) : [0, 1];
    const L = 46, R = 14, T = 14, B = 30;
    const px = (x) => L + (x - xr[0]) / (xr[1] - xr[0]) * (W - L - R);
    const py = (y) => T + (yr[1] - y) / (yr[1] - yr[0]) * (H - T - B);
    vizNiceTicks(xr[0], xr[1], 8).forEach((v) => { svg += '<line class="viz-grid" x1="' + px(v) + '" y1="' + T + '" x2="' + px(v) + '" y2="' + (H - B) + '"/><text class="viz-tick" x="' + px(v) + '" y="' + (H - B + 17) + '" text-anchor="middle">' + escapeHtml(vizFmt(v)) + '</text>'; });
    vizNiceTicks(yr[0], yr[1], 6).forEach((v) => { svg += '<line class="viz-grid" x1="' + L + '" y1="' + py(v) + '" x2="' + (W - R) + '" y2="' + py(v) + '"/><text class="viz-tick" x="' + (L - 7) + '" y="' + (py(v) + 4) + '" text-anchor="end">' + escapeHtml(vizFmt(v)) + '</text>'; });
    series.forEach((s) => s.values.forEach((pt) => {
      if (!Array.isArray(pt) || !isFinite(pt[0]) || !isFinite(pt[1])) return;
      svg += '<circle class="viz-dot" r="5" cx="' + px(pt[0]) + '" cy="' + py(pt[1]) + '" fill="' + s.color + '" data-tip="' + escapeHtml((s.name ? s.name + ': ' : '') + '(' + vizFmt(Number(pt[0])) + ', ' + vizFmt(Number(pt[1])) + ')') + '"/>';
    }));
    svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz-svg" role="img">' + svg + '</svg>';
  } else {
    const count = Math.max(labels.length, ...series.map((s) => s.values.length), 0);
    const nums = series.map((s) => s.values.map(Number));
    const flat = [].concat(...nums).filter(isFinite);
    let lo = Math.min(0, ...flat), hi = Math.max(0, ...flat);
    if (!(hi > lo)) hi = lo + 1;
    hi += (hi - lo) * 0.08;
    const horizontal = kind === 'bar' && (labels.some((label) => label.length > 9) && count <= 14);
    if (horizontal) {
      const L = 132, R = 46, T = 6, rowH = Math.min(34, Math.max(20, 300 / Math.max(1, count)));
      const height = T * 2 + rowH * count;
      const pxv = (v) => L + (v - lo) / (hi - lo) * (W - L - R);
      for (let i = 0; i < count; i++) {
        const y = T + i * rowH;
        svg += '<text class="viz-tick viz-row-label" x="' + (L - 8) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end">' + escapeHtml((labels[i] || '').slice(0, 22)) + '</text>';
        const barH = (rowH - 8) / series.length;
        series.forEach((s, si) => {
          const v = nums[si][i];
          if (!isFinite(v)) return;
          const x0 = pxv(Math.min(0, v)), x1 = pxv(Math.max(0, v));
          svg += '<rect class="viz-bar" rx="3" x="' + x0 + '" y="' + (y + 4 + si * barH) + '" width="' + Math.max(1, x1 - x0) + '" height="' + Math.max(2, barH - 2) + '" fill="' + s.color + '" data-tip="' + escapeHtml((labels[i] || '') + (s.name ? ' · ' + s.name : '') + ': ' + vizFmt(v) + unit) + '"/>';
          if (series.length === 1) svg += '<text class="viz-value" x="' + (x1 + 5) + '" y="' + (y + rowH / 2 + 4) + '">' + escapeHtml(vizFmt(v)) + '</text>';
        });
      }
      svg = '<svg viewBox="0 0 ' + W + ' ' + height + '" class="viz-svg" role="img">' + svg + '</svg>';
    } else {
      const L = 46, R = 14, T = 14, B = 34;
      const py = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
      const band = (W - L - R) / Math.max(1, count);
      vizNiceTicks(lo, hi, 5).forEach((v) => { svg += '<line class="viz-grid" x1="' + L + '" y1="' + py(v) + '" x2="' + (W - R) + '" y2="' + py(v) + '"/><text class="viz-tick" x="' + (L - 7) + '" y="' + (py(v) + 4) + '" text-anchor="end">' + escapeHtml(vizFmt(v)) + '</text>'; });
      svg += '<line class="viz-axis" x1="' + L + '" y1="' + py(0) + '" x2="' + (W - R) + '" y2="' + py(0) + '"/>';
      const every = Math.ceil(count / 12);
      for (let i = 0; i < count; i++) {
        if (i % every === 0) svg += '<text class="viz-tick" x="' + (L + band * (i + 0.5)) + '" y="' + (H - B + 18) + '" text-anchor="middle">' + escapeHtml((labels[i] || '').slice(0, 10)) + '</text>';
      }
      if (kind === 'bar') {
        const inner = band * 0.72, barW = inner / Math.max(1, series.length);
        series.forEach((s, si) => nums[si].forEach((v, i) => {
          if (!isFinite(v)) return;
          const x = L + band * i + (band - inner) / 2 + si * barW;
          const y0 = py(Math.max(0, v)), y1 = py(Math.min(0, v));
          svg += '<rect class="viz-bar" rx="3" x="' + x.toFixed(1) + '" y="' + y0.toFixed(1) + '" width="' + Math.max(1, barW - 2).toFixed(1) + '" height="' + Math.max(1, y1 - y0).toFixed(1) + '" fill="' + s.color + '" data-tip="' + escapeHtml((labels[i] || '') + (s.name ? ' · ' + s.name : '') + ': ' + vizFmt(v) + unit) + '"/>';
          if (series.length === 1 && count <= 12) svg += '<text class="viz-value" x="' + (x + (barW - 2) / 2).toFixed(1) + '" y="' + (y0 - 5).toFixed(1) + '" text-anchor="middle">' + escapeHtml(vizFmt(v)) + '</text>';
        }));
      } else {
        series.forEach((s, si) => {
          const pts = nums[si].map((v, i) => (isFinite(v) ? [L + band * (i + 0.5), py(v), v, i] : null)).filter(Boolean);
          if (!pts.length) return;
          const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
          if (kind === 'area') svg += '<path class="viz-area" fill="' + s.color + '" d="' + d + 'L' + pts[pts.length - 1][0].toFixed(1) + ' ' + py(Math.max(lo, 0)).toFixed(1) + 'L' + pts[0][0].toFixed(1) + ' ' + py(Math.max(lo, 0)).toFixed(1) + 'Z"/>';
          svg += '<path class="viz-curve" stroke="' + s.color + '" d="' + d + '"/>';
          pts.forEach((p) => { svg += '<circle class="viz-dot" r="4" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" fill="' + s.color + '" data-tip="' + escapeHtml((labels[p[3]] || '') + (s.name ? ' · ' + s.name : '') + ': ' + vizFmt(p[2]) + unit) + '"/>'; });
        });
      }
      svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="viz-svg" role="img">' + svg + '</svg>';
    }
    if (series.length > 1 || (series[0] && series[0].name)) legend = '<div class="viz-legend">' + series.map((s) => '<span><i style="background:' + s.color + '"></i>' + vizInline(s.name) + '</span>').join('') + '</div>';
  }
  const el = vizElement('<div class="viz viz-chart viz-chart-' + kind + '">' + vizHead('chart', spec.title) +
    '<div class="viz-figure' + (kind === 'pie' || kind === 'donut' ? ' viz-pie-wrap' : '') + '">' + svg + legend + '<div class="viz-tip"></div></div>' +
    (kind === 'pie' || kind === 'donut' ? '' : '') + (spec.caption ? '<div class="viz-caption">' + vizBlock(spec.caption) + '</div>' : '') + '</div>');
  const figure = el.querySelector('.viz-figure');
  const tip = el.querySelector('.viz-tip');
  const show = (event) => {
    const target = event.target.closest('[data-tip]');
    if (!target) { tip.classList.remove('on'); return; }
    const box = figure.getBoundingClientRect();
    tip.textContent = target.getAttribute('data-tip');
    tip.style.left = Math.min(box.width - 10, Math.max(10, event.clientX - box.left)) + 'px';
    tip.style.top = Math.max(0, event.clientY - box.top - 40) + 'px';
    tip.classList.add('on');
  };
  figure.addEventListener('pointermove', show);
  figure.addEventListener('pointerdown', show);
  figure.addEventListener('pointerleave', () => tip.classList.remove('on'));
  return el;
}

/* ─── flashcards ─────────────────────────────────────────────────────── */

function vizFlashcards(spec, state) {
  const all = (Array.isArray(spec.cards) ? spec.cards : []).slice(0, 40).filter((card) => card && (card.front || card.back));
  if (!all.length) return null;
  if (!state.order) state.order = all.map((_, index) => index);
  if (state.index == null) state.index = 0;
  if (!state.marks) state.marks = {};
  const el = vizElement('<div class="viz viz-flash">' + vizHead('flashcards', spec.title, '<span class="viz-count"></span>') +
    '<div class="viz-deck">' + all.map((card, index) => '<button type="button" class="viz-card" data-card="' + index + '" aria-label="Voltear la tarjeta">' +
      '<span class="viz-card-inner"><span class="viz-card-face front"><span class="viz-card-tag">Pregunta</span><span class="viz-card-text">' + vizBlock(card.front) + '</span></span>' +
      '<span class="viz-card-face back"><span class="viz-card-tag">Respuesta</span><span class="viz-card-text">' + vizBlock(card.back) + '</span></span></span></button>').join('') +
    '<div class="viz-deck-done"></div></div>' +
    '<div class="viz-flash-bar"><button type="button" class="viz-btn ghost" data-flash="prev" aria-label="Anterior">‹</button>' +
    '<span class="viz-flash-hint">Toca la tarjeta para darle la vuelta</span>' +
    '<button type="button" class="viz-btn warn" data-flash="again">Repasar</button><button type="button" class="viz-btn ok" data-flash="know">La sé</button>' +
    '<button type="button" class="viz-btn ghost" data-flash="next" aria-label="Siguiente">›</button></div>' +
    '<div class="viz-dots"></div></div>');
  const cards = Array.from(el.querySelectorAll('.viz-card'));
  const done = el.querySelector('.viz-deck-done');
  const update = () => {
    const finished = state.index >= state.order.length;
    const current = state.order[state.index];
    cards.forEach((card, index) => {
      card.classList.toggle('active', !finished && index === current);
      card.classList.toggle('flipped', !finished && index === current && !!state.flipped);
    });
    el.classList.toggle('flipped', !!state.flipped && !finished);
    el.classList.toggle('finished', finished);
    el.querySelector('.viz-count').textContent = finished ? state.order.length + '/' + state.order.length : (state.index + 1) + '/' + state.order.length;
    el.querySelector('.viz-dots').innerHTML = state.order.map((cardIndex, i) => '<i class="' + (i === state.index ? 'on ' : '') + (state.marks[cardIndex] || '') + '"></i>').join('');
    if (finished) {
      const known = state.order.filter((i) => state.marks[i] === 'know').length;
      const again = state.order.filter((i) => state.marks[i] === 'again');
      done.innerHTML = '<strong>' + known + ' de ' + state.order.length + ' las sabías</strong>' +
        '<div class="viz-done-actions">' + (again.length ? '<button type="button" class="viz-btn ok" data-flash="review">Repasar ' + again.length + '</button>' : '') +
        '<button type="button" class="viz-btn ghost" data-flash="restart">Otra vez</button><button type="button" class="viz-btn ghost" data-flash="shuffle">Barajar</button></div>';
    }
  };
  el.addEventListener('click', (event) => {
    const card = event.target.closest('.viz-card');
    if (card) { state.flipped = !state.flipped; update(); return; }
    const button = event.target.closest('[data-flash]');
    if (!button) return;
    const action = button.dataset.flash;
    if (action === 'prev') { state.index = Math.max(0, state.index - 1); state.flipped = false; }
    if (action === 'next') { state.index = Math.min(state.order.length, state.index + 1); state.flipped = false; }
    if (action === 'know' || action === 'again') {
      if (state.index < state.order.length) state.marks[state.order[state.index]] = action;
      state.index += 1;
      state.flipped = false;
    }
    if (action === 'review') {
      state.order = state.order.filter((i) => state.marks[i] === 'again');
      state.order.forEach((i) => { delete state.marks[i]; });
      state.index = 0;
    }
    if (action === 'restart' || action === 'shuffle') {
      state.order = all.map((_, index) => index);
      if (action === 'shuffle') state.order.sort(() => Math.random() - 0.5);
      state.marks = {};
      state.index = 0;
      state.flipped = false;
    }
    update();
  });
  update();
  return el;
}

/* ─── steps, timeline, compare, cards, check ─────────────────────────── */

function vizSteps(spec, state) {
  const steps = (Array.isArray(spec.steps) ? spec.steps : []).slice(0, 20).map((step) => (typeof step === 'string' ? { body: step } : step || {}));
  if (!steps.length) return null;
  if (state.shown == null) state.shown = 1;
  const el = vizElement('<div class="viz viz-steps">' + vizHead('steps', spec.title, '<span class="viz-count"></span>') +
    '<ol class="viz-step-list">' + steps.map((step, index) => '<li class="viz-step"><span class="viz-step-num">' + (index + 1) + '</span><div class="viz-step-main">' +
      (step.title ? '<div class="viz-step-title">' + vizInline(step.title) + '</div>' : '') + (step.body ? '<div class="viz-step-body">' + vizBlock(step.body) + '</div>' : '') + '</div></li>').join('') + '</ol>' +
    (spec.result ? '<div class="viz-step-result">' + vizBlock(spec.result) + '</div>' : '') +
    '<div class="viz-foot"><button type="button" class="viz-btn ghost" data-step="all">Ver todo</button><button type="button" class="viz-btn ok" data-step="next">Siguiente paso</button></div></div>');
  const items = Array.from(el.querySelectorAll('.viz-step'));
  const update = () => {
    items.forEach((item, index) => {
      item.classList.toggle('shown', index < state.shown);
      item.classList.toggle('latest', index === state.shown - 1);
    });
    const all = state.shown >= steps.length;
    el.classList.toggle('complete', all);
    el.querySelector('.viz-count').textContent = 'Paso ' + Math.min(state.shown, steps.length) + ' de ' + steps.length;
    const next = el.querySelector('[data-step="next"]');
    next.textContent = all ? 'Empezar de nuevo' : 'Siguiente paso';
    el.querySelector('[data-step="all"]').hidden = all;
  };
  el.addEventListener('click', (event) => {
    const button = event.target.closest('[data-step]');
    if (!button) return;
    if (button.dataset.step === 'all') state.shown = steps.length;
    else state.shown = state.shown >= steps.length ? 1 : state.shown + 1;
    update();
  });
  update();
  return el;
}

function vizTimeline(spec) {
  const events = (Array.isArray(spec.events) ? spec.events : []).slice(0, 30).filter(Boolean);
  if (!events.length) return null;
  return vizElement('<div class="viz viz-timeline">' + vizHead('timeline', spec.title) + '<ol class="viz-tl">' + events.map((event, index) =>
    '<li style="--c:' + VIZ_COLORS[index % VIZ_COLORS.length] + '"><span class="viz-tl-dot"></span><div class="viz-tl-main">' +
    (event.date ? '<span class="viz-tl-date">' + escapeHtml(String(event.date)) + '</span>' : '') +
    (event.title ? '<div class="viz-tl-title">' + vizInline(event.title) + '</div>' : '') + (event.body ? '<div class="viz-tl-body">' + vizBlock(event.body) + '</div>' : '') +
    '</div></li>').join('') + '</ol></div>');
}

function vizCompare(spec) {
  const columns = (Array.isArray(spec.columns) ? spec.columns : []).slice(0, 4).filter(Boolean);
  if (!columns.length) return null;
  return vizElement('<div class="viz viz-compare">' + vizHead('compare', spec.title) + '<div class="viz-cols" style="--n:' + columns.length + '">' + columns.map((column, index) =>
    '<div class="viz-col" style="--c:' + VIZ_COLORS[index % VIZ_COLORS.length] + '"><div class="viz-col-title">' + vizInline(column.title || '') + '</div>' +
    (column.subtitle ? '<div class="viz-col-sub">' + vizInline(column.subtitle) + '</div>' : '') +
    '<ul>' + (Array.isArray(column.points) ? column.points : []).slice(0, 12).map((point) => '<li>' + vizInline(point) + '</li>').join('') + '</ul></div>').join('') + '</div>' +
    (spec.verdict ? '<div class="viz-caption">' + vizBlock(spec.verdict) + '</div>' : '') + '</div>');
}

function vizCards(spec) {
  const items = (Array.isArray(spec.items) ? spec.items : []).slice(0, 12).filter(Boolean);
  if (!items.length) return null;
  return vizElement('<div class="viz viz-ideas">' + vizHead('cards', spec.title) + '<div class="viz-idea-grid">' + items.map((item, index) =>
    '<div class="viz-idea" style="--c:' + VIZ_COLORS[index % VIZ_COLORS.length] + '">' + (item.icon ? '<span class="viz-idea-icon">' + escapeHtml(String(item.icon).slice(0, 4)) + '</span>' : '') +
    '<div class="viz-idea-title">' + vizInline(item.title || '') + '</div>' + (item.body ? '<div class="viz-idea-body">' + vizBlock(item.body) + '</div>' : '') + '</div>').join('') + '</div></div>');
}

function vizCheck(spec, state) {
  const options = (Array.isArray(spec.options) ? spec.options : []).slice(0, 6).map(String);
  const correct = Number(spec.correct);
  if (options.length < 2 || !Number.isInteger(correct) || correct < 0 || correct >= options.length) return null;
  const letters = 'ABCDEF';
  const el = vizElement('<div class="viz viz-check">' + vizHead('check', '') + '<div class="viz-check-q">' + vizBlock(spec.question || '') + '</div>' +
    '<div class="viz-check-options">' + options.map((option, index) => '<button type="button" class="viz-check-opt" data-opt="' + index + '"><span class="viz-check-key">' + letters[index] + '</span><span>' + vizInline(option) + '</span></button>').join('') + '</div>' +
    '<div class="viz-check-feedback right"><strong>¡Bien!</strong> ' + vizBlock(spec.explanation || '') + '</div>' +
    '<div class="viz-check-feedback wrong"><strong>Era la ' + letters[correct] + '.</strong> ' + vizBlock(spec.explanation || '') + '</div>' +
    '<div class="viz-foot"><button type="button" class="viz-btn ghost" data-check-retry>Reintentar</button></div></div>');
  const update = () => {
    const chosen = state.chosen;
    el.classList.toggle('answered', chosen != null);
    el.classList.toggle('is-right', chosen === correct);
    el.classList.toggle('is-wrong', chosen != null && chosen !== correct);
    el.querySelectorAll('.viz-check-opt').forEach((button) => {
      const index = Number(button.dataset.opt);
      button.disabled = chosen != null;
      button.classList.toggle('correct', chosen != null && index === correct);
      button.classList.toggle('wrong', chosen === index && index !== correct);
    });
  };
  el.addEventListener('click', (event) => {
    if (event.target.closest('[data-check-retry]')) { state.chosen = null; update(); return; }
    const button = event.target.closest('.viz-check-opt');
    if (!button || state.chosen != null) return;
    state.chosen = Number(button.dataset.opt);
    update();
  });
  update();
  return el;
}

const VIZ_RENDERERS = {
  plot: vizPlot, graph: vizPlot, function: vizPlot, formula: vizPlot, calculator: vizPlot,
  chart: vizChart, bar: (s, st) => vizChart(Object.assign({ kind: 'bar' }, s), st), pie: (s, st) => vizChart(Object.assign({ kind: 'pie' }, s), st),
  line: (s, st) => vizChart(Object.assign({ kind: 'line' }, s), st),
  flashcards: vizFlashcards, steps: vizSteps, timeline: vizTimeline, compare: vizCompare, cards: vizCards, ideas: vizCards, check: vizCheck, quiz: vizCheck
};

/* ─── mermaid ────────────────────────────────────────────────────────── */

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (vizMermaidPromise) return vizMermaidPromise;
  vizMermaidPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
    script.onload = () => {
      window.mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: 'inherit',
        themeVariables: { primaryColor: '#fff4ec', primaryBorderColor: '#E07A3C', primaryTextColor: '#1a1a1a', lineColor: '#a8a29e', secondaryColor: '#eef4ff', tertiaryColor: '#f5f5f0', fontSize: '14px' }
      });
      resolve(window.mermaid);
    };
    script.onerror = () => { vizMermaidPromise = null; reject(new Error('No se pudo cargar mermaid')); };
    document.head.appendChild(script);
  });
  return vizMermaidPromise;
}

function mountMermaid(pre, source) {
  const src = String(source || '').trim();
  const box = vizElement('<div class="viz viz-mermaid">' + vizHead('mermaid', '') + '<div class="viz-mermaid-body"><div class="viz-wait"><span class="viz-wait-icon"></span><span>Dibujando el diagrama…</span></div></div></div>');
  const body = box.querySelector('.viz-mermaid-body');
  const cached = vizMermaidCache.get(src);
  if (cached) body.innerHTML = cached;
  pre.replaceWith(box);
  if (cached) return;
  loadMermaid().then((mermaid) => mermaid.render('mmd' + vizHash(src) + (++vizSeq), src)).then((out) => {
    vizMermaidCache.set(src, out.svg);
    body.innerHTML = out.svg;
  }).catch((error) => {
    console.warn('Mermaid:', error);
    body.innerHTML = '<div class="viz-error">No se pudo dibujar el diagrama.</div><pre><code>' + escapeHtml(src) + '</code></pre>';
  });
}

/* ─── Entry point ────────────────────────────────────────────────────── */

function enhanceVisuals(root, options) {
  if (!root) return;
  root.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.closest('.viz, .latex-block, .tool-steps')) return;
    const lang = ((code.className.match(/language-([\w+-]+)/) || [])[1] || '').toLowerCase();
    const source = code.textContent;
    if (lang === 'mermaid') { mountMermaid(pre, source); return; }
    // ```visual is the format; ```viz, ```interactive, ```chart, ```plot… or a
    // ```json with a known "type" are accepted too.
    const typed = Object.prototype.hasOwnProperty.call(VIZ_RENDERERS, lang) ? lang : '';
    if (!VIZ_FENCES.test(lang) && !typed && !(lang === 'json' && /"type"\s*:\s*"(plot|formula|chart|flashcards|steps|timeline|compare|check|cards)"/.test(source))) return;
    const spec = parseVisualSpec(source, typed);
    const render = spec && VIZ_RENDERERS[String(spec.type).toLowerCase()];
    if (!render) return;
    const article = pre.closest('[data-msg-id]');
    const key = ((options && options.msgId) || (article && article.dataset.msgId) || 'any') + ':' + vizHash(source);
    if (!vizState.has(key)) vizState.set(key, {});
    let el = null;
    try { el = render(spec, vizState.get(key)); } catch (error) { console.warn('Visual failed:', error); }
    if (el) pre.replaceWith(el);
  });
}
