/* ─── Animated and interactive visuals ───────────────────────────────
   Two more ```visual types on top of visuals.js:

   - scene: declarative and safe (JSON only, no author code). Layers in world
     coordinates (y up) drawn as SVG: shapes, labels, arrows, curves, a grid,
     particles that flow along a path, vector fields, heatmaps, springs, a
     pendulum, draggable handles, editable points and free drawing. Every
     number can be an expression (vizCompile) of the controls, of t (the
     simulation time), of the scene's own vars, state (integrated over time)
     and functions. Controls: sliders, toggles, buttons; play, pause, reset
     and speed; readouts; triggers that fire events.
   - sandbox: the model's own HTML and script, in an <iframe sandbox=
     "allow-scripts"> with a CSP that blocks every request, a shim that can
     pause its animation frames and timers and watches its CPU use, and a
     tiny postMessage protocol {v:1, type, id, payload} checked by the host.

   One requestAnimationFrame drives every scene; a scene only runs while it is
   on screen, at most SCENE_LIMITS.running at once, at 30 fps on touch
   devices, and starts paused when the reader prefers reduced motion. Its
   state (controls, time, positions) lives in vizState, so redrawing the
   message does not restart it. What the student does (moves a slider,
   presses a button, a trigger fires, a sandbox emits) is kept per message and
   sent to the tutor with the next turn (visualEventsText); "Enviar al tutor"
   sends it right away as a question.

   Loaded after visuals.js (registers its renderers there) and before the
   main script of index.html (uses getActiveChat, createMessage and
   runAssistantTurn at call time). Schema: docs/visual-schema.json. */

const SCENE_LIMITS = { perMessage: 8, animatedPerMessage: 4, running: 4, layers: 80, particles: 400, arrows: 300, sandboxBytes: 65536, events: 20 };
const SCENE_KINDS = new Set(['grid', 'path', 'line', 'arrow', 'circle', 'rect', 'polygon', 'label', 'image', 'plot', 'flow', 'vectorField', 'heatmap', 'spring', 'pendulum', 'handle', 'points', 'draw']);
const SCENE_SVG = 'http://www.w3.org/2000/svg';
const SCENE_ID = /^[A-Za-z_][A-Za-z_0-9]{0,30}$/;
const SCENE_ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5L20 4L14 20L11.4 13.1L4 12.5Z"/></svg>'
};

/* ─── Events for the tutor ───────────────────────────────────────────── */

const vizEventLog = new Map(); // message id → [{visual, slot, text}]

function vizRecordEvent(key, visual, slot, text) {
  const msgId = String(key).split(':')[0];
  const list = vizEventLog.get(msgId) || [];
  // A control keeps only its last value; other events pile up (bounded).
  const index = slot ? list.findIndex((item) => item.slot === slot && item.visual === visual) : -1;
  if (index >= 0) list.splice(index, 1);
  list.push({ visual, slot, text });
  while (list.length > SCENE_LIMITS.events) list.shift();
  vizEventLog.set(msgId, list);
}

// For the system prompt of the next turn: what the student did with the visuals.
function visualEventsText(chat) {
  const lines = [];
  (chat && chat.messages || []).forEach((message) => {
    (vizEventLog.get(message.id) || []).forEach((item) => lines.push('- (Visual «' + item.visual + '») ' + item.text));
  });
  if (!lines.length) return '';
  return ['## What the student did with the interactive visuals since your last answer (from the app, not typed by the student)', ...lines.slice(-SCENE_LIMITS.events),
    'Use it if it helps (comment on what they found); do not quote this list.'].join('\n');
}

function clearVisualEvents(chat) {
  (chat && chat.messages || []).forEach((message) => vizEventLog.delete(message.id));
}

function sendVisualToTutor(title, summary) {
  if (typeof runAssistantTurn !== 'function' || appState.busy) return;
  const chat = getActiveChat();
  if (!chat) return;
  const message = createMessage('user', 'Te paso cómo he dejado la vista «' + title + '»: ' + summary + '. ¿Qué está pasando y qué debería fijarme?', false);
  message.kind = 'visual-state';
  runAssistantTurn(chat, message);
}

/* ─── Validation ─────────────────────────────────────────────────────── */

function sceneIsNumberish(value) {
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
}

function scenePointish(value) {
  return Array.isArray(value) && value.length === 2 && value.every(sceneIsNumberish);
}

// Structural checks before anything is drawn; expressions are checked when compiled.
function validateScene(spec) {
  const errors = [];
  if (!spec || spec.type !== 'scene') errors.push('type must be "scene"');
  const layers = Array.isArray(spec && spec.layers) ? spec.layers : null;
  if (!layers || !layers.length) errors.push('"layers" must be a non-empty array');
  else if (layers.length > SCENE_LIMITS.layers) errors.push('too many layers (max ' + SCENE_LIMITS.layers + ')');
  (layers || []).forEach((layer, index) => {
    if (!layer || !SCENE_KINDS.has(layer.kind)) errors.push('layer ' + index + ': unknown kind ' + JSON.stringify(layer && layer.kind));
    else {
      if (layer.id != null && !SCENE_ID.test(layer.id)) errors.push('layer ' + index + ': bad id');
      ['at', 'from', 'to', 'pivot'].forEach((key) => { if (layer[key] != null && !scenePointish(layer[key])) errors.push('layer ' + index + ': "' + key + '" must be [x, y]'); });
      if (layer.kind === 'path' && typeof layer.d !== 'string') errors.push('layer ' + index + ': path needs "d"');
      if (layer.kind === 'flow' && typeof layer.along !== 'string') errors.push('layer ' + index + ': flow needs "along" (a path id)');
      if (layer.kind === 'polygon' && !(Array.isArray(layer.points) && layer.points.every(scenePointish))) errors.push('layer ' + index + ': polygon needs "points"');
      if (layer.kind === 'image' && !/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/.test(String(layer.src || ''))) errors.push('layer ' + index + ': image only accepts data: URIs');
      if (['handle', 'points', 'draw', 'pendulum'].includes(layer.kind) && !SCENE_ID.test(String(layer.id || ''))) errors.push('layer ' + index + ': ' + layer.kind + ' needs an "id"');
    }
  });
  const ids = new Set();
  (Array.isArray(spec && spec.controls) ? spec.controls : []).forEach((control, index) => {
    if (!control || !['slider', 'toggle', 'button'].includes(control.kind)) errors.push('control ' + index + ': kind must be slider, toggle or button');
    else if (!SCENE_ID.test(String(control.id || ''))) errors.push('control ' + index + ': bad id');
    else if (ids.has(control.id)) errors.push('control ' + index + ': repeated id ' + control.id);
    else ids.add(control.id);
  });
  const camera = spec && spec.camera;
  if (camera && !(['xmin', 'xmax', 'ymin', 'ymax'].every((key) => typeof camera[key] === 'number') && camera.xmax > camera.xmin && camera.ymax > camera.ymin)) errors.push('camera needs numbers with xmax > xmin and ymax > ymin');
  return errors;
}

function validateSandbox(spec) {
  const errors = [];
  if (!spec || spec.type !== 'sandbox') errors.push('type must be "sandbox"');
  if (typeof (spec && spec.html) !== 'string' || !spec.html.trim()) errors.push('"html" is required');
  else if (new Blob([spec.html]).size > SCENE_LIMITS.sandboxBytes) errors.push('"html" is larger than 64 KB');
  if (spec && spec.emit != null && !(Array.isArray(spec.emit) && spec.emit.every((name) => typeof name === 'string' && name.length <= 40))) errors.push('"emit" must be a list of event names');
  return errors;
}

// A visual that cannot be drawn: a neutral note, never a broken message.
function vizFallback(spec, reason, source) {
  const title = spec && spec.title ? String(spec.title) : '';
  return vizElement('<div class="viz viz-fallback" role="note">' +
    '<div class="viz-fallback-text"><b>No se ha podido mostrar esta vista' + (title ? ' («' + escapeHtml(title) + '»)' : '') + '.</b> ' + escapeHtml(reason || '') + '</div>' +
    (source ? '<details><summary>Ver lo que envió el modelo</summary><pre><code>' + escapeHtml(String(source).slice(0, 8000)) + '</code></pre></details>' : '') + '</div>');
}

/* ─── Scheduler ──────────────────────────────────────────────────────── */

const sceneRuntime = {
  views: new Set(), raf: 0, last: 0, startedAt: new Map(), slow: 0, quality: 1,
  coarse: !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches),
  reduced: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  observer: null
};

function sceneObserve(view) {
  if (!('IntersectionObserver' in window)) { view.visible = true; return; }
  if (!sceneRuntime.observer) {
    sceneRuntime.observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const target = entry.target.__vizView;
        if (!target) return;
        target.visible = entry.isIntersecting;
        if (target.onVisibility) target.onVisibility(entry.isIntersecting);
      });
      sceneSchedule();
    }, { threshold: 0.05 });
  }
  view.el.__vizView = view;
  sceneRuntime.observer.observe(view.el);
}

function sceneSchedule() {
  if (!sceneRuntime.raf) sceneRuntime.raf = requestAnimationFrame(sceneTick);
}

