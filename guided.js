/* ─── Aprendizaje guiado ─────────────────────────────────────────────
   The app drives the course; the model only teaches and calls three tools
   (engine/src/guided.js): set_course_plan, quiz and final_exam.

   chat.course holds the plan, the current lesson, every quiz and its
   answers, and the last event (quiz graded, lesson skipped…). Each request
   sends the model that state plus one concrete task ("teach L3", "call
   final_exam now"), so it cannot forget the plan or the exam; if it skips a
   required step, guidedAfterTurn() asks again with a hidden message.

   Loaded before the main script of index.html; uses its globals at call
   time (escapeHtml, renderMarkdown, getActiveChat, runAssistantTurn…). */

const GUIDED_PASS = 70;
const GUIDED_TOOL_NAMES = new Set(['set_course_plan', 'quiz', 'final_exam']);
const GUIDED_RESULT_KINDS = new Set(['quiz-result', 'exam-result']);
const GUIDED_LEVELS = [
  { id: 'cero', label: 'Desde cero', note: 'Empiezo de nada', prompt: 'starts from zero' },
  { id: 'base', label: 'Tengo base', note: 'Repaso y avanzo', prompt: 'has the basics' },
  { id: 'avanzado', label: 'Avanzado', note: 'Voy al grano', prompt: 'is advanced and wants depth' }
];
const GUIDED_NEEDS_TOOLS = 'El aprendizaje guiado necesita un modelo que use herramientas: elige uno con el filtro «Herramientas» del selector de modelos.';
const GUIDED_LENGTHS = [
  { id: 'expres', label: 'Exprés', note: '3–4 lecciones', prompt: '3 to 4 lessons in 1–2 units' },
  { id: 'normal', label: 'Normal', note: '5–8 lecciones', prompt: '5 to 8 lessons in 2–3 units' },
  { id: 'fondo', label: 'A fondo', note: '9–14 lecciones', prompt: '9 to 14 lessons in 3–5 units' }
];

const GUIDED_BASE_PROMPT = [
  'You are the tutor of inhouse learn\'s Guided Learning mode. Reply in the student\'s language (Spanish unless they write in another), informal "tú", warm and direct.',
  '',
  'How this mode works',
  '- The app shows the course plan, the progress, the quizzes and the final exam as interactive cards. You drive them ONLY with these tools:',
  '  • set_course_plan: create or replace the plan (units → lessons, each lesson with 2–4 concrete, checkable objectives).',
  '  • quiz: 3–4 multiple-choice questions that check the CURRENT lesson. The app grades them and sends you the result.',
  '  • final_exam: the final exam over the whole course, about 2 questions per lesson, each tagged with its lesson id. Only when the app says every lesson is done.',
  '- Never write in your text progress bars, the list of lessons, scores, or multiple-choice questions with options: the cards already show them. Never ask the student to type quiz answers.',
  '- After calling quiz or final_exam, stop: at most one short sentence. The results arrive in the student\'s next message.',
  '- "Your task now" (below) comes from the app and changes after every step. Follow it exactly, even if earlier messages suggested something else.',
  '- Messages that start with "(Aviso de la app)" come from the app, not the student: do what they say without mentioning them.',
  '- Every lesson teaches with at least one interactive visual (see "Interactive visuals"): the first message of each lesson always includes one, and so does every re-explanation. Check the lesson only with the quiz tool, never with a visual of type check.',
  '',
  'How to teach (the student\'s preferences)',
  '- Assume they know nothing of the topic yet. Build from intuition and origin: where each formula comes from, what it really measures, why it has that shape; derive it instead of dropping it. If something is pure convention, say so ("esto es convención, memorízalo").',
  '- The student has ADHD: short chunks, bullets, bold anchors, no walls of text — but keep the depth; spread it across messages.',
  '- One idea per message. End each teaching message with one short check question or an invitation to continue.',
  '- Metaphors and small worked examples, not full exercises. Go progressively deeper, towards exam level.',
  '- Math in LaTeX: inline \\( … \\), display $$ … $$. Never put math in code blocks.'
].join('\n');

/* ─── State ──────────────────────────────────────────────────────────── */

function createEmptyCourse() {
  return { v: 2, status: 'setup', title: '', goal: '', level: 'cero', length: 'normal', units: [], currentLessonId: '',
    quizzes: {}, lastEvent: null, setupTurns: 0, createdAt: nowIso(), updatedAt: nowIso() };
}

function normalizeCourse(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 2) return null;
  const course = Object.assign(createEmptyCourse(), raw);
  course.units = Array.isArray(raw.units) ? raw.units.filter((unit) => unit && Array.isArray(unit.lessons)) : [];
  course.quizzes = raw.quizzes && typeof raw.quizzes === 'object' ? raw.quizzes : {};
  if (!['setup', 'ready', 'learning', 'exam', 'done'].includes(course.status)) course.status = 'setup';
  return course;
}

function courseOf(chat) {
  if (!chat) return null;
  if (!chat.course || chat.course.v !== 2) chat.course = createEmptyCourse();
  return chat.course;
}

function courseLessons(course) {
  const out = [];
  (course && course.units || []).forEach((unit, unitIndex) => {
    (unit.lessons || []).forEach((lesson) => out.push(Object.assign(lesson, { unitIndex })));
  });
  return out;
}

function findLesson(course, id) {
  return courseLessons(course).find((lesson) => lesson.id === id) || null;
}

function currentLesson(course) {
  return course && course.currentLessonId ? findLesson(course, course.currentLessonId) : null;
}

function lessonIsFinished(lesson) {
  return lesson.status === 'done' || lesson.status === 'skipped';
}

function courseProgress(course) {
  const lessons = courseLessons(course);
  const finished = lessons.filter(lessonIsFinished).length;
  const total = lessons.length + 1; // the final exam counts as one more step
  const examDone = course.status === 'done' ? 1 : 0;
  return { lessons, finished, total, percent: lessons.length ? Math.round(((finished + examDone) / total) * 100) : 0 };
}

