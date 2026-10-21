/* ─── Haptics ────────────────────────────────────────────────────────
   Light, ChatGPT-style feedback: a soft tick on taps, a firmer one when a
   message goes out, a gentle continuous texture while the answer streams
   in, a "done" pulse when it ends and a double knock on errors or wrong
   answers. In the Android app the shell plays them with the system's own
   haptic feedback ({type: 'haptic', style}), which follows the phone's
   haptics setting; in a mobile browser navigator.vibrate is the fallback.
   The switch in the profile menu turns them off (stored per device).

   Loaded before the main script of index.html; ANDROID_APP and
   androidAppMessage are read at call time. */

const HAPTICS_KEY = 'inhouse-learn-haptics';
const HAPTIC_PATTERNS = { tick: 4, select: 8, light: 10, send: 14, success: [10, 60, 16], error: [18, 50, 18], drag: 3 };
const HAPTIC_GAP = { tick: 70, drag: 45 };
const hapticLast = {};

function hapticsEnabled() {
  try { return localStorage.getItem(HAPTICS_KEY) !== '0'; } catch (_) { return true; }
}

function setHapticsEnabled(on) {
  try { localStorage.setItem(HAPTICS_KEY, on ? '1' : '0'); } catch (_) {}
}

function haptic(style) {
  if (!HAPTIC_PATTERNS[style] || !hapticsEnabled() || document.hidden) return;
  const now = performance.now();
  if (HAPTIC_GAP[style] && now - (hapticLast[style] || 0) < HAPTIC_GAP[style]) return;
  hapticLast[style] = now;
  try {
    if (typeof ANDROID_APP !== 'undefined' && ANDROID_APP) { androidAppMessage({ type: 'haptic', style }); return; }
    // Browsers: only on touch devices, where a vibration means something.
    if (navigator.vibrate && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) navigator.vibrate(HAPTIC_PATTERNS[style]);
  } catch (_) {}
}

// A soft tick for every tappable thing that has no feedback of its own.
const HAPTIC_TAPS = '.chip, .g-quick-btn, .g-tweak, .g-pill, .g-link, .model-card, .filter-chip, .msg-action-btn, .msg-nav-btn, .scene-btn, .viz-btn, .viz-card, .viz-mini, ' +
  '.g-course-bar, #guided-btn, #new-chat-btn, #attach-btn, .chat-item, .g-secondary, .thread-jump, summary, .latex-bar-btn, .viz-more, [data-ask-visual]';
document.addEventListener('click', (event) => {
  const target = event.target.closest(HAPTIC_TAPS);
  if (target && !target.disabled) haptic('select');
}, true);