// Starting one more animation than allowed pauses the one started longest ago.
function sceneClaimSlot(view) {
  sceneRuntime.startedAt.set(view, performance.now());
  const running = Array.from(sceneRuntime.startedAt.keys()).filter((item) => item !== view && item.playing && item.el.isConnected);
  while (running.length >= SCENE_LIMITS.running) {
    running.sort((a, b) => sceneRuntime.startedAt.get(a) - sceneRuntime.startedAt.get(b));
    const oldest = running.shift();
    oldest.pause('Pausada para dejar sitio a otra animación.');
  }
}

function sceneTick(now) {
  sceneRuntime.raf = 0;
  const minGap = sceneRuntime.coarse ? 1000 / 30 - 2 : 0;
  const gap = now - (sceneRuntime.last || now - 16);
  let active = false;
  sceneRuntime.views.forEach((view) => {
    if (!view.el.isConnected) { sceneRuntime.views.delete(view); sceneRuntime.startedAt.delete(view); return; }
    if (view.playing && view.visible) active = true;
  });
  if (!active) { sceneRuntime.last = 0; return; }
  sceneRuntime.raf = requestAnimationFrame(sceneTick);
  if (gap < minGap) return;
  sceneRuntime.last = now;
  const dt = Math.min(0.05, gap / 1000);
  const t0 = performance.now();
  sceneRuntime.views.forEach((view) => { if (view.playing && view.visible) view.advance(dt); });
  // Too slow for this device: fewer particles and arrows everywhere.
  const cost = performance.now() - t0;
  sceneRuntime.slow = cost > 14 ? sceneRuntime.slow + 1 : Math.max(0, sceneRuntime.slow - 1);
  if (sceneRuntime.slow > 20 && sceneRuntime.quality > 0.25) { sceneRuntime.quality /= 2; sceneRuntime.slow = 0; }
}

/* ─── Geometry ───────────────────────────────────────────────────────── */

// "M1,4 L4,4 Q5,3 6,2.6 Z" in world units → list of points (curves sampled).
function scenePathPoints(d) {
  const tokens = String(d || '').match(/[MLHVCQZmlhvcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const points = [];
  let i = 0, cmd = 'M', x = 0, y = 0, startX = 0, startY = 0;
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') { points.push([startX, startY]); x = startX; y = startY; continue; }
    if (i >= tokens.length) break;
    if (C === 'M' || C === 'L') {
      const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
      x = nx; y = ny;
      if (C === 'M') { startX = x; startY = y; if (points.length) points.push(null); }
      points.push([x, y]);
      if (C === 'M') cmd = rel ? 'l' : 'L';
    } else if (C === 'H') { x = num() + (rel ? x : 0); points.push([x, y]); }
    else if (C === 'V') { y = num() + (rel ? y : 0); points.push([x, y]); }
    else if (C === 'Q' || C === 'C') {
      const ctrl = [];
      for (let k = 0; k < (C === 'Q' ? 2 : 3); k++) ctrl.push([num() + (rel ? x : 0), num() + (rel ? y : 0)]);
      const p0 = [x, y];
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        const p = C === 'Q'
          ? [u * u * p0[0] + 2 * u * t * ctrl[0][0] + t * t * ctrl[1][0], u * u * p0[1] + 2 * u * t * ctrl[0][1] + t * t * ctrl[1][1]]
          : [u * u * u * p0[0] + 3 * u * u * t * ctrl[0][0] + 3 * u * t * t * ctrl[1][0] + t * t * t * ctrl[2][0], u * u * u * p0[1] + 3 * u * u * t * ctrl[0][1] + 3 * u * t * t * ctrl[1][1] + t * t * t * ctrl[2][1]];
        points.push(p);
      }
      x = ctrl[ctrl.length - 1][0]; y = ctrl[ctrl.length - 1][1];
    } else { i++; }
    if (points.length > 4000) break;
  }
  return points;
}

// A polyline with arc lengths, to place particles at a distance along it.
function scenePolyline(points) {
  const pts = points.filter(Boolean);
  const lengths = [0];
  for (let k = 1; k < pts.length; k++) lengths.push(lengths[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const total = lengths[lengths.length - 1] || 0;
  return {
    total,
    at(dist) {
      if (pts.length < 2 || !total) return { x: pts[0] ? pts[0][0] : 0, y: pts[0] ? pts[0][1] : 0, nx: 0, ny: 1 };
      const d = ((dist % total) + total) % total;
      let lo = 0, hi = lengths.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lengths[mid] <= d) lo = mid; else hi = mid; }
      const seg = lengths[hi] - lengths[lo] || 1;
      const k = (d - lengths[lo]) / seg;
      const dx = pts[hi][0] - pts[lo][0], dy = pts[hi][1] - pts[lo][1], len = Math.hypot(dx, dy) || 1;
      return { x: pts[lo][0] + dx * k, y: pts[lo][1] + dy * k, nx: -dy / len, ny: dx / len };
    }
  };
}

function sceneColor(value, fallback) {
  const text = String(value == null ? '' : value).trim();
  return /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-zA-Z]{3,20})$/.test(text) ? text : fallback;
}

function sceneTemplate(text, evalExpr, digits) {
  return String(text == null ? '' : text).replace(/\{([^{}]{1,80})\}/g, (match, inner) => {
    const parts = inner.split(/:(?=\d+$)/);
    const value = evalExpr(parts[0]);
    return typeof value === 'number' ? vizFmt(value, parts[1] != null ? Number(parts[1]) : digits) : match;
  });
}

/* ─── The scene ──────────────────────────────────────────────────────── */

class SceneView {
  constructor(spec, state, key) {
    this.spec = spec;
    this.state = state;
    this.key = key;
    this.title = String(spec.title || 'Simulación');
    this.visible = false;
    this.playing = false;
    this.W = Math.max(160, Math.min(2000, Number(spec.width) || 800));
    this.H = Math.max(100, Math.min(2000, Number(spec.height) || Math.round(this.W * 0.5)));
    const cam = spec.camera || { xmin: 0, xmax: 10, ymin: 0, ymax: 10 * this.H / this.W };
    this.cam = { xmin: cam.xmin, xmax: cam.xmax, ymin: cam.ymin, ymax: cam.ymax };
    this.errors = [];
    this.compileAll();
    this.build();
  }

  X(x) { return (x - this.cam.xmin) / (this.cam.xmax - this.cam.xmin) * this.W; }
  Y(y) { return this.H - (y - this.cam.ymin) / (this.cam.ymax - this.cam.ymin) * this.H; }
  SX(len) { return len * this.W / (this.cam.xmax - this.cam.xmin); }
  SY(len) { return len * this.H / (this.cam.ymax - this.cam.ymin); }

  /* ── Compilation ── */

  compileAll() {
    const spec = this.spec;
    const controls = (Array.isArray(spec.controls) ? spec.controls : []).slice(0, 12);
    const layers = spec.layers.slice(0, SCENE_LIMITS.layers);
    this.controls = controls;
    this.stateDefs = sceneEntries(spec.state).filter(([name]) => SCENE_ID.test(name)).slice(0, 12)
      .map(([name, def]) => [name, typeof def === 'object' && def ? def : { init: def, rate: 0 }]);
    this.varDefs = sceneEntries(spec.vars).filter(([name]) => SCENE_ID.test(name)).slice(0, 30);
    const names = new Set(['t', 'x', 'y', 's', 'u', 'i', 'n', 'dt']);
    controls.forEach((control) => { names.add(control.id); if (control.kind === 'button') names.add(control.id + '_count'); });
    this.stateDefs.forEach(([name]) => names.add(name));
    this.varDefs.forEach(([name]) => names.add(name));
    layers.forEach((layer) => {
      if (!layer.id) return;
      if (layer.kind === 'handle') { names.add(layer.id + '_x'); names.add(layer.id + '_y'); }
      if (layer.kind === 'points') ['_n', '_mx', '_my'].forEach((suffix) => names.add(layer.id + suffix));
      if (layer.kind === 'draw') ['_n', '_len'].forEach((suffix) => names.add(layer.id + suffix));
      if (layer.kind === 'pendulum') ['_angle', '_omega', '_x', '_y'].forEach((suffix) => names.add(layer.id + suffix));
    });
    // The scene's own functions: "w": "x < 4 ? 1.2 : 0.5" or {"args": ["x","y"], "expr": "…"}.
    this.funcs = {};
    sceneEntries(spec.functions).filter(([name]) => SCENE_ID.test(name)).slice(0, 20).forEach(([name, def]) => {
      const args = def && typeof def === 'object' && Array.isArray(def.args) ? def.args.filter((arg) => SCENE_ID.test(arg)).slice(0, 4) : ['x'];
      const body = def && typeof def === 'object' ? def.expr : def;
      const scopeNames = Array.from(names).concat(args);
      let compiled;
      try { compiled = vizCompile(body, scopeNames, this.funcs); } catch (error) { this.errors.push('function ' + name + ': ' + error.message); return; }
      const view = this;
      this.funcs[name] = function () {
        const local = Object.create(view.scope || null);
        args.forEach((arg, index) => { local[arg] = arguments[index]; });
        return compiled(local);
      };
    });
    this.names = Array.from(names);
    this.cache = new Map();
  }