function pendingQuiz(course, kind) {
  return Object.values(course.quizzes || {}).filter((quiz) => quiz.kind === kind && !quiz.submitted && !quiz.superseded)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

function touchCourse(course) {
  course.updatedAt = nowIso();
}

function guidedComposerPlaceholder(chat) {
  const course = chat && chat.course;
  const status = course ? course.status : 'setup';
  if (status === 'ready') return 'Pulsa Empezar o dime qué cambiar del plan';
  if (status === 'learning') return 'Pregunta o responde a tu tutor';
  if (status === 'exam') return pendingQuiz(course, 'exam') ? 'Termina el examen de arriba' : 'Preparando el examen final…';
  if (status === 'done') return 'Pregunta lo que quieras sobre el curso';
  return '¿Qué quieres aprender? Un tema, un examen o tus apuntes';
}

/* ─── Prompt ─────────────────────────────────────────────────────────── */

function lessonLine(lesson) {
  const mark = lesson.status === 'done' ? 'done' + (lesson.score != null ? ' (' + lesson.score + '%)' : '')
    : lesson.status === 'skipped' ? 'skipped by the student'
    : lesson.status === 'current' ? 'CURRENT' : 'pending';
  return '  ' + lesson.id + ' — ' + lesson.title + ' [' + mark + ']';
}

function courseStateText(course) {
  if (!course.units.length) {
    const level = GUIDED_LEVELS.find((item) => item.id === course.level) || GUIDED_LEVELS[0];
    const length = GUIDED_LENGTHS.find((item) => item.id === course.length) || GUIDED_LENGTHS[1];
    return 'No plan yet. The student ' + level.prompt + ' and wants a course of ' + length.prompt + '.';
  }
  const lines = ['Course: ' + course.title + (course.goal ? ' — ' + course.goal : ''), 'Status: ' + course.status];
  course.units.forEach((unit, index) => {
    lines.push('Unit ' + (index + 1) + ': ' + unit.title);
    unit.lessons.forEach((lesson) => lines.push(lessonLine(lesson)));
  });
  const lesson = currentLesson(course);
  if (lesson) {
    lines.push('Current lesson ' + lesson.id + ' «' + lesson.title + '». Objectives:');
    (lesson.objectives || []).forEach((objective) => lines.push('  - ' + objective));
    lines.push('Messages already spent teaching it: ' + (lesson.turns || 0) + '. Quiz attempts: ' + (lesson.attempts || 0) + '.');
  }
  return lines.join('\n');
}

function wrongAnswersText(quiz) {
  return (quiz.questions || []).map((question, index) => {
    const chosen = quiz.answers && quiz.answers[index];
    if (chosen === question.correct) return '';
    return '- «' + question.question + '»: chose «' + (question.options[chosen] || '—') + '», correct «' + question.options[question.correct] + '»';
  }).filter(Boolean).join('\n');
}

function courseTaskText(course, chat) {
  const event = course.lastEvent;
  if (course.status === 'setup') {
    if ((course.setupTurns || 0) >= 1) {
      return 'If the student has said what to learn, call set_course_plan NOW with a complete plan (base it on their notes or files if they attached any). Only if the topic is still unknown, ask for it in one short sentence. Do not teach yet.';
    }
    return 'If the student\'s message says what they want to learn, call set_course_plan now with a complete plan for it (base it on their notes or files if they attached any) and, in your text, present it in one or two sentences. If the topic is not clear yet, ask for it in one short sentence. Do not teach any lesson yet.';
  }
  if (course.status === 'ready') {
    return 'The plan is on screen with a "Start" button. If the student asks for changes, call set_course_plan again with the adjusted plan. Otherwise answer in one or two sentences and invite them to press Start. Do not teach yet.';
  }
  if (course.status === 'exam') {
    const exam = pendingQuiz(course, 'exam');
    if (exam) return 'The final exam is on screen and not submitted yet. Encourage the student in one sentence; never reveal answers. Do not call tools.';
    const ids = courseLessons(course).map((lesson) => lesson.id).join(', ');
    return (event && event.type === 'quiz' ? 'The last lesson was just passed with ' + event.score + '%. Congratulate in one line. ' : '') +
      'Every lesson is finished: call final_exam NOW with about 2 questions per lesson (' + ids + '), each tagged with its lesson id, mixing concepts the way a real exam would. In your text, one short sentence.';
  }
  if (course.status === 'done') {
    if (event && event.type === 'exam') {
      const weak = (event.byLesson || []).filter((item) => item.percent < GUIDED_PASS).map((item) => item.id + ' (' + item.percent + '%)').join(', ');
      return 'The final exam is graded: ' + event.score + '%' + (weak ? '. Weak lessons: ' + weak : ', no weak lessons') + '. Wrong answers:\n' + (event.wrong || 'none') +
        '\nGive the final review: what they now master, a 2–3 line recap of each weak point, and next steps. Do not call tools.';
    }
    return 'The course is finished. Answer the student\'s questions about it. If they want to retake the final exam, the app will tell you. Do not call tools unless asked to change the plan.';
  }
  // learning
  const lesson = currentLesson(course);
  if (!lesson) return 'Teach the next pending lesson.';
  const quiz = pendingQuiz(course, 'check');
  if (quiz) return 'A quiz for ' + lesson.id + ' is on screen and not answered yet. Answer the student briefly and remind them to finish it. Do not call tools.';
  const lastUser = [...(chat.messages || [])].reverse().find((message) => message.role === 'user' && !message.hidden);
  if (lastUser && lastUser.kind === 'visual') {
    return 'The student asked to SEE it: answer with one ```visual block (or a ```mermaid diagram) that shows the idea you are teaching in ' + lesson.id + ', choosing the type that fits best, plus at most three short lines of text around it.';
  }
  if (lastUser && lastUser.kind === 'test-me') {
    return 'The student asked to be tested: call quiz NOW with 3–4 questions about ' + lesson.id + ' «' + lesson.title + '». One short sentence of text.';
  }
  if (event && event.type === 'quiz' && event.lessonId === lesson.id && !event.passed) {
    return 'The student scored ' + event.score + '% on the quiz of ' + lesson.id + ' (pass: ' + GUIDED_PASS + '%). They missed:\n' + event.wrong +
      '\nRe-explain exactly those points from a different angle (a new metaphor or a simpler case) with one ```visual block that makes them visible, in one or two short messages, then call quiz again with NEW questions.';
  }
  const opening = event && event.type === 'quiz' && event.passed
    ? 'Lesson ' + event.lessonId + ' was passed with ' + event.score + '%. Celebrate in one line, then start teaching ' + lesson.id + ' «' + lesson.title + '». '
    : event && event.type === 'skip'
      ? 'The student skipped ' + event.lessonId + ' because they already know it. Start teaching ' + lesson.id + ' «' + lesson.title + '». '
      : event && event.type === 'start'
        ? 'The course starts now. Begin teaching ' + lesson.id + ' «' + lesson.title + '» with its first idea. '
        : '';
  const turns = lesson.turns || 0;
  if (turns === 0) {
    return opening + 'Teach the first idea of ' + lesson.id + ' «' + lesson.title + '» and include one ```visual block (or a ```mermaid diagram) that lets the student see or play with it: a plot or formula with sliders for maths and physics, steps for a procedure, a timeline for history, compare for contrasts, flashcards for terms. One idea, short text around the visual, end with a short question.';
  }
  if (turns >= 3) {
    return opening + 'You have spent ' + turns + ' messages on ' + lesson.id + ': wrap it up in two sentences and call quiz NOW with 3–4 questions about its objectives.';
  }
  return opening + 'Teach ' + lesson.id + ' «' + lesson.title + '»: cover its objectives over one to three short messages, one idea per message. When the objectives are covered (or the student asks to be tested), call quiz with 3–4 questions about this lesson.';
}

// Goes last in the system prompt, after the visuals and the tools.
function guidedTaskPrompt(chat) {
  const course = courseOf(chat);
  return ['## Course state (from the app; the source of truth)', courseStateText(course), '', '## Your task now', courseTaskText(course, chat)].join('\n');
}

/* ─── Tool handlers ──────────────────────────────────────────────────── */

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 300);
}

function validateQuestions(raw, options) {
  const questions = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < questions.length; i++) {
    const item = questions[i] || {};
    const opts = (Array.isArray(item.options) ? item.options : []).map((option) => String(option == null ? '' : option).trim())
      .map((option) => option.replace(/^\s*(?:[A-Ea-e]|\d)[).:]\s+/, ''));
    const correct = Number(item.correct);
    if (!String(item.question || '').trim()) return { error: 'Question ' + (i + 1) + ' has no text.' };
    if (opts.length < 2 || opts.length > 5 || opts.some((option) => !option)) return { error: 'Question ' + (i + 1) + ' needs 2–5 non-empty options.' };
    if (!Number.isInteger(correct) || correct < 0 || correct >= opts.length) return { error: 'Question ' + (i + 1) + ': "correct" must be the index (0–' + (opts.length - 1) + ') of the right option.' };
    const question = { question: String(item.question).trim(), options: opts, correct, explanation: String(item.explanation || '').trim() };
    if (options && options.lessons) {
      const lessonId = String(item.lesson || '').trim().toUpperCase();
      question.lessonId = options.lessons.some((lesson) => lesson.id === lessonId) ? lessonId : '';
    }
    out.push(question);
  }
  if (options && out.length < options.min) return { error: 'Give at least ' + options.min + ' questions.' };
  return { questions: out };
}

// Models tend to put the right answer first, or to make it the longest and
// most detailed option. The app decides the positions itself: each quiz draws
// them from a shuffled bag, so they are spread evenly over A, B, C, D, and the
// wrong options are shuffled too. Questions with "all / none of the above"
// keep their order.
const PINNED_OPTION = /^(todas|ninguna|ambas)\b.*\b(anteriores|correctas|incorrectas)\b|\b(all|none|both) of the above\b/i;

