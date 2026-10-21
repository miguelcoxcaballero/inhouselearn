/* Shared transitions for discrete interactive updates. State changes immediately;
   only presentation interpolates. Rapid input starts from the current position. */
const interactiveMotion = {
  roots: new WeakMap(), active: new Set(),
  preference: window.matchMedia('(prefers-reduced-motion: reduce)'),
  duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
};

function motionNodes(root) {
  const selector = '[data-motion-key], .px-chip, .px-tf-row, .px-result, .px-expl, .viz-step, .viz-step-result, .viz-check-feedback, .viz-foot, .g-card-foot, .viz-deck, .viz-flash-bar';
  const nodes = Array.from(root.querySelectorAll(selector));
  const selected = new Set(nodes);
  const counts = {};
  return nodes.filter((node) => {
    for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (selected.has(parent)) return false;
    }
    return true;
  }).map((node) => {
    const kind = node.classList[0] || node.tagName;
    const index = counts[kind] || 0;
    counts[kind] = index + 1;
    const key = node.dataset.motionKey || (node.dataset.item != null ? 'item:' + node.dataset.item : kind + ':' + index);
    return { node, key };
  });
}

function motionFocusKey(node) {
  if (!node || !node.getAttribute) return '';
  const item = node.closest('[data-motion-key]');
  if (item && !node.hasAttribute('data-g-answer')) {
    return item.dataset.motionKey + ':' + node.tagName + ':' + node.classList[0] + ':' + (node.getAttribute('aria-label') || '');
  }
  for (const name of ['data-g-answer', 'data-g-submit', 'data-item', 'data-px', 'data-flash', 'data-step', 'data-answer', 'data-opt', 'data-blank']) {
    if (node.hasAttribute(name)) return name + ':' + node.getAttribute(name);
  }
  return '';
}

function interactiveUpdate(root, mutate) {
  const connected = root && root.isConnected;
  const focus = connected && root.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = motionFocusKey(focus);
  const enabled = connected && !document.hidden && !interactiveMotion.preference.matches && typeof root.animate === 'function';
  const box = enabled ? root.getBoundingClientRect() : null;
  const before = new Map();
  if (enabled) motionNodes(root).forEach(({ node, key }) => {
    const rect = node.getBoundingClientRect();
    if (rect.width && rect.height) before.set(key, { x: rect.left - box.left, y: rect.top - box.top, html: node.outerHTML });
  });
  // Measure first: cancelling must not snap an interrupted transition to its end.
  for (const animation of interactiveMotion.roots.get(root) || []) animation.cancel();
  const next = mutate() || root;
  if (focus && (!focus.isConnected || focus.disabled || !focus.getClientRects().length)) {
    const controls = Array.from(next.querySelectorAll('button, input, select, [tabindex]'))
      .filter((node) => !node.disabled && !node.hidden && node.getClientRects().length);
    const target = controls.find((node) => focusKey && motionFocusKey(node) === focusKey) || controls[0];
    if (target) target.focus({ preventScroll: true });
  }
  if (!enabled || !next.isConnected) return next;
  const end = next.getBoundingClientRect();
  const animations = [];
  const play = (node, frames) => {
    const animation = node.animate(frames, { duration: interactiveMotion.duration, easing: interactiveMotion.easing });
    animations.push(animation);
    interactiveMotion.active.add(animation);
    animation.finished.then(() => interactiveMotion.active.delete(animation), () => interactiveMotion.active.delete(animation));
  };
  if (Math.abs(box.height - end.height) > 1) {
    play(next, [{ height: box.height + 'px', overflow: 'clip' }, { height: end.height + 'px', overflow: 'clip' }]);
  }
  motionNodes(next).forEach(({ node, key }) => {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const old = before.get(key);
    const dx = old ? old.x - (rect.left - end.left) : 0;
    const dy = old ? old.y - (rect.top - end.top) : 6;
    const changed = !old || old.html !== node.outerHTML;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || changed) {
      play(node, [{ transform: 'translate(' + dx + 'px,' + dy + 'px)', opacity: changed ? 0.65 : 1 }, { transform: 'translate(0,0)', opacity: 1 }]);
    }
  });
  interactiveMotion.roots.set(next, animations);
  return next;
}

function stopInteractiveMotion() {
  for (const animation of interactiveMotion.active) animation.cancel();
  interactiveMotion.active.clear();
}
interactiveMotion.preference.addEventListener('change', () => { if (interactiveMotion.preference.matches) stopInteractiveMotion(); });
window.addEventListener('resize', stopInteractiveMotion, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopInteractiveMotion(); });
