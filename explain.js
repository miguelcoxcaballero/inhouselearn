/* A causal walkthrough shares one scene, one camera and stable object identity.
   Presets are authored examples, not a claim that a transition simulates time. */
function explainScene(spec) {
  return Object.assign({}, spec.scene, { type: 'scene', title: spec.title, responsive: true, width: 800, height: 480 });
}

function validateExplain(spec) {
  const errors = [];
  if (!spec?.scene || typeof spec.scene !== 'object') return ['explain needs a scene'];
  errors.push(...validateScene(explainScene(spec)));
  if (!Array.isArray(spec.steps) || spec.steps.length < 2 || spec.steps.length > 5) errors.push('Use 2–5 steps: initial state, change, visible consequence.');
  const controls = new Map((spec.scene.controls || []).map(control => [control.id, control]));
  const ids = new Set((spec.scene.layers || []).map(layer => layer.id).filter(Boolean));
  (Array.isArray(spec.steps) ? spec.steps : []).forEach((step, index) => {
    if (!step || !step.title || !step.body) { errors.push('Step ' + index + ' needs title and body'); return; }
    if (step.focus && (!Array.isArray(step.focus) || step.focus.some(id => !ids.has(id)))) errors.push('Step ' + index + ': focus must reference layer ids');
    Object.entries(step.set || {}).forEach(([id, value]) => {
      const control = controls.get(id);
      if (!control || !['slider','toggle'].includes(control.kind)) errors.push('Step ' + index + ': unknown slider/toggle ' + id);
      else if (typeof value !== 'number' || !Number.isFinite(value) || (control.kind === 'slider' && (value < control.min || value > control.max)) || (control.kind === 'toggle' && value !== 0 && value !== 1)) errors.push('Step ' + index + ': value outside control range for ' + id);
    });
  });
  return errors;
}