function shuffledCopy(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function balanceAnswerPositions(questions) {
  const bags = {};
  questions.forEach((question) => {
    if (question.options.some((option) => PINNED_OPTION.test(option))) return;
    const n = question.options.length;
    if (!bags[n] || !bags[n].length) bags[n] = shuffledCopy(Array.from({ length: n }, (_, k) => k));
    const target = bags[n].pop();
    const right = question.options[question.correct];
    const others = shuffledCopy(question.options.filter((_, k) => k !== question.correct));
    others.splice(target, 0, right);
    question.options = others;
    question.correct = target;
  });
  return questions;
}

// Questions whose right answer gives itself away by being clearly longer.
function longestAnswerGiveaways(questions) {
  return questions.filter((question) => {
    const lengths = question.options.map((option) => option.replace(/\\[a-z]+|[{}$\\]/gi, '').trim().length);
    const right = lengths[question.correct];
    const other = Math.max(...lengths.filter((_, k) => k !== question.correct));
    return right >= other * 1.3 && right - other >= 10;
  });
}

function questionsTooEasyToGuess(questions, state) {
  const giveaways = longestAnswerGiveaways(questions);
  // Sent back at most twice per answer, so a stubborn model cannot loop forever.
  if (giveaways.length <= Math.max(1, Math.floor(questions.length / 4)) || state.rejected >= 2) return '';
  state.rejected += 1;
  return 'In ' + giveaways.length + ' of ' + questions.length + ' questions the correct option is clearly the longest, so it can be guessed without knowing the answer (' +
    giveaways.slice(0, 3).map((question) => '«' + question.question.slice(0, 60) + '»').join(', ') + '). Call the tool again with wrong options as long, specific and plausible as the correct one (and the correct one no more detailed than the rest).';
}

function createGuidedToolHandlers(chat, message) {
  const lengthCheck = { rejected: 0 };
  const addCard = (card) => {
    message.guidedCards = (message.guidedCards || []).filter((item) => !(card.type === 'plan' && item.type === 'plan'));
    message.guidedCards.push(card);
  };
  return {
    setPlan(params) {
      const course = courseOf(chat);
      const units = (Array.isArray(params && params.units) ? params.units : []).map((unit) => ({
        title: cleanText(unit && unit.title, 120) || 'Unidad',
        icon: Array.from(cleanText(unit && unit.icon, 16)).slice(0, 2).join(''),
        lessons: (Array.isArray(unit && unit.lessons) ? unit.lessons : []).map((lesson) => ({
          title: cleanText(lesson && lesson.title, 140),
          objectives: (Array.isArray(lesson && lesson.objectives) ? lesson.objectives : []).map((item) => cleanText(item, 220)).filter(Boolean).slice(0, 5),
          minutes: Math.max(0, Math.min(90, Math.round(Number(lesson && lesson.minutes) || 0)))
        })).filter((lesson) => lesson.title)
      })).filter((unit) => unit.lessons.length);
      const total = units.reduce((sum, unit) => sum + unit.lessons.length, 0);
      if (!cleanText(params && params.title) || !total) return { isError: true, text: 'The plan needs a title and at least one unit with lessons.' };
      if (total > 20) return { isError: true, text: 'Too many lessons (' + total + '). Keep it to 20 or fewer.' };
      // Keep the progress of lessons that survive a re-plan (same title).
      const before = new Map(courseLessons(course).map((lesson) => [lesson.title.toLowerCase(), lesson]));
      let n = 0;
      units.forEach((unit) => unit.lessons.forEach((lesson) => {
        n += 1;
        const old = before.get(lesson.title.toLowerCase());
        Object.assign(lesson, { id: 'L' + n, status: 'pending', score: null, attempts: 0, turns: 0 },
          old && lessonIsFinished(old) ? { status: old.status, score: old.score, attempts: old.attempts } : {});
      }));
      course.title = cleanText(params.title, 90);
      course.goal = cleanText(params.goal, 240);
      course.units = units;
      const started = course.status === 'learning' || course.status === 'exam' || course.status === 'done';
      if (started) {
        const next = courseLessons(course).find((lesson) => !lessonIsFinished(lesson));
        course.currentLessonId = next ? next.id : '';
        if (next) next.status = 'current';
        course.status = next ? 'learning' : 'exam';
      } else {
        course.status = 'ready';
        course.currentLessonId = '';
      }
      touchCourse(course);
      if (!chat.customTitle) chat.title = course.title;
      addCard({ type: 'plan' });
      const ids = courseLessons(course).map((lesson) => lesson.id + ' «' + lesson.title + '»').join(', ');
      return { text: (started ? 'Plan updated; progress kept for finished lessons. ' : 'Plan saved and shown to the student with a "Start" button. ') +
        'Lessons: ' + ids + '. In your text, add at most two short sentences' + (started ? ' and continue with the current lesson.' : ' inviting them to start or to ask for changes. Do not teach yet.') };
    },
    quiz(params) {
      const course = courseOf(chat);
      const lesson = currentLesson(course);
      if (course.status !== 'learning' || !lesson) {
        return { isError: true, text: course.status === 'exam'
          ? 'Every lesson is finished: call final_exam instead.'
          : 'There is no lesson in progress. ' + (course.units.length ? 'The student has to press Start first.' : 'Create the plan first with set_course_plan.') };
      }
      const checked = validateQuestions(params && params.questions, { min: 2 });
      if (checked.error) return { isError: true, text: checked.error };
      const giveaway = questionsTooEasyToGuess(checked.questions, lengthCheck);
      if (giveaway) return { isError: true, text: giveaway };
      balanceAnswerPositions(checked.questions);
      Object.values(course.quizzes).forEach((quiz) => { if (quiz.kind === 'check' && !quiz.submitted) quiz.superseded = true; });
      const id = uid('quiz');
      course.quizzes[id] = { id, kind: 'check', lessonId: lesson.id, questions: checked.questions.slice(0, 6), answers: {}, submitted: false, score: null, createdAt: nowIso() };
      touchCourse(course);
      addCard({ type: 'quiz', quizId: id });
      return { text: 'Quiz shown below your message (' + checked.questions.length + ' questions on ' + lesson.id + '). Stop now: at most one short sentence. The result will arrive in the student\'s next message.' };
    },
    exam(params) {
      const course = courseOf(chat);
      if (course.status !== 'exam') {
        const pending = courseLessons(course).filter((lesson) => !lessonIsFinished(lesson)).map((lesson) => lesson.id).join(', ');
        return { isError: true, text: 'The final exam comes after every lesson is finished. Still pending: ' + (pending || 'the plan') + '. Follow "Your task now".' };
      }
      const lessons = courseLessons(course);
      const checked = validateQuestions(params && params.questions, { min: Math.min(6, lessons.length * 2), lessons });
      if (checked.error) return { isError: true, text: checked.error };
      const giveaway = questionsTooEasyToGuess(checked.questions, lengthCheck);
      if (giveaway) return { isError: true, text: giveaway };
      balanceAnswerPositions(checked.questions);
      const covered = new Set(checked.questions.map((question) => question.lessonId).filter(Boolean));
      const missing = lessons.filter((lesson) => lesson.status === 'done' && !covered.has(lesson.id));
      if (missing.length && missing.length > Math.floor(lessons.length / 4)) {
        return { isError: true, text: 'The exam must check every lesson. Missing questions (or lesson tags) for: ' + missing.map((lesson) => lesson.id).join(', ') + '. Call final_exam again with all of them.' };
      }
      Object.values(course.quizzes).forEach((quiz) => { if (quiz.kind === 'exam' && !quiz.submitted) quiz.superseded = true; });
      const id = uid('exam');
      course.quizzes[id] = { id, kind: 'exam', lessonId: '', questions: checked.questions.slice(0, 30), answers: {}, submitted: false, score: null, createdAt: nowIso() };
      touchCourse(course);
      addCard({ type: 'exam', quizId: id });
      return { text: 'Final exam shown (' + checked.questions.length + ' questions). Stop now: one short encouraging sentence. The result will arrive in the student\'s next message.' };
    }
  };
}

/* ─── After each turn ────────────────────────────────────────────────── */

// Called when an assistant turn of a guided chat ends. Returns a hidden user
// message to send right away when the model skipped a step the course needs.
function guidedAfterTurn(chat, message, options) {
  const course = courseOf(chat);
  const cards = (message && message.guidedCards) || [];
  const failed = /^Error: /.test(String(message && message.content || ''));
  if (failed) return null;
  const consumed = course.lastEvent;
  course.lastEvent = null;
  if (course.status === 'setup' && !cards.length) course.setupTurns = (course.setupTurns || 0) + 1;
  const lesson = currentLesson(course);
  if (course.status === 'learning' && lesson && !cards.some((card) => card.type === 'quiz')) {
    lesson.turns = (lesson.turns || 0) + 1;
  }
  touchCourse(course);
  if (options && options.nudged) return null;
  let nudge = '';
  if (course.status === 'exam' && !pendingQuiz(course, 'exam')) {
    nudge = 'Every lesson is finished. Call final_exam now, as "Your task now" says.';
  } else if (course.status === 'learning' && lesson && !pendingQuiz(course, 'check') &&
      ((lesson.turns || 0) >= 4 || (consumed && consumed.type === 'test-me'))) {
    nudge = 'Call quiz now for ' + lesson.id + ' «' + lesson.title + '», as "Your task now" says.';
  } else if (course.status === 'setup' && (course.setupTurns || 0) >= 2) {
    nudge = 'Call set_course_plan now with the plan for what the student wants to learn.';
  }
  if (!nudge) return null;
  const hidden = createMessage('user', '(Aviso de la app) ' + nudge, false);
  hidden.hidden = true;
  hidden.kind = 'nudge';
  return hidden;
}

// Free text from the student while the plan waits for "Empezar": a clear
// "go" starts the course before the model answers.
function guidedBeforeUserTurn(chat, text) {
  const course = chat && chat.guidedLearning ? courseOf(chat) : null;
  if (!course) return;
  if (course.status === 'ready' && /^\s*(empez|empiez|comenz|comienz|vamos|adelante|dale|venga|ok\b|okay|s[ií]\b|start|go\b|listo)/i.test(text || '')) {
    startCourse(course);
  }
  if (/ponme a prueba|hazme (el|un) test|test me|quiz me/i.test(text || '') && course.status === 'learning') {
    course.lastEvent = { type: 'test-me' };
  }
}

function startCourse(course) {
  const first = courseLessons(course).find((lesson) => !lessonIsFinished(lesson));
  if (!first) { course.status = 'exam'; return; }
  courseLessons(course).forEach((lesson) => { if (lesson.status === 'current') lesson.status = 'pending'; });
  first.status = 'current';
  course.currentLessonId = first.id;
  course.status = 'learning';
  course.lastEvent = { type: 'start' };
  touchCourse(course);
}

function advanceCourse(course) {
  const next = courseLessons(course).find((lesson) => !lessonIsFinished(lesson));
  if (next) {
    next.status = 'current';
    course.currentLessonId = next.id;
    course.status = 'learning';
  } else {
    course.currentLessonId = '';
    course.status = 'exam';
  }
}

/* ─── Student actions ────────────────────────────────────────────────── */

function guidedSend(chat, text, extra) {
  if (appState.busy) return;
  const message = createMessage('user', text, false);
  Object.assign(message, extra || {});
  runAssistantTurn(chat, message);
}

function gradeQuiz(quiz) {
  let right = 0;
  quiz.questions.forEach((question, index) => { if (quiz.answers[index] === question.correct) right += 1; });
  return { right, total: quiz.questions.length, percent: Math.round((right / Math.max(1, quiz.questions.length)) * 100) };
}

function submitCheckQuiz(chat, quizId) {
  const course = courseOf(chat);
  const quiz = course.quizzes[quizId];
  if (!quiz || quiz.submitted || appState.busy) return;
  if (Object.keys(quiz.answers).length < quiz.questions.length) return;
  const grade = gradeQuiz(quiz);
  quiz.submitted = true;
  quiz.score = grade.percent;
  const lesson = findLesson(course, quiz.lessonId);
  const passed = grade.percent >= GUIDED_PASS;
  if (lesson) {
    lesson.attempts = (lesson.attempts || 0) + 1;
    if (passed) {
      lesson.status = 'done';
      lesson.score = grade.percent;
      advanceCourse(course);
    } else {
      lesson.turns = 0;
    }
  }
  course.lastEvent = { type: 'quiz', lessonId: quiz.lessonId, score: grade.percent, passed, wrong: wrongAnswersText(quiz) };
  touchCourse(course);
  const label = lesson ? 'Lección ' + lesson.id.slice(1) + ' · ' + lesson.title : 'Mini test';
  guidedSend(chat, 'Resultado del mini test (' + label + '): ' + grade.right + '/' + grade.total + ' (' + grade.percent + '%).' +
    (passed ? ' Aprobado.' : ' Me ha costado:\n' + wrongAnswersText(quiz)), {
    kind: 'quiz-result', result: { quizId, right: grade.right, total: grade.total, percent: grade.percent, passed, label }
  });
}

function submitExam(chat, quizId) {
  const course = courseOf(chat);
  const quiz = course.quizzes[quizId];
  if (!quiz || quiz.submitted || appState.busy) return;
  if (Object.keys(quiz.answers).length < quiz.questions.length) return;
  const grade = gradeQuiz(quiz);
  quiz.submitted = true;
  quiz.score = grade.percent;
  const byLesson = courseLessons(course).map((lesson) => {
    const items = quiz.questions.map((question, index) => ({ question, index })).filter((item) => item.question.lessonId === lesson.id);
    if (!items.length) return null;
    const right = items.filter((item) => quiz.answers[item.index] === item.question.correct).length;
    return { id: lesson.id, title: lesson.title, right, total: items.length, percent: Math.round((right / items.length) * 100) };
  }).filter(Boolean);
  quiz.byLesson = byLesson;
  course.status = 'done';
  course.examScore = grade.percent;
  course.lastEvent = { type: 'exam', score: grade.percent, byLesson, wrong: wrongAnswersText(quiz) };
  touchCourse(course);
  guidedSend(chat, 'Resultado del examen final: ' + grade.right + '/' + grade.total + ' (' + grade.percent + '%).', {
    kind: 'exam-result', result: { quizId, right: grade.right, total: grade.total, percent: grade.percent, passed: grade.percent >= GUIDED_PASS, label: 'Examen final' }
  });
}

function guidedAnswer(chat, quizId, questionIndex, optionIndex) {
  const course = courseOf(chat);
  const quiz = course.quizzes[quizId];
  if (!quiz || quiz.submitted || quiz.superseded) return;
  // Mini tests lock each answer (instant feedback); the exam lets you change it until you hand it in.
  if (quiz.kind === 'check' && quiz.answers[questionIndex] !== undefined) return;
  quiz.answers[questionIndex] = optionIndex;
  if (quiz.kind === 'check') haptic(optionIndex === quiz.questions[questionIndex].correct ? 'success' : 'error');
  else haptic('select');
  touchCourse(course);
  chat.updatedAt = nowIso();
  saveState();
  rerenderGuidedCard(chat, quizId);
}

function rerenderGuidedCard(chat, quizId) {
  const card = document.querySelector('[data-g-quiz="' + quizId + '"]');
  const course = courseOf(chat);
  const quiz = course.quizzes[quizId];
  if (!card || !quiz) return;
  const template = document.createElement('template');
  template.innerHTML = (quiz.kind === 'exam' ? renderExamCard(course, quiz) : renderQuizCard(course, quiz)).trim();
  const next = template.content.firstElementChild;
  interactiveUpdate(card, () => {
    card.replaceWith(next);
    enhanceRichContent(next, { renderMath: true, latexPreview: false });
    return next;
  });
}

const GUIDED_QUICK = {
  next: { text: 'Sigue.', kind: '' },
  example: { text: 'Dame otro ejemplo.', kind: '' },
  confused: { text: 'No lo entiendo, explícamelo de otra forma.', kind: '' },
  visual: { text: 'Muéstramelo con una vista interactiva.', kind: 'visual' },
  test: { text: 'Ponme a prueba.', kind: 'test-me' },
  review: { text: 'Repásame lo que fallé en el examen.', kind: '' },
  retake: { text: 'Quiero repetir el examen final.', kind: 'retake' }
};

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-g-answer],[data-g-submit],[data-g-start],[data-g-quick],[data-g-tweak],[data-g-toggle-map],[data-g-skip],[data-g-level],[data-g-length],[data-g-change-plan],[data-g-page]');
  if (!target) return;
  const chat = getActiveChat();
  if (!chat) return;
  event.preventDefault();
  if (target.dataset.gAnswer) {
    const [quizId, q, o] = target.dataset.gAnswer.split(':');
    guidedAnswer(chat, quizId, Number(q), Number(o));
  } else if (target.dataset.gSubmit) {
    const quiz = courseOf(chat).quizzes[target.dataset.gSubmit];
    if (quiz && quiz.kind === 'exam') submitExam(chat, quiz.id); else submitCheckQuiz(chat, target.dataset.gSubmit);
  } else if (target.hasAttribute('data-g-start')) {
    const course = courseOf(chat);
    if (course.status !== 'ready' || appState.busy) return;
    startCourse(course);
    guidedSend(chat, '¡Empezamos!', { kind: 'start' });
  } else if (target.dataset.gTweak) {
    const tweak = GUIDED_TWEAKS[target.dataset.gTweak];
    if (tweak && courseOf(chat).status === 'ready' && !appState.busy) guidedSend(chat, tweak.text);
  } else if (target.hasAttribute('data-g-change-plan')) {
    elements.composer.value = 'Cambia el plan: ';
    autoResizeComposer();
    elements.composer.focus();
    updateSendUi();
  } else if (target.dataset.gQuick) {
    const quick = GUIDED_QUICK[target.dataset.gQuick];
    if (!quick || appState.busy) return;
    const course = courseOf(chat);
    if (quick.kind === 'test-me') course.lastEvent = { type: 'test-me' };
    if (quick.kind === 'retake') {
      course.status = 'exam';
      course.lastEvent = null;
    }
    guidedSend(chat, quick.text, quick.kind ? { kind: quick.kind } : {});
  } else if (target.dataset.gPage) {
    guidedTurnPage(target.dataset.gPage);
  } else if (target.hasAttribute('data-g-toggle-map')) {
    const open = !(sessionGet('course-map::' + chat.id) === '1');
    sessionSet('course-map::' + chat.id, open ? '1' : '0');
    syncGuidedBannerSlot(chat);
  } else if (target.dataset.gSkip) {
    const course = courseOf(chat);
    const lesson = findLesson(course, target.dataset.gSkip);
    if (!lesson || lesson.status !== 'current' || appState.busy) return;
    lesson.status = 'skipped';
    Object.values(course.quizzes).forEach((quiz) => { if (quiz.lessonId === lesson.id && !quiz.submitted) quiz.superseded = true; });
    advanceCourse(course);
    course.lastEvent = { type: 'skip', lessonId: lesson.id };
    guidedSend(chat, 'Me salto la lección «' + lesson.title + '»: ya la domino.', { kind: 'skip' });
  } else if (target.dataset.gLevel || target.dataset.gLength) {
    const course = courseOf(chat);
    if (target.dataset.gLevel) course.level = target.dataset.gLevel;
    if (target.dataset.gLength) course.length = target.dataset.gLength;
    saveState({ skipDrive: true });
    document.querySelectorAll('[data-g-level]').forEach((pill) => pill.classList.toggle('active', pill.dataset.gLevel === course.level));
    document.querySelectorAll('[data-g-length]').forEach((pill) => pill.classList.toggle('active', pill.dataset.gLength === course.length));
  }
});