  // A number or an expression → function(scope).
  fn(value, fallback) {
    if (typeof value === 'number') return () => value;
    if (typeof value === 'boolean') return () => (value ? 1 : 0);
    if (value == null || value === '') return () => fallback;
    const text = String(value);
    if (this.cache.has(text)) return this.cache.get(text);
    let compiled;
    try { compiled = vizCompile(text, this.names, this.funcs); } catch (error) {
      this.errors.push('«' + text.slice(0, 40) + '»: ' + error.message);
      compiled = () => fallback;
    }
    this.cache.set(text, compiled);
    return compiled;
  }

  point(value, fallback) {
    const p = Array.isArray(value) ? value : fallback || [0, 0];
    const fx = this.fn(p[0], 0), fy = this.fn(p[1], 0);
    return (scope) => [fx(scope), fy(scope)];
  }

  /* ── State ── */

  initState() {
    const st = this.state;
    if (!st.values) {
      st.values = {};
      this.controls.forEach((control) => {
        if (control.kind === 'slider') {
          const min = Number(control.min) || 0, max = Number(control.max) > min ? Number(control.max) : min + 1;
          st.values[control.id] = Math.min(max, Math.max(min, Number(control.value != null ? control.value : min)));
        } else if (control.kind === 'toggle') st.values[control.id] = control.value === false ? 0 : control.value ? 1 : 0;
        else { st.values[control.id] = 0; st.values[control.id + '_count'] = 0; }
      });
    }
    if (st.t == null) st.t = 0;
    if (!st.sim) st.sim = {};
    if (!st.fired) st.fired = {};
    if (!st.events) st.events = [];
    if (st.speed == null) st.speed = 1;
  }

  resetSim() {
    const st = this.state;
    st.t = 0;
    st.sim = {};
    st.fired = {};
    this.controls.forEach((control) => { if (control.kind === 'button') st.values[control.id] = 0; });
    this.layers.forEach((layer) => layer.reset && layer.reset());
    this.evaluate(0, true);
    this.draw();
  }

  makeScope() {
    const st = this.state;
    const scope = Object.assign({ t: st.t, dt: 0 }, st.values);
    this.scope = scope;
    if (!st.sim.__state) {
      st.sim.__state = {};
      this.stateDefs.forEach(([name, def]) => { st.sim.__state[name] = this.fn(def.init, 0)(scope); scope[name] = st.sim.__state[name]; });
    }
    Object.assign(scope, st.sim.__state);
    this.layers.forEach((layer) => layer.expose && layer.expose(scope));
    return scope;
  }

  // Time step: integrate state (semi-implicit Euler in small substeps), then vars.
  evaluate(dt, fresh) {
    const st = this.state;
    const scope = this.makeScope();
    if (dt > 0) {
      const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / steps;
      for (let k = 0; k < steps; k++) {
        scope.t = st.t + h * k;
        scope.dt = h;
        this.stateDefs.forEach(([name, def]) => {
          const rate = this.fn(def.rate, 0)(scope);
          if (isFinite(rate)) { st.sim.__state[name] += rate * h; scope[name] = st.sim.__state[name]; }
        });
        this.layers.forEach((layer) => layer.step && layer.step(scope, h));
      }
      st.t += dt;
      scope.t = st.t;
    }
    this.varDefs.forEach(([name, expr]) => { scope[name] = this.fn(expr, 0)(scope); });
    this.layers.forEach((layer) => layer.expose && layer.expose(scope));
    if (!fresh) this.checkTriggers(scope);
    return scope;
  }

  checkTriggers(scope) {
    (Array.isArray(this.spec.triggers) ? this.spec.triggers : []).slice(0, 10).forEach((trigger, index) => {
      const on = !!this.fn(trigger.when, 0)(scope);
      const was = this.state.fired[index];
      if (on && !was) {
        const text = sceneTemplate(trigger.label || trigger.emit || 'evento', (expr) => this.fn(expr, NaN)(scope));
        this.note('✓ ' + text, true);
        haptic('success');
        vizRecordEvent(this.key, this.title, 'trigger:' + index, 'reached: ' + text + (trigger.emit ? ' [' + String(trigger.emit).slice(0, 40) + ']' : ''));
      }
      if (on) this.state.fired[index] = true;
      else if (trigger.once === false) this.state.fired[index] = false;
    });
  }

  /* ── Building ── */

  build() {
    const spec = this.spec;
    this.initState();
    const animated = spec.loop ? spec.loop !== 'static'
      : !!(this.stateDefs.length || spec.layers.some((layer) => ['flow', 'pendulum'].includes(layer.kind)) || /\bt\b/.test(JSON.stringify(spec.layers) + JSON.stringify(spec.vars || {})));
    this.animated = animated;
    const alt = spec.alt ? String(spec.alt) : (this.title + '. ' + (animated ? 'Animación' : 'Escena interactiva') +
      (this.controls.length ? ' con controles: ' + this.controls.map((control) => control.label || control.id).join(', ') : '') + '.');
    const bg = sceneColor(spec.background, '#fbfaf7');
    const dark = /^#(0|1|2)/.test(bg) || /^(black|navy)$/i.test(bg);
    const el = vizElement('<div class="viz viz-scene' + (dark ? ' dark' : '') + '">' + vizHead('scene', spec.title, animated ? '<span class="viz-count scene-time"></span>' : '') +
      '<div class="scene-stage" style="aspect-ratio:' + this.W + ' / ' + this.H + ';background:' + bg + '">' +
      '<svg class="scene-svg" viewBox="0 0 ' + this.W + ' ' + this.H + '" role="img" aria-label="' + escapeHtml(alt) + '" preserveAspectRatio="xMidYMid meet"></svg>' +
      '<div class="scene-note" aria-live="polite"></div></div>' +
      '<div class="scene-bar">' +
      (animated ? '<button type="button" class="scene-btn" data-scene="play" aria-label="Reproducir" aria-pressed="false">' + SCENE_ICON.play + '</button>' +
        '<button type="button" class="scene-btn" data-scene="reset" aria-label="Reiniciar">' + SCENE_ICON.reset + '</button>' +
        '<label class="scene-speed"><span class="sr-only">Velocidad</span><select data-scene="speed" aria-label="Velocidad">' + [0.25, 0.5, 1, 2].map((v) => '<option value="' + v + '"' + (v === this.state.speed ? ' selected' : '') + '>' + String(v).replace('.', ',') + '×</option>').join('') + '</select></label>' : '') +
      (spec.layers.some((layer) => layer.kind === 'draw' || (layer.kind === 'points' && layer.editable !== false)) ? '<button type="button" class="scene-btn text" data-scene="clear">Borrar</button>' : '') +
      '<span class="scene-spacer"></span><button type="button" class="scene-btn text" data-scene="send">' + SCENE_ICON.send + 'Enviar al tutor</button></div>' +
      this.controlsMarkup() +
      ((Array.isArray(spec.readouts) && spec.readouts.length) ? '<div class="viz-readouts">' + spec.readouts.slice(0, 6).map((item, index) =>
        '<div class="viz-readout"><span>' + vizInline(item.label || item.expr || '') + '</span><b data-scene-readout="' + index + '">—</b></div>').join('') + '</div>' : '') +
      (spec.caption ? '<div class="viz-caption">' + vizBlock(spec.caption) + '</div>' : '') + '</div>');
    this.el = el;
    this.svg = el.querySelector('.scene-svg');
    const defs = document.createElementNS(SCENE_SVG, 'defs');
    this.svg.appendChild(defs);
    this.defs = defs;
    this.layers = spec.layers.slice(0, SCENE_LIMITS.layers).map((layer) => sceneLayer(this, layer)).filter(Boolean);
    this.layers.forEach((layer) => { layer.g = document.createElementNS(SCENE_SVG, 'g'); this.svg.appendChild(layer.g); layer.mount(layer.g); });
    if (this.errors.length) {
      const warn = document.createElement('div');
      warn.className = 'viz-error';
      warn.textContent = 'Partes de esta vista no se pueden dibujar: ' + this.errors.slice(0, 3).join(' · ');
      el.appendChild(warn);
    }
    this.bind();
    this.evaluate(0, true);
    this.draw();
    sceneRuntime.views.add(this);
    sceneObserve(this);
    if (animated && (this.state.playing !== false) && !sceneRuntime.reduced) this.play(true);
    else if (animated && sceneRuntime.reduced && this.state.playing == null) this.note('Animación en pausa (movimiento reducido). Pulsa ▶ para verla.');
    this.syncBar();
  }