function vizExplain(spec, state, context) {
  const errors = validateExplain(spec);
  if (errors.length) return vizFallback(spec, errors.slice(0, 4).join(' · '), context?.source);
  state.step = Math.max(0, Math.min(spec.steps.length - 1, Number(state.step) || 0));
  state.scene ||= { playing: false };
  const view = new SceneView(explainScene(spec), state.scene, context?.key || 'any:explain');
  view.pause();
  const el = vizElement('<section class="viz viz-explain">' + vizHead('explain', spec.title) +
    (spec.question ? '<p class="ex-question">' + vizInline(spec.question) + '</p>' : '') +
    '<div class="ex-layout"><div class="ex-drawing"></div><div class="ex-story"><div class="ex-steps" role="group" aria-label="Pasos de la explicación">' +
    spec.steps.map((step, index) => '<button type="button" data-ex-step="' + index + '" aria-label="Paso ' + (index + 1) + ': ' + escapeHtml(step.title) + '"><span>' + (index + 1) + '</span>' + escapeHtml(step.title) + '</button>').join('') +
    '</div><div class="ex-description" aria-live="polite"></div><div class="ex-actions"><button type="button" data-ex-before aria-pressed="false">Comparar con el inicio</button><button type="button" data-ex-next></button></div></div></div>' +
    (spec.takeaway ? '<details class="ex-takeaway"><summary>La idea clave</summary><div>' + vizBlock(spec.takeaway) + '</div></details>' : '') +
    (spec.assumption ? '<p class="ex-assumption">' + vizInline(spec.assumption) + '</p>' : '') + '</section>');
  el.querySelector('.ex-drawing').appendChild(view.el);
  view.el.querySelectorAll('.viz-head,.viz-title').forEach(node => node.remove());
  // Expose the same live view to preflight checks, without cloning any DOM.
  el.__explainView = view;
  const defaults = Object.fromEntries(view.controls.filter(c => c.kind !== 'button').map(c => [c.id, Number(c.value ?? c.min ?? 0)]));
  let before = false;
  const show = (apply, animate) => {
    const index = before ? 0 : state.step, step = spec.steps[index];
    if (apply) {
      state.exploring = false;
      Object.assign(view.state.values, defaults);
      for (let i = 0; i <= index; i++) Object.assign(view.state.values, spec.steps[i].set || {});
      view.pause(); view.resetSim();
      view.el.querySelectorAll('[data-scene-control]').forEach(input => {
        const value = view.state.values[input.dataset.sceneControl];
        if (input.type === 'checkbox') input.checked = !!value; else input.value = value;
        const output = input.parentElement.querySelector('output'), control = view.controls.find(c => c.id === input.dataset.sceneControl);
        if (output) output.textContent = vizFmt(value) + (control.unit ? ' ' + control.unit : '');
      });
    }
    el.classList.toggle('ex-exploring', !!state.exploring);
    el.querySelectorAll('[data-ex-step]').forEach(button => button.setAttribute('aria-pressed', String(!state.exploring && Number(button.dataset.exStep) === index)));
    view.layers.forEach(layer => layer.g.classList.toggle('ex-dim', !state.exploring && !!step.focus?.length && !step.focus.includes(layer.layer.id)));
    const description = el.querySelector('.ex-description');
    description.innerHTML = state.exploring
      ? '<span class="ex-kicker">Exploración libre</span><h3>Ahora prueba tú</h3><p>Observa qué cambia y qué permanece igual. Vuelve a un paso para recuperar el ejemplo.</p>'
      : '<span class="ex-kicker">' + (before ? 'Estado inicial' : 'Paso ' + (index + 1) + ' de ' + spec.steps.length) + '</span><h3>' + vizInline(step.title) + '</h3>' + vizBlock(step.body) +
        (step.equation ? '<div class="ex-equation">' + vizInline(step.equation) + '</div>' : '') +
        (step.notice ? '<p class="ex-notice"><b>Fíjate en esto</b> ' + vizInline(step.notice) + '</p>' : '');
    const compare = el.querySelector('[data-ex-before]');
    compare.disabled = state.step === 0 || !!state.exploring;
    compare.setAttribute('aria-pressed', String(before));
    compare.textContent = before ? 'Volver al cambio' : 'Comparar con el inicio';
    const next = el.querySelector('[data-ex-next]');
    next.textContent = state.exploring ? 'Volver al ejemplo' : state.step === spec.steps.length - 1 ? 'Volver al inicio ↺' : 'Ver qué ocurre →';
    enhanceRichContent(description, { renderMath: true, latexPreview: false });
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      view.svg.getAnimations().forEach(animation => animation.cancel());
      view.svg.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
    }
  };
  el.addEventListener('click', event => {
    const button = event.target.closest('[data-ex-step],[data-ex-before],[data-ex-next]');
    if (!button) return;
    if (button.hasAttribute('data-ex-step')) { state.step = Number(button.dataset.exStep); before = false; }
    else if (button.hasAttribute('data-ex-before')) before = !before;
    else { if (!state.exploring) state.step = (state.step + 1) % spec.steps.length; before = false; }
    show(true, true);
    vizRecordEvent(context?.key || 'any:explain', spec.title, 'walkthrough', 'Viewed step ' + ((before ? 0 : state.step) + 1) + ': ' + spec.steps[before ? 0 : state.step].title + '. ' + view.summary());
  });
  view.el.addEventListener('input', event => { if (event.target.matches('[data-scene-control]')) { state.exploring = true; before = false; show(false); } });
  view.el.addEventListener('click', event => { if (event.target.closest('[data-scene="play"],[data-scene="reset"],[data-scene-button]')) { state.exploring = true; before = false; show(false); } });
  show(!state.exploring, false);
  return el;
}

/* Real browser measurements at phone and desktop widths. No author JS runs.
   Geometry warnings are not a certificate of scientific correctness. */