// Anterior / Siguiente jump between the chapter titles of the thread, like the pages of a book.
function guidedTurnPage(direction) {
  const wrap = document.querySelector('.thread-wrap');
  if (!wrap) return;
  const top = wrap.getBoundingClientRect().top;
  const stops = Array.from(document.querySelectorAll('#thread [data-lesson-start]'))
    .map((el) => el.getBoundingClientRect().top - top + wrap.scrollTop - 12);
  const here = wrap.scrollTop + 4;
  let current = -1;
  stops.forEach((y, index) => { if (y <= here) current = index; });
  let goal;
  if (direction === 'prev') goal = current > 0 ? stops[current - 1] : 0;
  else goal = current + 1 < stops.length ? stops[current + 1] : wrap.scrollHeight;
  const smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  wrap.scrollTo({ top: Math.max(0, goal), behavior: smooth ? 'smooth' : 'auto' });
}

function sessionGet(key) { try { return sessionStorage.getItem(key); } catch (_) { return null; } }
function sessionSet(key, value) { try { sessionStorage.setItem(key, value); } catch (_) {} }

/* ─── Rendering ──────────────────────────────────────────────────────── */

const G_ICON = {
  cap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12 10 17 19 7"/></svg>',
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
  skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  bulb: '<svg viewBox="25 23.5 58 58" aria-hidden="true"><path d="M54 25 C69 25 77 36 77 47 C77 57 69 62 66 68 H42 C39 62 31 57 31 47 C31 36 39 25 54 25 Z" fill="#F2A900" stroke="#F2A900" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 73 H64 M47 79 H61" fill="none" stroke="#A97600" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M45 52.5 L54 43.5 L63 52.5" fill="none" stroke="#FFFFFF" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

function lessonStatusIcon(lesson) {
  if (lesson.status === 'done') return '<span class="g-dot done">' + G_ICON.check + '</span>';
  if (lesson.status === 'skipped') return '<span class="g-dot skipped">' + G_ICON.skip + '</span>';
  if (lesson.status === 'current') return '<span class="g-dot current"></span>';
  return '<span class="g-dot"></span>';
}

function guidedTitleSub(course) {
  const progress = courseProgress(course);
  const lesson = currentLesson(course);
  if (course.status === 'ready') return 'Índice · ' + progress.lessons.length + (progress.lessons.length === 1 ? ' lección' : ' lecciones');
  if (course.status === 'exam') return 'Examen final';
  if (course.status === 'done') return 'Curso completado' + (course.examScore != null ? ' · examen ' + course.examScore + ' %' : '');
  if (lesson) return 'Lección ' + lesson.id.slice(1) + ' de ' + progress.lessons.length + ' · ' + lesson.title;
  return 'Plan del curso';
}

function lessonUnit(course, lessonId) {
  for (let i = 0; i < course.units.length; i++) {
    if (course.units[i].lessons.some((lesson) => lesson.id === lessonId)) return { index: i, unit: course.units[i] };
  }
  return null;
}

// The first answer of each lesson opens with its chapter title. The pager uses them as stops.
function guidedChapterMarkup(message, chat) {
  if (!chat || !chat.guidedLearning || !message || !message.lessonId) return '';
  const visible = chat.messages.filter((item) => !item.hidden && item.role === 'assistant');
  const index = visible.findIndex((item) => item.id === message.id);
  for (let i = index - 1; i >= 0; i--) {
    if (visible[i].lessonId) {
      if (visible[i].lessonId === message.lessonId) return '';
      break;
    }
  }
  const course = courseOf(chat);
  const lesson = findLesson(course, message.lessonId);
  if (!lesson) return '';
  const place = lessonUnit(course, lesson.id);
  return '<header class="g-chapter" data-lesson-start="' + escapeHtml(lesson.id) + '">' +
    (place ? '<span class="g-chapter-unit">Unidad ' + (place.index + 1) + ' · ' + escapeHtml(place.unit.title) + '</span>' : '') +
    '<span class="g-chapter-title"><span class="g-chapter-num">' + escapeHtml(lesson.id.slice(1)) + '</span><span class="g-chapter-name">' + escapeHtml(lesson.title) + '</span></span></header>';
}

function renderCourseHeader(chat) {
  if (!chat || !chat.guidedLearning) return '';
  const course = courseOf(chat);
  if (!course.units.length) return '';
  const progress = courseProgress(course);
  const lesson = currentLesson(course);
  const open = sessionGet('course-map::' + chat.id) === '1';
  const segments = progress.lessons.map((item) => '<span class="g-seg ' + item.status + '" title="' + escapeHtml('Lección ' + item.id.slice(1) + ' · ' + item.title) + '"></span>').join('');
  const finished = course.status === 'done';
  const bar = '<button type="button" class="g-bookbar" data-g-toggle-map aria-expanded="' + open + '" aria-label="Plan del curso: ' + progress.percent + ' % hecho">' +
    '<span class="g-segs">' + segments + '</span>' +
    '<span class="g-bk-end' + (finished ? ' lit' : '') + '">' + G_ICON.trophy + '<b>' + progress.percent + ' %</b></span></button>';
  const pager = course.status === 'learning' && lesson
    ? '<nav class="g-pager" aria-label="Lecciones"><button type="button" class="g-page-btn" data-g-page="prev">' + G_ICON.prev + '<span>Anterior</span></button>' +
      '<span class="g-pager-mid"><b>Lección ' + escapeHtml(lesson.id.slice(1)) + ' de ' + progress.lessons.length + '</b>' +
      '<button type="button" class="g-pager-plan" data-g-toggle-map>' + (open ? 'Cerrar plan' : 'Ver plan') + '</button></span>' +
      '<button type="button" class="g-page-btn" data-g-page="next"><span>Siguiente</span>' + G_ICON.next + '</button></nav>'
    : '';
  const map = !open ? '' : '<div class="g-map"><div class="g-map-head"><span>Índice</span><b>' + escapeHtml(course.title) + '</b></div>' +
    course.units.map((unit, index) =>
    '<div class="g-map-unit"><div class="g-map-unit-title">Unidad ' + (index + 1) + ' · ' + escapeHtml(unit.title) + '</div>' +
    unit.lessons.map((item) => '<div class="g-map-row ' + item.status + '"><span class="g-map-num">' + (item.status === 'done' ? G_ICON.check : escapeHtml(item.id.slice(1))) + '</span>' +
      '<span class="g-map-name">' + escapeHtml(item.title) + (item.status === 'current' ? '<em>Ahora</em>' : item.status === 'skipped' ? '<em class="muted">Saltada</em>' : '') + '</span><span class="g-leader"></span>' +
      (item.score != null ? '<span class="g-map-score">' + item.score + ' %</span>' : item.minutes ? '<span class="g-map-score">~' + item.minutes + ' min</span>' : '') +
      (item.status === 'current' && course.status === 'learning' ? '<button type="button" class="g-link" data-g-skip="' + item.id + '">Saltar</button>' : '') +
      '</div>').join('') + '</div>').join('') +
    '<div class="g-map-row exam ' + (finished ? 'done' : '') + '"><span class="g-map-num">' + G_ICON.trophy + '</span><span class="g-map-name">Examen final</span><span class="g-leader"></span>' +
    (course.examScore != null ? '<span class="g-map-score">' + course.examScore + ' %</span>' : '<span class="g-map-score">' + (course.status === 'exam' ? 'Ahora' : 'Al final') + '</span>') + '</div></div>';
  return '<div class="g-course' + (open ? ' open' : '') + '">' + bar + (pager || map ? '<div class="g-course-body">' + pager + map + '</div>' : '') + '</div>';
}

function renderGuidedHero(chat) {
  const course = courseOf(chat);
  const chips = (items, attr, current) => items.map((item) => '<button type="button" class="g-pill' + (item.id === current ? ' active' : '') + '" ' + attr + '="' + item.id + '">' +
    escapeHtml(item.label) + (item.note ? '<small>' + escapeHtml(item.note) + '</small>' : '') + '</button>').join('');
  const ideas = [
    ['Derivadas desde cero', 'Quiero aprender derivadas desde cero.'],
    ['La Revolución Francesa', 'Quiero aprender la Revolución Francesa para un examen.'],
    ['Estadística básica', 'Quiero aprender estadística básica: media, varianza y probabilidad.'],
    ['Con mis apuntes', 'Te subo mis apuntes: hazme un curso a partir de ellos.']
  ];
  return '<section class="hero g-hero">' +
    '<div class="g-hero-badge">' + G_ICON.cap + 'Aprendizaje guiado</div>' +
    '<h2>¿Qué quieres aprender?</h2>' +
    '<p class="hero-sub">Dime el tema o sube tus apuntes. Te preparo un plan por lecciones, te explico cada una con un mini test y terminamos con un examen final.</p>' +
    '<div class="g-setup"><div class="g-setup-row"><span class="g-setup-label">Nivel</span><div class="g-pills">' + chips(GUIDED_LEVELS, 'data-g-level', course.level) + '</div></div>' +
    '<div class="g-setup-row"><span class="g-setup-label">Duración</span><div class="g-pills">' + chips(GUIDED_LENGTHS, 'data-g-length', course.length) + '</div></div></div>' +
    '<ol class="g-steps"><li><b>1</b><span>Plan a tu medida</span></li><li><b>2</b><span>Lecciones y mini tests</span></li><li><b>3</b><span>Examen final</span></li></ol>' +
    '<div class="chips g-ideas">' + ideas.map((item) => '<button class="chip suggestion-chip" data-prompt="' + escapeHtml(item[1]) + '"><span class="g-idea-name">' + escapeHtml(item[0]) + '</span><span class="g-leader"></span></button>').join('') + '</div>' +
    '</section>';
}

function formatMinutes(total) {
  if (total < 60) return total + ' min';
  const hours = Math.floor(total / 60);
  const rest = Math.round((total % 60) / 5) * 5;
  return hours + ' h' + (rest ? ' ' + rest + ' min' : '');
}

const GUIDED_TWEAKS = {
  easier: { label: 'Más fácil', text: 'Ajusta el plan: empieza desde más abajo, no tengo base.' },
  shorter: { label: 'Más corto', text: 'Ajusta el plan: hazlo más corto, solo lo esencial.' },
  deeper: { label: 'Más a fondo', text: 'Ajusta el plan: hazlo más a fondo, con más lecciones y más nivel.' },
  practical: { label: 'Más práctico', text: 'Ajusta el plan: más práctico, con más ejemplos y ejercicios guiados.' }
};

function planLessonMarkup(lesson) {
  const node = '<span class="g-node ' + lesson.status + '">' +
    (lesson.status === 'done' ? G_ICON.check : lesson.status === 'skipped' ? G_ICON.skip : escapeHtml(lesson.id.slice(1))) + '</span>';
  const meta = lesson.score != null ? lesson.score + '%' : lesson.status === 'skipped' ? 'Saltada' : lesson.minutes ? '~' + lesson.minutes + ' min' : '';
  const head = node + '<span class="g-route-name">' + escapeHtml(lesson.title) + (lesson.status === 'current' ? '<em>Ahora</em>' : '') + '</span><span class="g-leader"></span>' +
    (meta ? '<span class="g-route-meta">' + escapeHtml(meta) + '</span>' : '');
  const objectives = lesson.objectives || [];
  if (!objectives.length) return '<div class="g-route-lesson ' + lesson.status + '"><div class="g-route-row">' + head + '</div></div>';
  return '<details class="g-route-lesson ' + lesson.status + '"><summary class="g-route-row">' + head + '<span class="g-route-chev">' + G_ICON.chevron + '</span></summary>' +
    '<ul class="g-route-objs">' + objectives.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul></details>';
}

function renderPlanCard(chat) {
  const course = courseOf(chat);
  const lessons = courseLessons(course);
  const progress = courseProgress(course);
  const ready = course.status === 'ready';
  const minutes = lessons.reduce((sum, lesson) => sum + (lesson.minutes || 0), 0);
  const timed = lessons.length && lessons.every((lesson) => lesson.minutes);
  const stat = (value, label) => '<span class="g-stat"><b>' + escapeHtml(String(value)) + '</b>' + escapeHtml(label) + '</span>';
  const hero = '<header class="g-plan-hero">' +
    '<span class="g-plan-top"><span class="g-plan-badge">' + G_ICON.cap + (ready ? 'Tu plan de estudio' : 'Plan del curso') + '</span><span class="g-plan-kicker">Índice</span></span>' +
    '<span class="g-plan-title">' + escapeHtml(course.title) + '</span>' +
    (course.goal ? '<span class="g-plan-goal">' + escapeHtml(course.goal) + '</span>' : '') +
    (ready
      ? '<span class="g-plan-stats">' + stat(lessons.length, lessons.length === 1 ? ' lección' : ' lecciones') +
        (timed ? stat('~' + formatMinutes(minutes), '') : '') + '<span class="g-stat exam">' + G_ICON.trophy + 'Examen final</span></span>'
      : '<span class="g-plan-progress"><span class="g-plan-bar"><span style="width:' + progress.percent + '%"></span></span><b>' + progress.percent + '%</b></span>') +
    '</header>';
  const route = course.units.map((unit, index) => '<div class="g-route-unit">' +
    '<div class="g-route-unit-head"><span class="g-route-unit-icon' + (unit.icon ? '' : ' num') + '">' + (unit.icon ? escapeHtml(unit.icon) : index + 1) + '</span>' +
    '<span class="g-route-unit-text"><small>Unidad ' + (index + 1) + '</small><b>' + escapeHtml(unit.title) + '</b></span></div>' +
    unit.lessons.map(planLessonMarkup).join('') + '</div>').join('') +
    '<div class="g-route-exam' + (course.status === 'done' ? ' done' : course.status === 'exam' ? ' current' : '') + '"><span class="g-node exam">' + G_ICON.trophy + '</span>' +
    '<span class="g-route-unit-text"><b>Examen final</b><small>' + (course.examScore != null ? 'Nota: ' + course.examScore + ' %' : 'De todo el curso · unas 2 preguntas por lección') + '</small></span></div>';
  const foot = ready
    ? '<div class="g-plan-foot"><button type="button" class="g-start" data-g-start>' + G_ICON.play + 'Empezar el curso</button>' +
      '<div class="g-tweaks"><span>¿Lo ajustamos?</span>' + Object.keys(GUIDED_TWEAKS).map((key) => '<button type="button" class="g-tweak" data-g-tweak="' + key + '">' + GUIDED_TWEAKS[key].label + '</button>').join('') +
      '<button type="button" class="g-tweak ghost" data-g-change-plan>Otro cambio…</button></div></div>'
    : '';
  return '<section class="g-card g-plan' + (ready ? ' ready' : '') + '">' + hero + '<div class="g-route">' + route + '</div>' + foot + '</section>';
}

function questionMarkup(quiz, question, index, mode) {
  const chosen = quiz.answers[index];
  const answered = chosen !== undefined;
  const reveal = mode === 'check' ? answered : quiz.submitted;
  const right = reveal && chosen === question.correct;
  if (mode === 'check' && answered) {
    const pick = (optionIndex) => LETTERS[optionIndex] + ' · ' + renderMarkdown(question.options[optionIndex] || '');
    return '<li data-motion-key="question:' + index + '" class="g-q compact ' + (right ? 'right' : 'wrong') + '"><span class="g-q-mark">' + (right ? G_ICON.check : G_ICON.cross) + '</span>' +
      '<div class="g-q-main"><div class="g-q-text">' + (index + 1) + '. ' + renderMarkdown(question.question) + '</div>' +
      '<div class="g-q-sum">Elegiste <b class="' + (right ? 'right' : 'wrong') + '">' + pick(chosen) + '</b>. ' +
      (right ? '<strong class="right">¡Bien!</strong> ' : '<strong class="wrong">Era la ' + LETTERS[question.correct] + '</strong>, <b class="right">' + renderMarkdown(question.options[question.correct] || '') + '</b>: ') +
      renderMarkdown(question.explanation || '') + '</div></div></li>';
  }
  const options = question.options.map((option, optionIndex) => {
    const classes = ['g-opt'];
    if (chosen === optionIndex) classes.push('chosen');
    if (reveal && optionIndex === question.correct) classes.push('correct');
    if (reveal && chosen === optionIndex && optionIndex !== question.correct) classes.push('wrong');
    const locked = quiz.submitted || quiz.superseded || (mode === 'check' && answered);
    return '<button type="button" class="' + classes.join(' ') + '"' + (locked ? ' disabled' : '') + ' data-g-answer="' + quiz.id + ':' + index + ':' + optionIndex + '">' +
      '<span class="g-opt-key">' + LETTERS[optionIndex] + '</span><span class="g-opt-text">' + renderMarkdown(option) + '</span>' +
      (reveal && optionIndex === question.correct ? '<span class="g-opt-mark">' + G_ICON.check + '</span>' : reveal && chosen === optionIndex ? '<span class="g-opt-mark">' + G_ICON.cross + '</span>' : '') +
      '</button>';
  }).join('');
  const feedback = reveal
    ? '<div class="g-feedback ' + (right ? 'right' : 'wrong') + '"><strong>' + (right ? '¡Bien!' : 'Era la ' + LETTERS[question.correct] + '.') + '</strong> ' + renderMarkdown(question.explanation || '') + '</div>'
    : '';
  return '<li data-motion-key="question:' + index + '" class="g-q' + (reveal ? (right ? ' right' : ' wrong') : '') + '"><div class="g-q-num">' + (index + 1) + '</div><div class="g-q-main"><div class="g-q-text">' + renderMarkdown(question.question) + '</div>' +
    '<div class="g-options">' + options + '</div>' + feedback + '</div></li>';
}

function renderQuizCard(course, quiz) {
  const lesson = findLesson(course, quiz.lessonId);
  const answered = Object.keys(quiz.answers).length;
  const total = quiz.questions.length;
  const right = quiz.questions.filter((question, index) => quiz.answers[index] === question.correct).length;
  const dots = quiz.questions.map((question, index) => {
    const value = quiz.answers[index];
    return '<span class="g-qdot' + (value === undefined ? '' : value === question.correct ? ' right' : ' wrong') + '"></span>';
  }).join('');
  let foot;
  if (quiz.superseded && !quiz.submitted) {
    foot = '<span class="g-foot-note">Sustituido por un test nuevo.</span>';
  } else if (quiz.submitted) {
    const passed = quiz.score >= GUIDED_PASS;
    foot = '<span class="g-result ' + (passed ? 'pass' : 'fail') + '">' + (passed ? G_ICON.check : G_ICON.cross) + right + '/' + total + ' · ' + quiz.score + '% · ' + (passed ? 'Aprobado' : 'Repasamos y otro intento') + '</span>';
  } else {
    foot = '<span class="g-foot-note">' + (answered < total ? answered + ' de ' + total + ' respondidas' : right + ' de ' + total + ' bien') + '</span>' +
      '<button type="button" class="g-primary" data-g-submit="' + quiz.id + '"' + (answered < total ? ' disabled' : '') + '>Continuar</button>';
  }
  const next = quiz.questions.findIndex((question, index) => quiz.answers[index] === undefined);
  const position = quiz.submitted || next === -1 ? right + ' de ' + total + ' bien' : 'Pregunta ' + (next + 1) + ' de ' + total;
  return '<section class="g-card g-quiz' + (quiz.submitted ? ' submitted' : '') + '" data-g-quiz="' + quiz.id + '">' +
    '<header class="g-card-head row"><div><span class="g-eyebrow">Mini test' + (lesson ? ' · Lección ' + lesson.id.slice(1) + '<span class="g-eyebrow-extra"> · ' + escapeHtml(lesson.title) + '</span>' : '') + '</span>' +
    '<span class="g-title">Ejercicios del capítulo</span></div><div class="g-qside"><span class="g-qpos">' + position + '</span><div class="g-qdots">' + dots + '</div></div></header>' +
    '<ol class="g-questions">' + quiz.questions.map((question, index) => questionMarkup(quiz, question, index, 'check')).join('') + '</ol>' +
    '<div class="g-card-foot">' + foot + '</div></section>';
}

function scoreRing(percent) {
  const r = 26, c = 2 * Math.PI * r, color = percent >= 85 ? '#16a34a' : percent >= GUIDED_PASS ? '#ca8a04' : '#dc2626';
  return '<svg class="g-ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="' + r + '" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="6"/>' +
    '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="6" stroke-linecap="round" stroke-dasharray="' + (c * percent / 100).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 32 32)"/>' +
    '<text x="32" y="37" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor">' + percent + '%</text></svg>';
}

