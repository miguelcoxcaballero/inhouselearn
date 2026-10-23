/* Guided Learning uses the real message DOM as a sequence of screens.
   No copied transcripts, duplicate simulations or second course state machine. */
const guidedStage = { chat: '', pages: [], current: '', latest: '', user: '', quiz: '', frame: 0, nav: null };

function scheduleGuidedStage() {
  if (guidedStage.frame) return;
  guidedStage.frame = requestAnimationFrame(() => { guidedStage.frame = 0; syncGuidedStage(); });
}

function guidedStageActive() {
  return document.querySelector('.chat')?.classList.contains('guided-stage');
}

function syncGuidedStage() {
  if (typeof getActiveChat !== 'function') return;
  const chat = getActiveChat(), shell = document.querySelector('.chat'), thread = document.getElementById('thread');
  if (!shell || !thread) return;
  const enabled = !!chat?.guidedLearning;
  const history = enabled && sessionGet('guided-history::' + chat.id) === '1';
  const articles = Array.from(thread.querySelectorAll(':scope > [data-msg-id]'));
  const messages = new Map((chat?.messages || []).map(message => [message.id, message]));
  const pages = articles.filter(article => {
    const message = messages.get(article.dataset.msgId);
    return message?.role === 'assistant' && !message.hidden && (message.pending || message.content?.trim() || message.guidedCards?.length || message.thinking);
  });
  const on = enabled && !history && pages.length > 0;
  shell.classList.toggle('guided-stage', on);
  shell.classList.toggle('guided-history', enabled && history);
  if (!guidedStage.nav) {
    const nav = document.createElement('nav');
    nav.className = 'g-screen-nav'; nav.setAttribute('aria-label', 'Pantallas de aprendizaje');
    nav.innerHTML = '<button type="button" data-screen="history" class="g-screen-history" title="Ver conversación" aria-label="Ver conversación"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4h16v12H9l-5 4z"/><path d="M8 8h8M8 12h5"/></svg></button><button type="button" data-screen="prev" aria-label="Pantalla anterior">←</button><span class="g-screen-count" role="status" aria-live="polite"></span><button type="button" data-screen="next" class="g-screen-next"></button>';
    const help = document.createElement('button');
    help.type = 'button'; help.dataset.screen = 'help'; help.className = 'g-screen-help'; help.textContent = '?';
    help.title = 'No lo entiendo · explícamelo de otra forma'; help.setAttribute('aria-label', 'No lo entiendo');
    nav.insertBefore(help, nav.querySelector('[data-screen="next"]'));
    shell.insertBefore(nav, shell.querySelector('.composer-area'));
    nav.addEventListener('click', event => {
      const action = event.target.closest('[data-screen]')?.dataset.screen;
      if (action === 'history') {
        const active = getActiveChat();
        sessionSet('guided-history::' + active.id, sessionGet('guided-history::' + active.id) === '1' ? '0' : '1');
        syncGuidedStage();
        document.querySelector('[data-msg-id="' + guidedStage.current + '"]')?.scrollIntoView({ block: 'start' });
      } else if (action === 'help') {
        if (!appState.busy) guidedSend(getActiveChat(), GUIDED_QUICK.confused.text, { kind: 'confused' });
      } else if (action) moveGuidedScreen(action === 'prev' ? -1 : 1, true);
    });
    guidedStage.nav = nav;
  }
  const nav = guidedStage.nav;
  nav.hidden = !enabled || !pages.length;
  nav.querySelector('[data-screen="history"]').setAttribute('aria-label', history ? 'Volver a las pantallas' : 'Ver conversación');
  nav.querySelector('[data-screen="history"]').title = history ? 'Volver a las pantallas' : 'Ver conversación';
  nav.querySelector('[data-screen="history"]').setAttribute('aria-pressed', String(history));
  const latest = pages.at(-1)?.dataset.msgId || '';
  const user = (chat?.messages || []).filter(message => message.role === 'user' && !message.hidden).at(-1)?.id || '';
  const course = chat?.course;
  const quiz = course && (pendingQuiz(course, 'check') || pendingQuiz(course, 'exam') || pendingQuiz(course, 'review'));
  const quizPage = quiz && pages.find(page => page.querySelector('[data-g-quiz="' + quiz.id + '"]'));
  const changedChat = guidedStage.chat !== chat?.id;
  const previous = guidedStage.current;
  if (changedChat) guidedStage.current = sessionGet('guided-screen::' + chat?.id) || latest;
  if (!pages.some(page => page.dataset.msgId === guidedStage.current)) guidedStage.current = latest;
  if (!changedChat && (guidedStage.current === guidedStage.latest || guidedStage.user !== user) && latest !== guidedStage.latest) guidedStage.current = latest;
  if (quizPage && (changedChat || guidedStage.quiz !== quiz.id)) guidedStage.current = quizPage.dataset.msgId;
  Object.assign(guidedStage, { chat: chat?.id, pages, latest, user, quiz: quiz?.id || '' });
  articles.forEach(article => { article.hidden = on && article.dataset.msgId !== guidedStage.current; article.classList.toggle('g-screen-pending', !!messages.get(article.dataset.msgId)?.pending); });
  if (!on) thread.querySelectorAll('.g-reading-toggle').forEach(button => { button.hidden = true; });
  const active = pages.find(page => page.dataset.msgId === guidedStage.current);
  const index = pages.indexOf(active);
  if (on) {
    compactGuidedReading(active);
    sessionSet('guided-screen::' + chat.id, guidedStage.current);
    active?.classList.add('g-screen');
    if (previous !== guidedStage.current || changedChat) {
      document.querySelector('.thread-wrap').scrollTop = 0;
      if (!changedChat && previous) animateGuidedScreen(active, 1);
    }
  }
  const count = nav.querySelector('.g-screen-count');
  const text = history ? 'Conversación' : (index + 1) + ' / ' + pages.length;
  if (count.textContent !== text) count.textContent = text;
  count.setAttribute('aria-label', history ? text : 'Pantalla ' + (index + 1) + ' de ' + pages.length);
  nav.querySelector('[data-screen="help"]').disabled = appState.busy || course?.status !== 'learning';
  nav.querySelector('[data-screen="prev"]').disabled = history || index <= 0;
  const next = nav.querySelector('[data-screen="next"]');
  const more = index < pages.length - 1;
  next.disabled = history || (!more && (appState.busy || !!quiz || course?.status !== 'learning'));
  const nextLabel = more ? 'Siguiente →' : appState.busy ? 'Preparando…' : quiz ? 'Resuelve el ejercicio' : course?.status === 'learning' ? (currentLesson(course)?.phase === 'apply' ? 'Comprobar →' : 'Lo entiendo →') : 'Última pantalla';
  if (next.textContent !== nextLabel) next.textContent = nextLabel;
  if (typeof syncWaitingPractice === 'function') syncWaitingPractice(chat, on);
}

