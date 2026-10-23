/* Local practice while the tutor works. It never changes the active quiz,
   lesson phase, messages or memory scores, and never sends another model call. */
const guidedWaiting = { rounds: new Map(), offsets: new Map(), started: new Map(), timer: 0, host: null };
function waitingMessage(chat) {
  return [...(chat?.messages || [])].reverse().find(message => message.role === 'assistant' && message.pending && !message.hidden);
}
function syncWaitingPractice(chat, focused) {
  const shell = document.querySelector('.chat');
  const course = chat?.guidedLearning ? chat.course : null;
  const pending = waitingMessage(chat);
  let round = guidedWaiting.rounds.get(chat?.id);
  if (pending && !guidedWaiting.started.has(pending.id)) {
    guidedWaiting.started.set(pending.id, performance.now());
    if (guidedWaiting.started.size > 40) guidedWaiting.started.delete(guidedWaiting.started.keys().next().value);
  }
  const delay = pending ? 650 - (performance.now() - guidedWaiting.started.get(pending.id)) : 0;
  if (focused && pending && delay > 0 && !guidedWaiting.timer) guidedWaiting.timer = setTimeout(() => {
    guidedWaiting.timer = 0; scheduleGuidedStage();
  }, delay + 10);
  if (focused && course?.status === 'learning' && pending && delay <= 0 && (!round || round.closed) && round?.dismissedFor !== pending.id &&
      !['check','review','exam'].some(kind => pendingQuiz(course, kind))) {
    const offset = guidedWaiting.offsets.get(chat.id) || 0;
    const questions = GuidedLearning.waitingQuestions(course, offset);
    balanceAnswerPositions(questions);
    round = { source: pending.id, dismissedFor: pending.id, questions, index: 0, answers: {}, drafts: {}, closed: !questions.length };
    guidedWaiting.rounds.set(chat.id, round);
    if (questions.length) guidedWaiting.offsets.set(chat.id, offset + 2);
  }
  const active = !!(focused && course?.status === 'learning' && round && !round.closed);
  shell.classList.toggle('guided-waiting', active);
  if (!active) { if (guidedWaiting.host) guidedWaiting.host.hidden = true; return; }
  if (!guidedWaiting.host) {
    const host = document.createElement('section');
    host.className = 'g-wait-practice'; host.setAttribute('aria-label', 'Repaso mientras se prepara la lección');
    document.querySelector('.thread-wrap').append(host);
    guidedWaiting.host = host;
    host.addEventListener('click', waitingPracticeClick);
    host.addEventListener('submit', waitingPracticeSubmit);
    host.addEventListener('input', event => {
      if (event.target.name !== 'waiting-answer') return;
      const current = guidedWaiting.rounds.get(getActiveChat()?.id);
      if (current && !current.closed) current.drafts[current.index] = event.target.value;
      event.target.removeAttribute('aria-invalid');
      host.querySelector('.gw-number-error').textContent = '';
    });
  }
  const host = guidedWaiting.host;
  host.hidden = false;
  guidedStage.nav.hidden = true;
  const ready = !pending;
  const key = chat.id + ':' + round.source + ':' + round.index + ':' + Object.keys(round.answers).length;
  if (host.dataset.roundKey !== key) {
    host.dataset.roundKey = key;
    renderWaitingPractice(chat, round);
  }
  // Update only the status/button when the answer arrives: keep inputs/focus.
  const status = host.querySelector('.gw-status');
  const text = ready ? 'La siguiente respuesta está lista' : 'Preparando la siguiente respuesta…';
  if (status.textContent !== text) status.textContent = text;
  const exit = host.querySelector('[data-wait-exit]');
  const label = ready ? 'Ver nueva respuesta →' : 'Ver preparación';
  if (exit.textContent !== label) exit.textContent = label;
  host.classList.toggle('gw-ready', ready);
}
function renderWaitingPractice(chat, round) {
  const host = guidedWaiting.host, question = round.questions[round.index];
  const answered = round.answers[round.index] !== undefined;
  const count = Object.keys(round.answers).length;
  const rightCount = round.questions.filter((q, i) => GuidedLearning.correct(q, round.answers[i])).length;
  const progress = '<div class="gw-progress" role="progressbar" aria-label="Repaso completado" aria-valuemin="0" aria-valuemax="' + round.questions.length + '" aria-valuenow="' + count + '">' + round.questions.map((q, i) => '<span class="' + (round.answers[i] === undefined ? '' : GuidedLearning.correct(q, round.answers[i]) ? 'right' : 'done') + '"></span>').join('') + '</div>';
  let body;
  if (!question) body = '<div class="gw-finish"><span class="gw-feedback-mark">' + G_ICON.check + '</span><h2>Repaso completado</h2><p>' + rightCount + ' de ' + round.questions.length + ' respuestas correctas.</p><p>Ya has repasado lo anterior. Continúa con la lección cuando esté lista.</p></div>';
  else {
    const lesson = findLesson(chat.course, question.lessonId);
    const rank = { recall: 'Recuerda', apply: 'Aplica', transfer: 'Conecta ideas' }[question.skill];
    const right = GuidedLearning.correct(question, round.answers[round.index]);
    let controls;
    if (question.type === 'numeric') controls = '<form data-wait-number><label for="waiting-answer">Tu resultado' + (question.unit ? ' en ' + escapeHtml(question.unit) : '') + '</label><div class="gw-number"><input id="waiting-answer" name="waiting-answer" inputmode="decimal" autocomplete="off" maxlength="80" value="' + escapeHtml(String(round.drafts[round.index] || '')) + '"' + (answered ? ' disabled' : '') + '><button type="submit" class="g-primary"' + (answered ? ' disabled' : '') + '>Comprobar</button></div><p class="gw-number-error" role="alert"></p></form>';
    else controls = '<div class="g-options">' + question.options.map((option, index) => '<button type="button" class="g-opt' + (answered && index === question.correct ? ' correct' : answered && index === round.answers[round.index] ? ' wrong' : '') + '" data-wait-answer="' + index + '"' + (answered ? ' disabled' : '') + '><span class="g-opt-key">' + LETTERS[index] + '</span><span class="g-opt-text">' + gOption(question, index) + '</span></button>').join('') + '</div>';
    const feedback = answered ? '<div class="gw-feedback ' + (right ? 'right' : 'wrong') + '" role="status"><span class="gw-feedback-mark">' + (right ? G_ICON.check : G_ICON.bulb) + '</span><div><strong>' + (right ? '¡Bien recordado!' : 'Vamos a reforzarlo') + '</strong>' + (!right ? '<p>Respuesta: ' + (question.type === 'numeric' ? escapeHtml(String(question.answer) + ' ' + (question.unit || '')) : gOption(question, question.correct)) + '</p>' : '') + gMath(question.explanation || '') + '</div></div><button type="button" class="g-primary gw-next" data-wait-next>' + (round.index === round.questions.length - 1 ? 'Completar repaso' : 'Siguiente ejercicio →') + '</button>' : '';
    body = '<div class="gw-question" data-motion-key="waiting-question"><span class="gw-level">' + rank + ' · ' + (round.index + 1) + '/' + round.questions.length + '</span>' + (lesson ? '<p class="gw-concept">' + gTitle(lesson.title) + '</p>' : '') + '<div class="gw-prompt">' + gMath(question.question) + '</div>' + controls + feedback + '</div>';
  }
  interactiveUpdate(host, () => {
    host.innerHTML = '<header class="gw-header"><span>Mientras tanto · Repaso rápido</span><p class="gw-status" role="status"></p></header>' + progress + body + '<footer><button type="button" data-wait-exit class="gw-exit"></button><span>Puedes volver a la lección cuando quieras</span></footer>';
    enhanceRichContent(host, {renderMath:true,latexPreview:false});
    return host;
  });
}
function waitingPracticeAnswer(value) {
  const chat = getActiveChat(), round = guidedWaiting.rounds.get(chat?.id);
  if (!round || round.closed || round.answers[round.index] !== undefined) return;
  const q = round.questions[round.index];
  if (!q || (q.type === 'numeric' ? !Number.isFinite(value) : !Number.isInteger(value) || value < 0 || value >= q.options.length)) return;
  round.answers[round.index] = value;
  let streak = 0;
  for (let i = round.index; i >= 0 && GuidedLearning.correct(round.questions[i], round.answers[i]); i--) streak++;
  syncGuidedStage();
  exerciseFeedback(GuidedLearning.correct(q, value), streak, false, guidedWaiting.host);
}
function waitingPracticeClick(event) {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const chat = getActiveChat(), round = guidedWaiting.rounds.get(chat?.id);
  if (!round || round.closed) return;
  if (button.hasAttribute('data-wait-answer')) waitingPracticeAnswer(Number(button.dataset.waitAnswer));
  if (button.hasAttribute('data-wait-next') && round.answers[round.index] !== undefined) {
    round.index++; syncGuidedStage();
    if (round.index === round.questions.length) exerciseFeedback(true, 0, true, guidedWaiting.host);
    else haptic('select');
    guidedWaiting.host.querySelector('input, [data-wait-answer], [data-wait-exit]')?.focus({preventScroll:true});
  }
  if (button.hasAttribute('data-wait-exit')) {
    round.closed = true; round.dismissedFor = waitingMessage(chat)?.id || round.source;
    guidedStage.current = guidedStage.latest; syncGuidedStage();
    document.querySelector('.thread-wrap').scrollTop = 0;
    guidedStage.nav.querySelector('[data-screen="next"]')?.focus({preventScroll:true});
  }
}
function waitingPracticeSubmit(event) {
  if (!event.target.matches('[data-wait-number]')) return;
  event.preventDefault();
  const input = event.target.elements['waiting-answer'];
  const value = GuidedLearning.number(input.value);
  if (value === null) {
    input.setAttribute('aria-invalid','true');
    event.target.querySelector('.gw-number-error').textContent = 'Escribe un número, por ejemplo 1,25.';
    return;
  }
  waitingPracticeAnswer(value);
}