function renderExamCard(course, quiz) {
  const answered = Object.keys(quiz.answers).length;
  const total = quiz.questions.length;
  const pct = Math.round((answered / Math.max(1, total)) * 100);
  const questions = '<ol class="g-questions">' + quiz.questions.map((question, index) => questionMarkup(quiz, question, index, 'exam')).join('') + '</ol>';
  const head = (title) => '<header class="g-card-head g-exam-head"><span class="g-exam-icon">' + G_ICON.trophy + '</span><div><span class="g-eyebrow">Examen final · ' + total + ' preguntas</span>' +
    '<span class="g-title">' + escapeHtml(title) + '</span></div>' + (quiz.submitted ? '<span class="g-page-kicker">Última página</span>' : '') + '</header>';
  if (quiz.submitted) {
    const grade = gradeQuiz(quiz);
    const passed = grade.percent >= GUIDED_PASS;
    const verdict = grade.percent >= 85 ? '¡Dominas el curso!' : passed ? 'Aprobado. Repasa lo marcado en rojo.' : 'Aún no: repasa las lecciones en rojo y repite el examen.';
    const dots = quiz.questions.map((question, index) => '<span class="' + (quiz.answers[index] === question.correct ? 'right' : 'wrong') + '"></span>').join('');
    const breakdown = quiz.byLesson && quiz.byLesson.length
      ? '<div class="g-breakdown">' + quiz.byLesson.map((item) => {
        const ok = item.percent >= GUIDED_PASS;
        return '<div class="g-break-row' + (ok ? '' : ' fail') + '"><span class="g-break-num">' + escapeHtml(String(item.id).slice(1)) + '</span>' +
          '<span class="g-break-name">' + escapeHtml(item.title) + (ok ? '' : '<em>Repasar</em>') + '</span><span class="g-leader"></span>' +
          '<span class="g-break-pct">' + item.right + '/' + item.total + '</span></div>';
      }).join('') + '</div>'
      : '';
    const done = course.status === 'done';
    const fin = done
      ? '<div class="g-fin"><span class="g-fin-bulb">' + G_ICON.bulb + '</span><span class="g-fin-text"><b>Fin</b><span>Curso completado · examen ' + grade.percent + ' %' +
        (quiz.createdAt ? ' · ' + escapeHtml(new Date(quiz.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })) : '') + '</span></span></div>'
      : '';
    return '<section class="g-card g-exam submitted g-lastpage" data-g-quiz="' + quiz.id + '">' + head(passed && done ? 'Curso completado' : 'Examen corregido') +
      '<div class="g-final"><span class="g-final-pct">' + grade.percent + '<small>%</small></span><div class="g-final-side">' +
      '<span class="g-pass-chip ' + (passed ? 'pass' : 'fail') + '">' + (passed ? G_ICON.check : G_ICON.cross) + (passed ? 'Aprobado' : 'Suspendido') + ' · ' + grade.right + '/' + grade.total + '</span>' +
      '<p>' + verdict + '</p><span class="g-final-dots">' + dots + '</span></div></div>' + breakdown +
      '<details class="g-correction"><summary>Ver la corrección</summary>' + questions + '</details>' + fin + '</section>';
  }
  const foot = quiz.superseded
    ? '<span class="g-foot-note">Sustituido por otro examen.</span>'
    : '<span class="g-foot-note">' + answered + ' de ' + total + ' respondidas</span><button type="button" class="g-primary" data-g-submit="' + quiz.id + '"' + (answered < total ? ' disabled' : '') + '>Entregar examen</button>';
  return '<section class="g-card g-exam" data-g-quiz="' + quiz.id + '">' + head(course.title || 'Examen final') +
    '<div class="g-exam-progress"><span style="width:' + pct + '%"></span></div>' + questions +
    '<div class="g-card-foot">' + foot + '</div></section>';
}