  controlsMarkup() {
    if (!this.controls.length) return '';
    const v = this.state.values;
    return '<div class="viz-controls scene-controls">' + this.controls.map((control) => {
      const label = escapeHtml(control.label || control.id);
      if (control.kind === 'slider') {
        const min = Number(control.min) || 0, max = Number(control.max) > min ? Number(control.max) : min + 1;
        const step = Number(control.step) > 0 ? Number(control.step) : (max - min) / 100;
        return '<label class="viz-slider"><span class="viz-slider-name"><b>' + label + '</b>' + (control.hint ? '<small>' + escapeHtml(control.hint) + '</small>' : '') + '</span>' +
          '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + v[control.id] + '" data-scene-control="' + control.id + '">' +
          '<output>' + vizFmt(v[control.id]) + (control.unit ? ' ' + escapeHtml(control.unit) : '') + '</output></label>';
      }
      if (control.kind === 'toggle') {
        return '<label class="scene-toggle"><input type="checkbox" role="switch" data-scene-control="' + control.id + '"' + (v[control.id] ? ' checked' : '') + '><span class="scene-switch" aria-hidden="true"></span>' + label + '</label>';
      }
      return '<button type="button" class="scene-btn text outline" data-scene-button="' + control.id + '">' + label + '</button>';
    }).join('') + '</div>';
  }

  bind() {
    const el = this.el;
    el.querySelectorAll('[data-scene-control]').forEach((input) => {
      const control = this.controls.find((item) => item.id === input.dataset.sceneControl);
      const output = input.parentElement.querySelector('output');
      input.addEventListener('input', () => {
        haptic(input.type === 'checkbox' ? 'select' : 'drag');
        this.state.values[control.id] = input.type === 'checkbox' ? (input.checked ? 1 : 0) : Number(input.value);
        if (output) output.textContent = vizFmt(this.state.values[control.id]) + (control.unit ? ' ' + control.unit : '');
        this.evaluate(0);
        this.draw();
      });
      input.addEventListener('change', () => {
        const value = this.state.values[control.id];
        vizRecordEvent(this.key, this.title, 'control:' + control.id, (control.label || control.id) + ' = ' + (input.type === 'checkbox' ? (value ? 'on' : 'off') : vizFmt(value)) + (control.unit ? ' ' + control.unit : ''));
      });
    });
    el.querySelectorAll('[data-scene-button]').forEach((button) => {
      const control = this.controls.find((item) => item.id === button.dataset.sceneButton);
      button.addEventListener('click', () => {
        if (control.action === 'reset') this.resetSim();
        else {
          this.state.values[control.id] = 1;
          this.state.values[control.id + '_count'] = (this.state.values[control.id + '_count'] || 0) + 1;
          this.pulse = control.id;
          if (!this.playing) { this.evaluate(0); this.draw(); this.state.values[control.id] = 0; }
        }
        vizRecordEvent(this.key, this.title, 'button:' + control.id + ':' + Date.now(), 'pressed «' + (control.label || control.id) + '»');
      });
    });
    el.querySelector('.scene-bar').addEventListener('click', (event) => {
      const button = event.target.closest('[data-scene]');
      if (!button) return;
      const action = button.dataset.scene;
      if (action === 'play') { if (this.playing) this.pause(); else this.play(); }
      if (action === 'reset') this.resetSim();
      if (action === 'clear') { this.layers.forEach((layer) => layer.clear && layer.clear()); this.evaluate(0); this.draw(); }
      if (action === 'send') sendVisualToTutor(this.title, this.summary());
    });
    const speed = el.querySelector('select[data-scene="speed"]');
    if (speed) speed.addEventListener('change', () => { this.state.speed = Number(speed.value) || 1; });
    this.bindPointer();
  }

  // Dragging handles, adding or removing points, drawing.
  bindPointer() {
    const interactive = this.layers.filter((layer) => layer.pointer);
    if (!interactive.length) return;
    const svg = this.svg;
    svg.classList.add('interactive');
    const toWorld = (event) => {
      const box = svg.getBoundingClientRect();
      const scale = Math.min(box.width / this.W, box.height / this.H);
      const ox = (box.width - this.W * scale) / 2, oy = (box.height - this.H * scale) / 2;
      const px = (event.clientX - box.left - ox) / scale, py = (event.clientY - box.top - oy) / scale;
      return [this.cam.xmin + px / this.W * (this.cam.xmax - this.cam.xmin), this.cam.ymin + (this.H - py) / this.H * (this.cam.ymax - this.cam.ymin)];
    };
    let active = null;
    svg.addEventListener('pointerdown', (event) => {
      const world = toWorld(event);
      for (let k = interactive.length - 1; k >= 0; k--) {
        const grab = interactive[k].pointer.down(event, world);
        if (grab) { active = grab; break; }
      }
      if (active) { event.preventDefault(); svg.setPointerCapture(event.pointerId); this.evaluate(0); this.draw(); }
    });
    svg.addEventListener('pointermove', (event) => {
      if (!active) return;
      event.preventDefault();
      haptic('drag');
      active.move(toWorld(event));
      if (!this.playing) { this.evaluate(0); this.draw(); }
    });
    const end = () => { if (active && active.end) active.end(); active = null; if (!this.playing) { this.evaluate(0); this.draw(); } };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  /* ── Running ── */

  play(auto) {
    if (!this.animated) return;
    if (!auto) this.state.playing = true;
    this.playing = true;
    sceneClaimSlot(this);
    this.note('');
    this.syncBar();
    sceneSchedule();
  }

  pause(reason) {
    this.playing = false;
    this.state.playing = false;
    if (reason) this.note(reason);
    this.syncBar();
  }

  onVisibility(visible) {
    if (visible && this.playing) sceneSchedule();
  }

  syncBar() {
    const button = this.el.querySelector('[data-scene="play"]');
    if (!button) return;
    button.innerHTML = this.playing ? SCENE_ICON.pause : SCENE_ICON.play;
    button.setAttribute('aria-label', this.playing ? 'Pausar animación' : 'Reproducir animación');
    button.setAttribute('aria-pressed', this.playing ? 'true' : 'false');
  }

  note(text, flash) {
    const box = this.el.querySelector('.scene-note');
    if (!box) return;
    box.textContent = text || '';
    box.classList.toggle('on', !!text);
    box.classList.toggle('flash', !!flash);
    clearTimeout(this.noteTimer);
    if (flash) this.noteTimer = setTimeout(() => box.classList.remove('on'), 2600);
  }

  advance(dt) {
    this.evaluate(dt * (this.state.speed || 1));
    if (this.pulse) { this.state.values[this.pulse] = 0; this.pulse = null; }
    this.draw();
  }

  draw() {
    const scope = this.scope;
    this.layers.forEach((layer) => {
      const shown = layer.visible ? !!layer.visible(scope) : true;
      layer.g.style.display = shown ? '' : 'none';
      if (shown) layer.update(scope);
    });
    (Array.isArray(this.spec.readouts) ? this.spec.readouts : []).slice(0, 6).forEach((item, index) => {
      const target = this.el.querySelector('[data-scene-readout="' + index + '"]');
      if (target) {
        const value = this.fn(item.expr, NaN)(scope);
        const text = vizFmt(value, item.digits) + (item.unit ? ' ' + item.unit : '');
        if (target.textContent !== text) target.textContent = text;
      }
    });
    const time = this.el.querySelector('.scene-time');
    if (time) time.textContent = 't = ' + vizFmt(this.state.t, 1) + ' s';
  }

  summary() {
    const parts = this.controls.filter((control) => control.kind !== 'button').map((control) => {
      const value = this.state.values[control.id];
      return (control.label || control.id) + ' = ' + (control.kind === 'toggle' ? (value ? 'sí' : 'no') : vizFmt(value) + (control.unit ? ' ' + control.unit : ''));
    });
    (Array.isArray(this.spec.readouts) ? this.spec.readouts : []).slice(0, 6).forEach((item) => {
      parts.push(String(item.label || item.expr).replace(/\\\(|\\\)/g, '') + ' = ' + vizFmt(this.fn(item.expr, NaN)(this.scope), item.digits) + (item.unit ? ' ' + item.unit : ''));
    });
    if (this.animated) parts.push('t = ' + vizFmt(this.state.t, 1) + ' s');
    return parts.join('; ') || 'sin cambios';
  }
}

function sceneEntries(value) {
  if (!value || typeof value !== 'object') return [];
  return Array.isArray(value) ? value.map((item) => [item && item.name, item]) : Object.entries(value);
}

/* ─── Layers ─────────────────────────────────────────────────────────── */

function sceneEl(tag, attrs, parent) {
  const node = document.createElementNS(SCENE_SVG, tag);
  Object.keys(attrs || {}).forEach((name) => node.setAttribute(name, attrs[name]));
  if (parent) parent.appendChild(node);
  return node;
}

function sceneSet(node, attrs) {
  Object.keys(attrs).forEach((name) => {
    const value = typeof attrs[name] === 'number' ? (isFinite(attrs[name]) ? Math.round(attrs[name] * 100) / 100 : -9999) : attrs[name];
    if (node.getAttribute(name) !== String(value)) node.setAttribute(name, value);
  });
}

function sceneArrowMarker(view, color) {
  const id = 'sa' + vizHash(view.key + color);
  if (!view.defs.querySelector('#' + id)) {
    const marker = sceneEl('marker', { id, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, view.defs);
    sceneEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }, marker);
  }
  return 'url(#' + id + ')';
}