function compactGuidedReading(article) {
  const root = article?.querySelector('.md-root');
  if (!root) return;
  const prose = Array.from(root.children).filter(node => !node.matches('.viz,.stream-anchor,.stream-caret') && !node.querySelector('.viz') && node.textContent.trim());
  const words = prose.reduce((count, node) => count + node.textContent.trim().split(/\s+/).length, 0);
  const illustrated = !!root.querySelector('.viz-explain');
  const compact = words > 65 || (illustrated && prose.length > 0);
  prose.forEach((node, index) => { node.classList.toggle('g-reading-detail', compact && (illustrated || index > 0)); node.classList.toggle('g-reading-intro', compact && !illustrated && index === 0); });
  let button = article.querySelector('.g-reading-toggle');
  if (!button && compact) {
    button = document.createElement('button'); button.type = 'button'; button.className = 'g-reading-toggle';
    root.after(button);
    button.addEventListener('click', () => {
      const expanded = !article.classList.contains('g-reading-expanded');
      article.classList.toggle('g-reading-expanded', expanded);
      sessionSet('guided-reading::' + article.dataset.msgId, expanded ? '1' : '0');
      button.setAttribute('aria-expanded', String(expanded)); button.textContent = expanded ? 'Ocultar explicación' : 'Ver explicación';
    });
  }
  if (button) {
    button.hidden = !compact;
    const expanded = sessionGet('guided-reading::' + article.dataset.msgId) === '1';
    article.classList.toggle('g-reading-expanded', expanded);
    button.setAttribute('aria-expanded', String(expanded));
    const label = expanded ? 'Ocultar explicación' : 'Ver explicación';
    if (button.textContent !== label) button.textContent = label;
  }
}

function animateGuidedScreen(element, direction) {
  if (!element) return;
  element.getAnimations().forEach(animation => animation.cancel());
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  element.animate([{ opacity: 0, transform: 'translateX(' + direction * Math.min(160, element.clientWidth * .22) + 'px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' });
}

function moveGuidedScreen(direction, continueLesson = false) {
  if (!guidedStageActive()) return;
  const pages = guidedStage.pages, index = pages.findIndex(page => page.dataset.msgId === guidedStage.current);
  const target = pages[index + direction];
  if (!target) {
    const chat = getActiveChat(), course = chat?.course;
    if (continueLesson && direction > 0 && !appState.busy && course?.status === 'learning' && !['check','exam','review'].some(kind => pendingQuiz(course, kind))) {
      const quick = currentLesson(course)?.phase === 'apply' ? GUIDED_QUICK.test : GUIDED_QUICK.next;
      guidedSend(chat, quick.text, { kind: quick.kind });
    }
    return;
  }
  guidedStage.current = target.dataset.msgId;
  syncGuidedStage();
  document.querySelector('.thread-wrap').scrollTop = 0;
  animateGuidedScreen(target, direction);
}

function revealGuidedElement(element) {
  if (!guidedStageActive()) return false;
  const page = element?.closest('[data-msg-id]');
  if (!page) return false;
  guidedStage.current = page.dataset.msgId;
  syncGuidedStage();
  element.scrollIntoView({ block: 'start' });
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  const thread = document.getElementById('thread');
  if (!thread) return;
  new MutationObserver(scheduleGuidedStage).observe(thread, { childList: true, subtree: true });
  const wrap = thread.parentElement;
  wrap.addEventListener('keydown', event => {
    if (!guidedStageActive() || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,button,a,[contenteditable],.viz')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); moveGuidedScreen(event.key === 'ArrowRight' ? 1 : -1); }
  });
  let start = null;
  wrap.addEventListener('pointerdown', event => {
    start = guidedStageActive() && event.pointerType === 'touch' && !event.target.closest('input,textarea,button,a,.viz,.g-options,.g-numeric') ? { x: event.clientX, y: event.clientY } : null;
  }, { passive: true });
  wrap.addEventListener('pointerup', event => {
    if (!start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y; start = null;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 35 && !getSelection()?.toString()) moveGuidedScreen(dx < 0 ? 1 : -1);
  }, { passive: true });
  wrap.addEventListener('pointercancel', () => { start = null; });
  scheduleGuidedStage();
});