function lastPlanMessageId(chat) {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const cards = chat.messages[i].guidedCards || [];
    if (cards.some((card) => card.type === 'plan')) return chat.messages[i].id;
  }
  return '';
}

function renderGuidedCards(message, chat) {
  const cards = message && message.guidedCards;
  if (!cards || !cards.length || !chat || !chat.guidedLearning) return '';
  const course = courseOf(chat);
  const planId = lastPlanMessageId(chat);
  return cards.map((card) => {
    if (card.type === 'plan') {
      // Only the latest plan is drawn in full; older ones were replaced.
      return message.id === planId ? renderPlanCard(chat)
        : '<div class="g-note">' + G_ICON.cap + 'Plan sustituido por el de más abajo.</div>';
    }
    const quiz = course.quizzes[card.quizId];
    if (!quiz) return '';
    return quiz.kind === 'exam' ? renderExamCard(course, quiz) : renderQuizCard(course, quiz);
  }).join('');
}

// Course cards elsewhere in the thread follow the course: a replaced plan
// collapses, a started plan loses its buttons. Only slots whose drawing
// changed are redrawn, so open lessons and answers stay as they are.
const guidedSlotHtml = new WeakMap();
function refreshGuidedCardSlots(chat, exceptId) {
  if (!chat || !chat.guidedLearning || chat.id !== appState.activeChatId) return;
  chat.messages.forEach((message) => {
    if (message.id === exceptId || !(message.guidedCards || []).length) return;
    const article = findMessageElement(message.id);
    const slot = article && article.querySelector('.slot-cards');
    if (!slot) return;
    const html = renderGuidedCards(message, chat);
    if (guidedSlotHtml.get(slot) === html) return;
    slot.innerHTML = html;
    enhanceRichContent(slot, { renderMath: true, latexPreview: false });
    guidedSlotHtml.set(slot, html);
  });
}