function sceneLayer(view, layer) {
  const kind = layer.kind;
  const color = sceneColor(layer.color || layer.stroke || layer.fill, VIZ_COLORS[(view.spec.layers.indexOf(layer)) % VIZ_COLORS.length]);
  const visible = layer.visible != null ? view.fn(layer.visible, 1) : null;
  const opacity = layer.opacity != null ? view.fn(layer.opacity, 1) : null;
  const base = { visible, layer };
  const withOpacity = (update) => (scope) => { update(scope); };
  const make = (obj) => Object.assign(base, obj, opacity ? { update: ((inner) => (scope) => { inner(scope); sceneSet(base.g, { opacity: opacity(scope) }); })(obj.update) } : {});

  if (kind === 'grid') {
    return make({
      mount(g) {
        const step = Number(layer.step) > 0 ? Number(layer.step) : 1;
        const c = view.cam, gridColor = sceneColor(layer.color, 'rgba(120,120,120,0.18)');
        let lines = 0;
        for (let x = Math.ceil(c.xmin / step) * step; x <= c.xmax && lines < 200; x += step, lines++) sceneEl('line', { x1: view.X(x), x2: view.X(x), y1: 0, y2: view.H, stroke: gridColor, 'stroke-width': Math.abs(x) < 1e-9 && layer.axes !== false ? 1.6 : 1 }, g);
        for (let y = Math.ceil(c.ymin / step) * step; y <= c.ymax && lines < 400; y += step, lines++) sceneEl('line', { y1: view.Y(y), y2: view.Y(y), x1: 0, x2: view.W, stroke: gridColor, 'stroke-width': Math.abs(y) < 1e-9 && layer.axes !== false ? 1.6 : 1 }, g);
      },
      update() {}
    });
  }
  if (kind === 'path') {
    const points = scenePathPoints(layer.d);
    view.paths = view.paths || {};
    if (layer.id) view.paths[layer.id] = scenePolyline(points);
    return make({
      mount(g) {
        let d = '';
        let pen = false;
        points.forEach((p) => { if (!p) { pen = false; return; } d += (pen ? 'L' : 'M') + view.X(p[0]).toFixed(1) + ' ' + view.Y(p[1]).toFixed(1); pen = true; });
        if (/[zZ]\s*$/.test(layer.d)) d += 'Z';
        this.node = sceneEl('path', { d, fill: layer.fill && layer.fill !== 'none' ? sceneColor(layer.fill, 'none') : 'none', stroke: layer.stroke === 'none' ? 'none' : sceneColor(layer.stroke, color),
          'stroke-width': Number(layer.strokeWidth) || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': layer.dash ? String(layer.dash).replace(/[^\d\s.,]/g, '') : '' }, g);
      },
      update() {}
    });
  }
  if (kind === 'line' || kind === 'arrow') {
    const from = view.point(layer.from, [0, 0]), to = view.point(layer.to, [1, 0]);
    return make({
      mount(g) {
        const stroke = sceneColor(layer.color || layer.stroke, kind === 'arrow' ? '#1a1a1a' : color);
        this.node = sceneEl('line', { stroke, 'stroke-width': Number(layer.strokeWidth) || 2, 'stroke-linecap': 'round', 'stroke-dasharray': layer.dash ? String(layer.dash).replace(/[^\d\s.,]/g, '') : '' }, g);
        if (kind === 'arrow') this.node.setAttribute('marker-end', sceneArrowMarker(view, stroke));
        if (layer.label) this.text = sceneEl('text', { class: 'scene-label', 'text-anchor': 'middle', fill: sceneColor(layer.labelColor, stroke) }, g);
      },
      update(scope) {
        const a = from(scope), b = to(scope);
        sceneSet(this.node, { x1: view.X(a[0]), y1: view.Y(a[1]), x2: view.X(b[0]), y2: view.Y(b[1]) });
        if (this.text) {
          sceneSet(this.text, { x: (view.X(a[0]) + view.X(b[0])) / 2, y: (view.Y(a[1]) + view.Y(b[1])) / 2 - 8 });
          const label = sceneTemplate(layer.label, (expr) => view.fn(expr, NaN)(scope));
          if (this.text.textContent !== label) this.text.textContent = label;
        }
      }
    });
  }
  if (kind === 'circle') {
    const at = view.point(layer.at || [layer.cx, layer.cy], [0, 0]);
    const r = view.fn(layer.r, 0.2);
    return make({
      mount(g) {
        this.node = sceneEl('circle', { fill: layer.fill === 'none' ? 'none' : sceneColor(layer.fill || layer.color, color), stroke: sceneColor(layer.stroke, 'none'), 'stroke-width': Number(layer.strokeWidth) || 0 }, g);
        if (layer.label) this.text = sceneEl('text', { class: 'scene-label', 'text-anchor': 'middle', fill: sceneColor(layer.labelColor, '#1a1a1a') }, g);
      },
      update(scope) {
        const p = at(scope), radius = Math.abs(view.SX(r(scope)));
        sceneSet(this.node, { cx: view.X(p[0]), cy: view.Y(p[1]), r: radius });
        if (this.text) {
          sceneSet(this.text, { x: view.X(p[0]), y: view.Y(p[1]) - radius - 6 });
          const label = sceneTemplate(layer.label, (expr) => view.fn(expr, NaN)(scope));
          if (this.text.textContent !== label) this.text.textContent = label;
        }
      }
    });
  }
  if (kind === 'rect') {
    const x = view.fn(layer.x, 0), y = view.fn(layer.y, 0), w = view.fn(layer.w, 1), h = view.fn(layer.h, 1);
    return make({
      mount(g) { this.node = sceneEl('rect', { fill: sceneColor(layer.fill || layer.color, color), stroke: sceneColor(layer.stroke, 'none'), 'stroke-width': Number(layer.strokeWidth) || 0, rx: Number(layer.rx) || 0 }, g); },
      update(scope) {
        const x0 = view.X(x(scope)), x1 = view.X(x(scope) + w(scope)), y0 = view.Y(y(scope)), y1 = view.Y(y(scope) + h(scope));
        sceneSet(this.node, { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) });
      }
    });
  }
  if (kind === 'polygon') {
    const pts = layer.points.slice(0, 200).map((p) => view.point(p));
    return make({
      mount(g) { this.node = sceneEl(layer.closed === false ? 'polyline' : 'polygon', { fill: layer.closed === false ? 'none' : sceneColor(layer.fill || layer.color, color), stroke: sceneColor(layer.stroke, layer.closed === false ? color : 'none'), 'stroke-width': Number(layer.strokeWidth) || (layer.closed === false ? 2 : 0), 'stroke-linejoin': 'round' }, g); },
      update(scope) { sceneSet(this.node, { points: pts.map((p) => { const q = p(scope); return view.X(q[0]).toFixed(1) + ',' + view.Y(q[1]).toFixed(1); }).join(' ') }); }
    });
  }
  if (kind === 'label') {
    const at = view.point(layer.at, [0, 0]);
    return make({
      mount(g) {
        this.node = sceneEl('text', { class: 'scene-label' + (layer.weight === 'bold' ? ' bold' : ''), 'text-anchor': ['start', 'middle', 'end'].includes(layer.anchor) ? layer.anchor : 'middle',
          fill: sceneColor(layer.color, '#1a1a1a'), 'font-size': Math.max(8, Math.min(48, Number(layer.size) || 14)) }, g);
      },
      update(scope) {
        const p = at(scope);
        sceneSet(this.node, { x: view.X(p[0]), y: view.Y(p[1]) });
        const text = sceneTemplate(layer.text, (expr) => view.fn(expr, NaN)(scope), layer.digits);
        if (this.node.textContent !== text) this.node.textContent = text;
      }
    });
  }
  if (kind === 'image') {
    const at = view.point(layer.at, [0, 0]), w = view.fn(layer.w, 1), h = view.fn(layer.h, 1);
    return make({
      mount(g) { this.node = sceneEl('image', { href: layer.src, preserveAspectRatio: 'xMidYMid meet' }, g); },
      update(scope) { const p = at(scope); sceneSet(this.node, { x: view.X(p[0]), y: view.Y(p[1] + h(scope)), width: view.SX(w(scope)), height: view.SY(h(scope)) }); }
    });
  }
  if (kind === 'plot') {
    const f = view.fn(layer.fn || layer.expr, NaN);
    const x0 = layer.xmin != null ? Number(layer.xmin) : view.cam.xmin, x1 = layer.xmax != null ? Number(layer.xmax) : view.cam.xmax;
    const samples = Math.max(20, Math.min(600, Number(layer.samples) || 240));
    return make({
      mount(g) { this.node = sceneEl('path', { fill: 'none', stroke: color, 'stroke-width': Number(layer.strokeWidth) || 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g); },
      update(scope) {
        let d = '', pen = false;
        const local = Object.create(scope);
        for (let k = 0; k <= samples; k++) {
          local.x = x0 + (x1 - x0) * k / samples;
          const y = f(local);
          if (!isFinite(y)) { pen = false; continue; }
          d += (pen ? 'L' : 'M') + view.X(local.x).toFixed(1) + ' ' + view.Y(y).toFixed(1);
          pen = true;
        }
        sceneSet(this.node, { d });
      }
    });
  }
  if (kind === 'flow') {
    // Particles that run along a path: speed (and lateral spread) can depend on x, y, s.
    const speed = view.fn(layer.speed, 1), spread = view.fn(layer.spread, 0);
    const count = Math.max(1, Math.min(SCENE_LIMITS.particles, Number(layer.count) || 40));
    const radius = Math.max(1, Math.min(20, Number(layer.radius) || 4));
    return make({
      reset() { view.state.sim['flow' + view.layers.indexOf(this)] = null; },
      mount(g) {
        this.nodes = [];
        for (let k = 0; k < count; k++) this.nodes.push(sceneEl('circle', { r: radius, fill: color, opacity: 0.9 }, g));
      },
      particles() {
        const slot = 'flow' + view.layers.indexOf(this);
        const line = view.paths && view.paths[layer.along];
        if (!line) return null;
        if (!view.state.sim[slot]) {
          let seed = 7;
          const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
          view.state.sim[slot] = Array.from({ length: count }, (_, k) => ({ d: line.total * k / count + rand() * line.total / count, u: rand() * 2 - 1 }));
        }
        return { line, list: view.state.sim[slot] };
      },
      step(scope, h) {
        const data = this.particles();
        if (!data) return;
        const local = Object.create(scope);
        data.list.forEach((p, k) => {
          const at = data.line.at(p.d);
          local.x = at.x; local.y = at.y; local.s = p.d / (data.line.total || 1); local.u = p.u; local.i = k;
          const v = speed(local);
          if (isFinite(v)) p.d = (p.d + v * h) % (data.line.total || 1);
          if (p.d < 0) p.d += data.line.total;
        });
      },
      update(scope) {
        const data = this.particles();
        if (!data) return;
        const local = Object.create(scope);
        const shown = Math.max(1, Math.round(count * sceneRuntime.quality * (sceneRuntime.coarse ? 0.6 : 1)));
        data.list.forEach((p, k) => {
          const node = this.nodes[k];
          if (k >= shown) { node.style.display = 'none'; return; }
          node.style.display = '';
          const at = data.line.at(p.d);
          local.x = at.x; local.y = at.y; local.s = p.d / (data.line.total || 1); local.u = p.u;
          const off = spread(local) * p.u;
          sceneSet(node, { cx: view.X(at.x + at.nx * off), cy: view.Y(at.y + at.ny * off) });
        });
      }
    });
  }
  if (kind === 'vectorField') {
    const fx = view.fn(layer.fx, 0), fy = view.fn(layer.fy, 0);
    const step = Number(layer.step) > 0 ? Number(layer.step) : (view.cam.xmax - view.cam.xmin) / 14;
    const scale = Number(layer.scale) > 0 ? Number(layer.scale) : 1;
    return make({
      mount(g) {
        this.cells = [];
        const marker = sceneArrowMarker(view, color);
        for (let x = view.cam.xmin + step / 2; x < view.cam.xmax && this.cells.length < SCENE_LIMITS.arrows; x += step) {
          for (let y = view.cam.ymin + step / 2; y < view.cam.ymax && this.cells.length < SCENE_LIMITS.arrows; y += step) {
            this.cells.push({ x, y, node: sceneEl('line', { stroke: color, 'stroke-width': 1.6, 'marker-end': marker, 'stroke-linecap': 'round' }, g) });
          }
        }
      },
      update(scope) {
        const local = Object.create(scope);
        this.cells.forEach((cell) => {
          local.x = cell.x; local.y = cell.y;
          let vx = fx(local), vy = fy(local);
          const len = Math.hypot(vx, vy);
          const max = step * 0.9;
          if (len * scale > max) { vx = vx / len * max / scale; vy = vy / len * max / scale; }
          sceneSet(cell.node, { x1: view.X(cell.x - vx * scale / 2), y1: view.Y(cell.y - vy * scale / 2), x2: view.X(cell.x + vx * scale / 2), y2: view.Y(cell.y + vy * scale / 2) });
        });
      }
    });
  }
  if (kind === 'heatmap') {
    const f = view.fn(layer.fn || layer.expr, 0);
    const res = Math.max(8, Math.min(96, Number(layer.res) || 48));
    const stops = (Array.isArray(layer.colors) && layer.colors.length >= 2 ? layer.colors : ['#3B82F6', '#f5f5f0', '#DC2626']).slice(0, 5).map((c) => sceneColor(c, '#888'));
    const lo = Number(layer.min != null ? layer.min : 0), hi = Number(layer.max != null ? layer.max : 1);
    return make({
      mount(g) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = res; this.canvas.height = Math.max(4, Math.round(res * view.H / view.W));
        this.node = sceneEl('image', { x: 0, y: 0, width: view.W, height: view.H, preserveAspectRatio: 'none', opacity: layer.opacity != null ? '' : 0.85, style: 'image-rendering:auto' }, g);
        this.rgb = stops.map((c) => { const probe = document.createElement('canvas').getContext('2d'); probe.fillStyle = c; const hex = probe.fillStyle; return /^#/.test(hex) ? [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) : [128, 128, 128]; });
      },
      update(scope) {
        const now = performance.now();
        if (this.at && now - this.at < 90) return;
        this.at = now;
        const ctx = this.canvas.getContext('2d'), w = this.canvas.width, h = this.canvas.height;
        const img = ctx.createImageData(w, h);
        const local = Object.create(scope);
        for (let j = 0; j < h; j++) {
          for (let k = 0; k < w; k++) {
            local.x = view.cam.xmin + (k + 0.5) / w * (view.cam.xmax - view.cam.xmin);
            local.y = view.cam.ymax - (j + 0.5) / h * (view.cam.ymax - view.cam.ymin);
            let v = (f(local) - lo) / (hi - lo || 1);
            v = isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
            const pos = v * (this.rgb.length - 1), a = Math.floor(pos), b = Math.min(this.rgb.length - 1, a + 1), m = pos - a;
            const o = (j * w + k) * 4;
            for (let c = 0; c < 3; c++) img.data[o + c] = this.rgb[a][c] + (this.rgb[b][c] - this.rgb[a][c]) * m;
            img.data[o + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
        this.node.setAttribute('href', this.canvas.toDataURL());
      }
    });
  }
  if (kind === 'spring') {
    const from = view.point(layer.from, [0, 0]), to = view.point(layer.to, [1, 0]);
    const coils = Math.max(2, Math.min(40, Number(layer.coils) || 10));
    const width = Number(layer.width) > 0 ? Number(layer.width) : 0.25;
    return make({
      mount(g) { this.node = sceneEl('polyline', { fill: 'none', stroke: sceneColor(layer.color, '#64748b'), 'stroke-width': Number(layer.strokeWidth) || 2, 'stroke-linejoin': 'round' }, g); },
      update(scope) {
        const a = from(scope), b = to(scope);
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
        const pts = [];
        const n = coils * 2;
        for (let k = 0; k <= n + 2; k++) {
          const t = k === 0 ? 0 : k === n + 2 ? 1 : 0.06 + (k - 1) / n * 0.88;
          const side = k === 0 || k === n + 2 ? 0 : (k % 2 ? 1 : -1) * width / 2;
          pts.push(view.X(a[0] + dx * t + nx * side).toFixed(1) + ',' + view.Y(a[1] + dy * t + ny * side).toFixed(1));
        }
        sceneSet(this.node, { points: pts.join(' ') });
      }
    });
  }
  if (kind === 'pendulum') {
    // A real pendulum: θ'' = -(g/L)·sin θ - c·θ', integrated with the scene.
    const pivot = view.point(layer.pivot, [0, 0]);
    const length = view.fn(layer.length, 1), gravity = view.fn(layer.gravity, 9.81), damping = view.fn(layer.damping, 0);
    const id = layer.id;
    const sim = () => {
      if (!view.state.sim[id]) view.state.sim[id] = { th: (Number(layer.angle) || 30) * Math.PI / 180, w: 0, trail: [] };
      return view.state.sim[id];
    };
    return make({
      reset() { view.state.sim[id] = null; },
      expose(scope) {
        const s = sim(), p = pivot(scope), L = length(scope);
        scope[id + '_angle'] = s.th * 180 / Math.PI;
        scope[id + '_omega'] = s.w;
        scope[id + '_x'] = p[0] + L * Math.sin(s.th);
        scope[id + '_y'] = p[1] - L * Math.cos(s.th);
      },
      step(scope, h) {
        const s = sim(), L = Math.max(1e-3, length(scope)), g = gravity(scope), c = damping(scope);
        s.w += (-(g / L) * Math.sin(s.th) - c * s.w) * h;
        s.th += s.w * h;
      },
      mount(g) {
        this.trail = layer.trail === false ? null : sceneEl('polyline', { fill: 'none', stroke: color, 'stroke-width': 2, opacity: 0.25, 'stroke-linecap': 'round' }, g);
        this.rod = sceneEl('line', { stroke: '#475569', 'stroke-width': 2.5, 'stroke-linecap': 'round' }, g);
        this.pin = sceneEl('circle', { r: 4, fill: '#475569' }, g);
        this.bob = sceneEl('circle', { r: Math.max(4, Math.min(40, Number(layer.radius) || 14)), fill: color, stroke: '#fff', 'stroke-width': 2 }, g);
      },
      update(scope) {
        const s = sim(), p = pivot(scope), L = length(scope);
        const bx = p[0] + L * Math.sin(s.th), by = p[1] - L * Math.cos(s.th);
        sceneSet(this.rod, { x1: view.X(p[0]), y1: view.Y(p[1]), x2: view.X(bx), y2: view.Y(by) });
        sceneSet(this.pin, { cx: view.X(p[0]), cy: view.Y(p[1]) });
        sceneSet(this.bob, { cx: view.X(bx), cy: view.Y(by) });
        if (this.trail) {
          s.trail.push(view.X(bx).toFixed(1) + ',' + view.Y(by).toFixed(1));
          if (s.trail.length > 90) s.trail.shift();
          sceneSet(this.trail, { points: s.trail.join(' ') });
        }
      }
    });
  }
  if (kind === 'handle') {
    // A point the student drags (or moves with the arrow keys); its position is <id>_x, <id>_y.
    const id = layer.id;
    const start = Array.isArray(layer.at) ? layer.at.map(Number) : [0, 0];
    const bounds = (axis, value) => {
      const min = layer[axis + 'min'] != null ? Number(layer[axis + 'min']) : view.cam[axis + 'min'];
      const max = layer[axis + 'max'] != null ? Number(layer[axis + 'max']) : view.cam[axis + 'max'];
      return Math.min(max, Math.max(min, value));
    };
    const pos = () => { if (!view.state.sim[id]) view.state.sim[id] = start.slice(); return view.state.sim[id]; };
    const moved = () => vizRecordEvent(view.key, view.title, 'handle:' + id, 'moved «' + (layer.label || id) + '» to (' + vizFmt(pos()[0]) + ', ' + vizFmt(pos()[1]) + ')');
    return make({
      reset() { view.state.sim[id] = null; },
      expose(scope) { const p = pos(); scope[id + '_x'] = p[0]; scope[id + '_y'] = p[1]; },
      mount(g) {
        const r = Math.max(6, Math.min(30, Number(layer.r) || 10));
        this.halo = sceneEl('circle', { r: r + 8, fill: color, opacity: 0.15 }, g);
        this.node = sceneEl('circle', { r, fill: color, stroke: '#fff', 'stroke-width': 2.5, tabindex: 0, role: 'slider', class: 'scene-handle',
          'aria-label': 'Mover ' + (layer.label || id) + ' (flechas)', 'aria-valuetext': '' }, g);
        if (layer.label) this.text = sceneEl('text', { class: 'scene-label', 'text-anchor': 'middle' }, g);
        this.node.addEventListener('keydown', (event) => {
          const stepX = (view.cam.xmax - view.cam.xmin) / 50, stepY = (view.cam.ymax - view.cam.ymin) / 50;
          const delta = { ArrowLeft: [-stepX, 0], ArrowRight: [stepX, 0], ArrowUp: [0, stepY], ArrowDown: [0, -stepY] }[event.key];
          if (!delta) return;
          event.preventDefault();
          const p = pos();
          if (layer.axis !== 'y') p[0] = bounds('x', p[0] + delta[0]);
          if (layer.axis !== 'x') p[1] = bounds('y', p[1] + delta[1]);
          moved();
          if (!view.playing) { view.evaluate(0); view.draw(); }
        });
      },
      pointer: {
        down: (event, world) => {
          if (event.target !== base.node && event.target !== base.halo) return null;
          return { move: (w) => { const p = pos(); if (layer.axis !== 'y') p[0] = bounds('x', w[0]); if (layer.axis !== 'x') p[1] = bounds('y', w[1]); }, end: moved };
        }
      },
      update() {
        const p = pos();
        sceneSet(this.node, { cx: view.X(p[0]), cy: view.Y(p[1]), 'aria-valuetext': '(' + vizFmt(p[0]) + ', ' + vizFmt(p[1]) + ')' });
        sceneSet(this.halo, { cx: view.X(p[0]), cy: view.Y(p[1]) });
        if (this.text) { sceneSet(this.text, { x: view.X(p[0]), y: view.Y(p[1]) - 18 }); if (this.text.textContent !== layer.label) this.text.textContent = layer.label; }
      }
    });
  }
  if (kind === 'points') {
    // Tap empty space to add a point, tap a point to remove it: <id>_n, <id>_mx, <id>_my.
    const id = layer.id;
    const max = Math.max(1, Math.min(100, Number(layer.max) || 30));
    const list = () => { if (!view.state.sim[id]) view.state.sim[id] = (Array.isArray(layer.initial) ? layer.initial : []).filter(scenePointish).slice(0, max).map((p) => [Number(p[0]), Number(p[1])]); return view.state.sim[id]; };
    const changed = () => vizRecordEvent(view.key, view.title, 'points:' + id, (layer.label || id) + ': ' + list().length + ' points');
    return make({
      reset() { view.state.sim[id] = null; },
      clear() { view.state.sim[id] = []; changed(); },
      expose(scope) {
        const pts = list();
        scope[id + '_n'] = pts.length;
        scope[id + '_mx'] = pts.length ? pts.reduce((a, p) => a + p[0], 0) / pts.length : 0;
        scope[id + '_my'] = pts.length ? pts.reduce((a, p) => a + p[1], 0) / pts.length : 0;
      },
      mount(g) { this.group = g; this.line = layer.connect ? sceneEl('polyline', { fill: 'none', stroke: color, 'stroke-width': 2, opacity: 0.6 }, g) : null; this.nodes = []; },
      pointer: layer.editable === false ? null : {
        down: (event, world) => {
          const pts = list();
          const hit = pts.findIndex((p) => Math.hypot(view.X(p[0]) - view.X(world[0]), view.Y(p[1]) - view.Y(world[1])) < 14);
          if (hit >= 0) pts.splice(hit, 1);
          else if (pts.length < max) pts.push(world);
          changed();
          return { move() {}, end() {} };
        }
      },
      update() {
        const pts = list();
        while (this.nodes.length < pts.length) this.nodes.push(sceneEl('circle', { r: Math.max(3, Number(layer.r) || 6), fill: color, stroke: '#fff', 'stroke-width': 1.5 }, this.group));
        this.nodes.forEach((node, k) => {
          if (k >= pts.length) { node.style.display = 'none'; return; }
          node.style.display = '';
          sceneSet(node, { cx: view.X(pts[k][0]), cy: view.Y(pts[k][1]) });
        });
        if (this.line) sceneSet(this.line, { points: pts.slice().sort((a, b) => a[0] - b[0]).map((p) => view.X(p[0]).toFixed(1) + ',' + view.Y(p[1]).toFixed(1)).join(' ') });
      }
    });
  }
  if (kind === 'draw') {
    // Free drawing: <id>_n strokes, <id>_len total length in world units.
    const id = layer.id;
    const strokes = () => { if (!view.state.sim[id]) view.state.sim[id] = []; return view.state.sim[id]; };
    return make({
      clear() { view.state.sim[id] = []; },
      expose(scope) {
        const list = strokes();
        scope[id + '_n'] = list.length;
        scope[id + '_len'] = list.reduce((sum, s) => sum + s.reduce((acc, p, k) => (k ? acc + Math.hypot(p[0] - s[k - 1][0], p[1] - s[k - 1][1]) : 0), 0), 0);
      },
      mount(g) { this.group = g; this.nodes = []; },
      pointer: {
        down: (event, world) => {
          const list = strokes();
          if (list.length >= 30) list.shift();
          const stroke = [world];
          list.push(stroke);
          return {
            move: (w) => { if (stroke.length < 800) stroke.push(w); },
            end: () => vizRecordEvent(view.key, view.title, 'draw:' + id, 'drew ' + list.length + ' stroke(s)')
          };
        }
      },
      update() {
        const list = strokes();
        while (this.nodes.length < list.length) this.nodes.push(sceneEl('polyline', { fill: 'none', stroke: color, 'stroke-width': Math.max(1, Number(layer.width) || 3), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, this.group));
        this.nodes.forEach((node, k) => {
          if (k >= list.length) { node.style.display = 'none'; return; }
          node.style.display = '';
          sceneSet(node, { points: list[k].map((p) => view.X(p[0]).toFixed(1) + ',' + view.Y(p[1]).toFixed(1)).join(' ') });
        });
      }
    });
  }
  return null;
}

function vizScene(spec, state, context) {
  const errors = validateScene(spec);
  if (errors.length) return vizFallback(spec, errors.slice(0, 3).join(' · '), context && context.source);
  const view = new SceneView(spec, state, context && context.key || 'any:scene');
  return view.el;
}

/* ─── Sandbox ────────────────────────────────────────────────────────── */

const sandboxRegistry = new Map(); // id → { iframe, spec, view }

// Runs first inside the iframe: no network APIs, pausable frames and timers,
// a CPU budget, and window.inhouse.emit(name, data) for declared events.
function sandboxShim(id) {
  return '<script>(function(){"use strict";var ID=' + JSON.stringify(id) + ';var paused=false,cbs=new Map(),seq=0,slow=0;' +
    'function post(t,p){try{parent.postMessage({v:1,type:t,id:ID,payload:p},"*")}catch(e){}}' +
    '["fetch","XMLHttpRequest","WebSocket","EventSource","Worker","SharedWorker","RTCPeerConnection","importScripts"].forEach(function(n){try{Object.defineProperty(window,n,{value:undefined,configurable:false})}catch(e){}});' +
    'try{Object.defineProperty(navigator,"sendBeacon",{value:function(){return false}})}catch(e){}' +
    'try{window.open=function(){return null}}catch(e){}' +
    'var raf=window.requestAnimationFrame.bind(window);' +
    'window.requestAnimationFrame=function(cb){var k=++seq;cbs.set(k,cb);return k};window.cancelAnimationFrame=function(k){cbs.delete(k)};' +
    'function loop(ts){raf(loop);if(paused)return;var list=cbs;cbs=new Map();var t0=performance.now();list.forEach(function(cb){try{cb(ts)}catch(e){}});' +
    'var c=performance.now()-t0;slow=c>20?slow+1:Math.max(0,slow-1);if(slow>45){paused=true;slow=0;post("budget",{})}}raf(loop);' +
    'var st=window.setTimeout,si=window.setInterval;window.setTimeout=function(f,ms){var a=[].slice.call(arguments,2);function run(){if(paused)return st(run,100);if(typeof f==="function")f.apply(null,a)}return st(run,ms)};' +
    'window.setInterval=function(f,ms){var a=[].slice.call(arguments,2);return si(function(){if(!paused&&typeof f==="function")f.apply(null,a)},Math.max(16,ms||0))};' +
    'window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(!d||d.v!==1||d.id!==ID)return;if(d.type==="pause")paused=true;if(d.type==="play")paused=false});' +
    'window.inhouse={emit:function(n,data){var p;try{p=JSON.parse(JSON.stringify(data===undefined?null:data))}catch(e){p=null}post("emit",{name:String(n).slice(0,40),data:p})},paused:function(){return paused}};' +
    'window.addEventListener("load",function(){post("ready",{});var send=function(){post("resize",{height:Math.ceil(document.documentElement.scrollHeight)})};send();try{new ResizeObserver(send).observe(document.documentElement)}catch(e){}});' +
    'window.addEventListener("error",function(e){post("error",{message:String(e.message||"error").slice(0,200)})});' +
    '})();<\/script>';
}

function sandboxDocument(spec, id) {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; media-src data: blob:">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1a1a;background:transparent}canvas,svg{max-width:100%;display:block}</style>' +
    sandboxShim(id) + '</head><body>' + spec.html + '</body></html>';
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== 1 || typeof data.id !== 'string') return;
  const entry = sandboxRegistry.get(data.id);
  // Only the iframe we created for that id, and only the four message types.
  if (!entry || event.source !== entry.iframe.contentWindow) return;
  let size = 0;
  try { size = JSON.stringify(data.payload || null).length; } catch (_) { return; }
  if (size > 2048) return;
  entry.view.receive(data.type, data.payload || {});
});

class SandboxView {
  constructor(spec, state, key) {
    this.spec = spec;
    this.state = state;
    this.key = key;
    this.title = String(spec.title || 'Simulación');
    this.id = 'sbx' + vizHash(key) + (++vizSeq);
    this.emits = Array.isArray(spec.emit) ? spec.emit.map(String) : [];
    this.height = Math.max(120, Math.min(900, Number(state.height || spec.height) || 360));
    this.playing = state.playing !== false && !sceneRuntime.reduced;
    this.visible = false;
    const alt = spec.alt ? String(spec.alt) : this.title + '. Simulación interactiva.';
    this.el = vizElement('<div class="viz viz-scene viz-sandbox">' + vizHead('sandbox', spec.title) +
      '<div class="sandbox-frame"><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="' + escapeHtml(alt) + '" style="height:' + this.height + 'px"></iframe>' +
      '<div class="scene-note" aria-live="polite"></div></div>' +
      '<div class="scene-bar"><button type="button" class="scene-btn" data-scene="play" aria-label="Pausar animación" aria-pressed="true">' + SCENE_ICON.pause + '</button>' +
      '<button type="button" class="scene-btn" data-scene="reset" aria-label="Reiniciar">' + SCENE_ICON.reset + '</button>' +
      '<span class="sandbox-tag">Código del modelo · aislado y sin conexión</span><span class="scene-spacer"></span>' +
      '<button type="button" class="scene-btn text" data-scene="send">' + SCENE_ICON.send + 'Enviar al tutor</button></div>' +
      '<div class="scene-events"></div>' + (spec.caption ? '<div class="viz-caption">' + vizBlock(spec.caption) + '</div>' : '') + '</div>');
    this.iframe = this.el.querySelector('iframe');
    sandboxRegistry.set(this.id, { iframe: this.iframe, spec, view: this });
    this.load();
    this.el.querySelector('.scene-bar').addEventListener('click', (event) => {
      const button = event.target.closest('[data-scene]');
      if (!button) return;
      if (button.dataset.scene === 'play') this.setPlaying(!this.playing, true);
      if (button.dataset.scene === 'reset') this.load();
      if (button.dataset.scene === 'send') sendVisualToTutor(this.title, this.lastEvents.length ? 'eventos: ' + this.lastEvents.join('; ') : 'la he estado probando');
    });
    this.lastEvents = [];
    sceneRuntime.views.add(this);
    sceneObserve(this);
    this.syncBar();
  }

  load() {
    this.ready = false;
    this.iframe.srcdoc = sandboxDocument(this.spec, this.id);
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => { if (!this.ready) this.note('Esta simulación no ha arrancado.'); }, 4000);
  }

  receive(type, payload) {
    if (type === 'ready') {
      this.ready = true;
      this.note('');
      if (!this.playing || !this.visible) this.post('pause');
      if (sceneRuntime.reduced && this.state.playing == null) this.note('Animación en pausa (movimiento reducido). Pulsa ▶ para verla.');
    } else if (type === 'resize') {
      const height = Math.max(120, Math.min(900, Number(payload.height) || 0));
      if (height && Math.abs(height - this.height) > 2) { this.height = height; this.state.height = height; this.iframe.style.height = height + 'px'; }
    } else if (type === 'emit') {
      const name = String(payload.name || '');
      if (this.emits.length && !this.emits.includes(name)) return;
      let detail = '';
      try { detail = payload.data == null ? '' : JSON.stringify(payload.data).slice(0, 160); } catch (_) {}
      const text = name + (detail ? ' ' + detail : '');
      this.lastEvents.push(text);
      if (this.lastEvents.length > 5) this.lastEvents.shift();
      vizRecordEvent(this.key, this.title, 'emit:' + name, 'event ' + text);
      const box = this.el.querySelector('.scene-events');
      box.innerHTML = '<span class="scene-chip">✓ ' + escapeHtml(text) + '</span>';
    } else if (type === 'budget') {
      this.playing = false;
      this.syncBar();
      this.note('Pausada: estaba usando demasiada CPU. Pulsa ▶ para seguir.');
    } else if (type === 'error') {
      this.note('La simulación ha dado un error: ' + String(payload.message || '').slice(0, 120));
    }
  }

  post(type) {
    try { this.iframe.contentWindow.postMessage({ v: 1, type, id: this.id }, '*'); } catch (_) {}
  }

  setPlaying(playing, byUser) {
    this.playing = playing;
    if (byUser) this.state.playing = playing;
    if (playing) { sceneClaimSlot(this); this.note(''); }
    this.post(playing && this.visible ? 'play' : 'pause');
    this.syncBar();
  }

  pause(reason) {
    this.setPlaying(false);
    if (reason) this.note(reason);
  }

  onVisibility(visible) {
    this.post(visible && this.playing ? 'play' : 'pause');
  }

  advance() {}

  syncBar() {
    const button = this.el.querySelector('[data-scene="play"]');
    button.innerHTML = this.playing ? SCENE_ICON.pause : SCENE_ICON.play;
    button.setAttribute('aria-label', this.playing ? 'Pausar animación' : 'Reproducir animación');
    button.setAttribute('aria-pressed', this.playing ? 'true' : 'false');
  }

  note(text) {
    const box = this.el.querySelector('.scene-note');
    box.textContent = text || '';
    box.classList.toggle('on', !!text);
  }
}

function vizSandbox(spec, state, context) {
  const errors = validateSandbox(spec);
  if (errors.length) return vizFallback(spec, errors.join(' · '), context && context.source);
  return new SandboxView(spec, state, context && context.key || 'any:sandbox').el;
}

Object.assign(VIZ_RENDERERS, { scene: vizScene, animation: vizScene, simulation: vizScene, sandbox: vizSandbox });
Object.assign(VIZ_KIND_LABEL, { scene: 'Simulación', sandbox: 'Simulación libre' });
Object.assign(VIZ_ICON, {
  scene: '<circle cx="12" cy="12" r="9"/><polygon points="10 8 16 12 10 16 10 8"/>',
  sandbox: '<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="8 10 6 12 8 14"/><polyline points="16 10 18 12 16 14"/>'
});