async function checkLearningDiagram(params) {
  let spec;
  try { spec = JSON.parse(params.spec); } catch (_) { return { isError: true, text: 'Invalid JSON. Pass a single visual specification in spec.' }; }
  if (!['scene','explain','image'].includes(spec?.type) || (spec.type === 'image' && !spec.svg)) return { isError: true, text: 'Use scene, explain, or image with inline svg. No scripts or remote images.' };
  const errors = spec.type === 'explain' ? validateExplain(spec) : spec.type === 'scene' ? validateScene(spec) : [];
  if (JSON.stringify(spec).length > 100000) errors.push('Diagram exceeds 100 KB. Simplify it.');
  if (errors.length) return { isError: true, text: errors.join('\n') };
  const findings = [], sizes = [360, 960];
  for (const width of sizes) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-12000px;top:0;visibility:hidden;pointer-events:none;width:' + width + 'px';
    document.body.appendChild(host);
    let view;
    try {
      if (spec.type === 'image') {
        const template = document.createElement('template');
        template.innerHTML = vizSafeSvg(spec.svg);
        template.content.querySelectorAll('image,use,feImage,a,animate,animateTransform,set').forEach(node => node.remove());
        template.content.querySelectorAll('*').forEach(node => {
          for (const attr of Array.from(node.attributes)) {
            if (/href$/i.test(attr.name) || /url\(\s*['"]?(?!#)/i.test(attr.value)) node.removeAttribute(attr.name);
          }
        });
        host.appendChild(template.content);
        const svg = host.querySelector('svg');
        if (!svg) { findings.push('SVG could not be safely parsed.'); continue; }
        svg.style.width = '100%'; svg.style.height = 'auto';
      } else {
        const scene = spec.type === 'explain' ? explainScene(spec) : { ...spec, responsive: true };
        view = new SceneView(scene, { playing: false }, 'preflight:' + width + ':' + (++vizSeq));
        view.pause(); host.appendChild(view.el); view.fitLabels();
      }
      const states = spec.type === 'explain' ? spec.steps : [null];
      for (let index = 0; index < states.length; index++) {
        if (view && states[index]) { Object.assign(view.state.values, states[index].set || {}); view.resetSim(); }
        const svg = host.querySelector('svg.scene-svg') || host.querySelector('svg');
        const box = svg.getBoundingClientRect();
        const labels = Array.from(svg.querySelectorAll('text')).filter(label => label.textContent.trim() && getComputedStyle(label).display !== 'none' && !label.closest('[style*="display: none"]'));
        const prefix = width + 'px' + (states[index] ? ', step ' + (index + 1) : '') + ': ';
        const rects = labels.map(label => ({ text: label.textContent.slice(0, 50), rect: label.getBoundingClientRect(), label }));
        for (let i = 0; i < rects.length; i++) {
          const a = rects[i], r = a.rect;
          if (!r.width || !r.height) continue;
          if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) findings.push(prefix + 'label outside drawing: ' + a.text);
          const matrix = a.label.getScreenCTM();
          const pixels = parseFloat(getComputedStyle(a.label).fontSize) * Math.hypot(matrix?.c ?? 0, matrix?.d ?? 1);
          if (pixels < 12) findings.push(prefix + 'label too small (' + Math.round(pixels) + 'px): ' + a.text);
          for (let j = i + 1; j < rects.length; j++) {
            const b = rects[j].rect;
            if (Math.min(r.right,b.right)-Math.max(r.left,b.left)>2 && Math.min(r.bottom,b.bottom)-Math.max(r.top,b.top)>2) findings.push(prefix + 'overlapping labels: ' + a.text + ' / ' + rects[j].text);
          }
        }
        if (view?.errors.length) findings.push(...view.errors.map(error => prefix + error));
      }
    } catch (error) { findings.push(width + 'px: ' + String(error.message).slice(0, 200)); }
    finally {
      if (view) { view.pause(); sceneRuntime.views.delete(view); sceneRuntime.startedAt.delete(view); sceneRuntime.observer?.unobserve(view.el); sceneRuntime.resizeObserver?.unobserve(view.el); }
      host.remove();
    }
  }
  const unique = [...new Set(findings)].slice(0, 24);
  return { text: unique.length ? 'Revise the diagram and call check_diagram again with the corrected spec:\n' + unique.join('\n') : 'No label overlaps, clipping or tiny text detected at 360px and 960px in the checked states. Independently verify physics, units, arrow meanings and causal claims; this layout check does not verify those. Use exactly this spec when publishing.', details: { warnings: unique } };
}

Object.assign(VIZ_RENDERERS, { explain: vizExplain });
Object.assign(VIZ_KIND_LABEL, { explain: 'Míralo paso a paso' });
Object.assign(VIZ_ICON, { explain: '<path d="M3 12h18M15 6l6 6-6 6"/><circle cx="5" cy="12" r="3"/>' });