// Result of a mini test or the exam: a compact chip instead of the text the model reads.
function renderGuidedResultMessage(message) {
  const result = message && message.result;
  if (!result) return '';
  return '<article class="message user-msg g-result-msg' + messageAppearClass(message) + '" data-msg-id="' + message.id + '"><div class="message-body">' +
    '<div class="g-result-chip ' + (result.passed ? 'pass' : 'fail') + '">' + (message.kind === 'exam-result' ? G_ICON.trophy : result.passed ? G_ICON.check : G_ICON.cross) +
    '<span class="g-result-label">' + escapeHtml(result.label) + '</span><span class="g-result-score">' + result.right + '/' + result.total + ' · ' + result.percent + '%</span></div></div></article>';
}

function guidedQuickRepliesMarkup(chat) {
  if (!chat || !chat.guidedLearning || appState.busy) return '';
  const course = courseOf(chat);
  let keys = [];
  if (course.status === 'learning' && !pendingQuiz(course, 'check')) keys = ['next', 'visual', 'example', 'confused', 'test'];
  else if (course.status === 'done') keys = ['review', 'retake'];
  if (!keys.length) return '';
  const labels = { next: 'Sigue', visual: 'Muéstramelo', example: 'Otro ejemplo', confused: 'No lo entiendo', test: 'Ponme a prueba', review: 'Repasar lo que fallé', retake: 'Repetir el examen' };
  return '<div class="g-quick">' + keys.map((key) => '<button type="button" class="g-quick-btn' + (key === 'test' || key === 'retake' ? ' accent' : '') + '" data-g-quick="' + key + '">' + labels[key] + '</button>').join('') + '</div>';
}
