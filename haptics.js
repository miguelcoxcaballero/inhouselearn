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
Object.assign(HAPTIC_PATTERNS, { answer: [8, 35, 16], combo: [8, 30, 12, 40, 20], complete: [12, 45, 20, 60, 28], retry: 10 });
const HAPTIC_EXERCISES = { answer: [[0,'success']], combo: [[0,'success'],[90,'tick'],[180,'success']], complete: [[0,'success'],[110,'light'],[230,'success']], retry: [[0,'light']] };
let hapticTimers = [], hapticPriorityUntil = 0;
function cancelExerciseHaptics() {
  hapticTimers.forEach(clearTimeout); hapticTimers = []; hapticPriorityUntil = 0;
  try { navigator.vibrate?.(0); } catch (_) {}
}
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelExerciseHaptics(); });
const HAPTIC_GAP = { tick: 70, drag: 45 };
const hapticLast = {};

function hapticsEnabled() {
  try { return localStorage.getItem(HAPTICS_KEY) !== '0'; } catch (_) { return true; }
}

function setHapticsEnabled(on) {
  try { localStorage.setItem(HAPTICS_KEY, on ? '1' : '0'); } catch (_) {}
  if (!on) cancelExerciseHaptics();
}

function haptic(style) {
  if (!HAPTIC_PATTERNS[style] || !hapticsEnabled() || document.hidden) return;
  const now = performance.now();
  const exercise = HAPTIC_EXERCISES[style];
  if (!exercise && (now < hapticPriorityUntil || (document.querySelector('.guided-waiting') && ['tick','success'].includes(style)))) return;
  if (exercise) { cancelExerciseHaptics(); hapticPriorityUntil = now + 350; }
  if (HAPTIC_GAP[style] && now - (hapticLast[style] || 0) < HAPTIC_GAP[style]) return;
  hapticLast[style] = now;
  try {
    if (typeof ANDROID_APP !== 'undefined' && ANDROID_APP) {
      if (exercise) exercise.forEach(([delay, nativeStyle]) => {
        const fire = () => { if (hapticsEnabled() && !document.hidden) androidAppMessage({ type: 'haptic', style: nativeStyle }); };
        if (!delay) fire(); else hapticTimers.push(setTimeout(fire, delay));
      });
      else androidAppMessage({ type: 'haptic', style });
      return;
    }
    // Browsers: only on touch devices, where a vibration means something.
    if (navigator.vibrate && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) navigator.vibrate(HAPTIC_PATTERNS[style]);
  } catch (_) {}
}

// A soft tick for every tappable thing that has no feedback of its own.
const HAPTIC_TAPS = '.chip, .g-quick-btn, .g-tweak, .g-pill, .g-link, .model-card, .filter-chip, .msg-action-btn, .msg-nav-btn, .scene-btn, .viz-btn, .viz-card, .viz-mini, ' +
  '.g-course-bar, #guided-btn, #new-chat-btn, #attach-btn, .chat-item, .g-secondary, .thread-jump, summary, .latex-bar-btn, .viz-more';
document.addEventListener('click', (event) => {
  const target = event.target.closest(HAPTIC_TAPS);
  if (target && !target.disabled) haptic('select');
}, true);

// Immediate, short feedback; no modal, score inflation or forced delay.
function exerciseFeedback(right, streak = 0, complete = false, root) {
  haptic(!right ? 'retry' : complete ? 'complete' : streak >= 3 ? 'combo' : 'answer');
  if (!root || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const mark = [...root.querySelectorAll('.g-q-mark,.gw-feedback-mark')].at(-1);
  if (!mark) return;
  mark.getAnimations().forEach(animation => animation.cancel());
  const animation = mark.animate(right ? [{ transform: 'scale(.65)' }, { transform: 'scale(1.2)', offset: .55 }, { transform: 'scale(1)' }]
    : [{ transform: 'translateX(0)' }, { transform: 'translateX(3px)', offset: .4 }, { transform: 'translateX(0)' }],
    { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' });
  if (typeof interactiveMotion !== 'undefined') {
    interactiveMotion.active.add(animation);
    animation.finished.then(() => interactiveMotion.active.delete(animation), () => interactiveMotion.active.delete(animation));
  }
}
function guidedAnswerFeedback(quiz, index) {
  const right = GuidedLearning.correct(quiz.questions[index], quiz.answers[index]);
  let streak = 0;
  for (let i = index; i >= 0 && GuidedLearning.correct(quiz.questions[i], quiz.answers[i]); i--) streak++;
  exerciseFeedback(right, streak, quiz.questions.every((_, i) => quiz.answers[i] !== undefined), document.querySelector('[data-g-quiz="' + quiz.id + '"] [data-motion-key="question:' + index + '"]'));
}
