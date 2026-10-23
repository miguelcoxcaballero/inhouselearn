/* Learning evidence, spaced retrieval and earned progress. No model or DOM.
   Intervals are a product heuristic, not a validated personal memory model. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const INTERVALS = [1, 3, 7, 14, 30];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const lessons = course => (course.units || []).flatMap(unit => unit.lessons || []);
  function dayKey(at = Date.now()) {
    const date = new Date(at);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  function state(course) {
    const value = course.learning || {};
    lessons(course).forEach(lesson => { if (!lesson.key) lesson.key = 'legacy:' + (course.createdAt || course.title || '') + ':' + lesson.id; });
    course.learning = {
      v: 1, xp: finite(value.xp) ? Math.max(0, value.xp) : 0,
      goal: [3, 6, 10].includes(value.goal) ? value.goal : 6,
      days: value.days && typeof value.days === 'object' && !Array.isArray(value.days) ? value.days : {}
    };
    return course.learning;
  }
  // Decimal comma, decimal point and scientific notation, never eval(). Units
  // are explicit in the question; accepting an unparsed suffix would hide errors.
  function number(text) {
    if (typeof text === 'number') return finite(text) ? text : null;
    const value = String(text ?? '').trim().replace(/\u2212/g, '-').replace(',', '.');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function correct(question, answer) {
    if (answer === undefined || answer === null || answer === '') return false;
    if (question.type !== 'numeric') return Number.isInteger(answer) && answer === question.correct;
    const value = number(answer);
    if (value === null || !finite(question.answer)) return false;
    const tolerance = finite(question.tolerance) ? Math.max(0, question.tolerance) : 0;
    return Math.abs(value - question.answer) <= tolerance + Number.EPSILON * Math.max(Math.abs(question.answer), Math.abs(value)) * 4;
  }
  function memoryLabel(lesson, at = Date.now()) {
    const memory = lesson.memory;
    if (!memory) return lesson.status === 'done' ? 'Por repasar' : lesson.status === 'skipped' ? 'Sin comprobar' : 'Por descubrir';
    if (memory.score < 70) return 'Reforzar';
    if (memory.dueAt <= at) return 'Toca recordar';
    if (memory.stage >= 3) return 'Consolidando';
    if (memory.stage >= 2) return 'Recordado';
    return memory.assisted ? 'Con ayuda' : 'Comprendido';
  }
  function recordEvidence(lesson, score, assisted, at = Date.now()) {
    const before = lesson.memory;
    const due = !before || !finite(before.dueAt) || before.dueAt <= at;
    const passed = score >= 70;
    const stage = !passed ? 0 : assisted ? Math.min(before?.stage || 1, 1)
      : due ? Math.min(5, (before?.stage || 0) + 1) : before.stage;
    // Early, successful extra practice must not postpone the scheduled recall.
    const dueAt = passed && !assisted && before && !due ? before.dueAt
      : at + (passed ? INTERVALS[Math.max(0, stage - 1)] * DAY : 10 * 60000);
    lesson.memory = { stage, score, assisted: !!assisted, dueAt, lastAt: at };
    return lesson.memory;
  }
  function eligible(course) {
    return lessons(course).filter(lesson => Object.values(course.quizzes || {}).some(quiz =>
      quiz.submitted && !quiz.superseded && quiz.questions?.some(question => (question.lessonId || quiz.lessonId) === lesson.id)));
  }
  function dueLessons(course, at = Date.now()) {
    return eligible(course).filter(lesson => !lesson.memory || lesson.memory.dueAt <= at)
      .sort((a, b) => (a.memory?.dueAt || 0) - (b.memory?.dueAt || 0));
  }
  function reviewQuestions(course, at = Date.now(), extra = false) {
    let selected = dueLessons(course, at);
    if (!selected.length && extra) selected = eligible(course).sort((a, b) => (a.memory?.score || 0) - (b.memory?.score || 0));
    const pools = selected.slice(0, 3).map(lesson => {
      const seen = new Set();
      const pool = Object.values(course.quizzes || {}).filter(quiz => quiz.submitted && !quiz.superseded)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .flatMap(quiz => quiz.questions.map((question, index) => ({ question, missed: !correct(question, quiz.answers[index]), lessonId: question.lessonId || quiz.lessonId })))
        .filter(item => {
          if (item.lessonId !== lesson.id || seen.has(item.question.question)) return false;
          seen.add(item.question.question); return true;
        }).sort((a, b) => Number(b.missed) - Number(a.missed));
      return pool.slice(0, 3).map(item => ({ ...item.question, options: item.question.options?.slice(), lessonId: lesson.id }));
    });
    // Alternate concepts: choosing a method is part of the exercise.
    const result = [];
    for (let round = 0; round < 3 && result.length < 5; round++) {
      for (const pool of pools) if (pool[round] && result.length < 5) result.push(pool[round]);
    }
    return result;
  }
  // Reuse only answered practice: never reveal a pending test or exam.
  // Skill metadata orders the challenge; it is not a calibrated difficulty score.
  function waitingQuestions(course, offset = 0) {
    const ids = new Set(lessons(course).map(lesson => lesson.id));
    const seen = new Set(), buckets = [[], [], []];
    Object.values(course.quizzes || {}).filter(quiz => quiz.submitted && !quiz.superseded)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .forEach(quiz => (quiz.questions || []).forEach((question, index) => {
        const lessonId = question.lessonId || quiz.lessonId;
        if (!ids.has(lessonId) || quiz.answers?.[index] === undefined || !question.question || seen.has(question.question)) return;
        const numeric = question.type === 'numeric';
        if (numeric ? !finite(question.answer) || !finite(question.tolerance) || question.tolerance < 0
          : !Array.isArray(question.options) || !Number.isInteger(question.correct) || !question.options[question.correct]) return;
        seen.add(question.question);
        const rank = question.skill === 'transfer' ? 2 : question.skill === 'apply' || numeric ? 1 : 0;
        buckets[rank].push({ ...question, options: question.options?.slice(), lessonId, skill: ['recall','apply','transfer'][rank] });
      }));
    const result = [];
    for (const bucket of buckets) {
      for (let i = 0; i < Math.min(2, bucket.length); i++) result.push(bucket[(offset + i) % bucket.length]);
    }
    return result;
  }
  function settle(course, quiz, at = Date.now()) {
    if (quiz.reward || !quiz.submitted) return quiz.reward || null;
    const progress = state(course);
    const key = dayKey(at);
    const day = progress.days[key] || { xp: 0, count: 0, lessons: {} };
    day.lessons ||= {};
    const groups = new Map();
    quiz.questions.forEach((question, index) => {
      const lessonId = question.lessonId || quiz.lessonId;
      if (!groups.has(lessonId)) groups.set(lessonId, []);
      groups.get(lessonId).push({ right: correct(question, quiz.answers[index]), helped: !!quiz.hints?.[index] });
    });
    let xp = 0, count = 0;
    for (const [id, items] of groups) {
      const lesson = lessons(course).find(item => item.id === id);
      if (!lesson) continue;
      recordEvidence(lesson, Math.round(items.filter(item => item.right).length / items.length * 100), items.some(item => item.helped), at);
      const lessonKey = lesson.key || lesson.id;
      const used = day.lessons[lessonKey] || { xp: 0, count: 0 };
      // Extra attempts remain useful, but cannot inflate the daily goal/XP.
      const earned = Math.min(40 - used.xp, items.reduce((sum, item) => sum + (item.right ? item.helped ? 4 : 10 : 2), 0));
      const attempts = Math.max(0, Math.min(4 - used.count, items.length));
      day.lessons[lessonKey] = { xp: used.xp + Math.max(0, earned), count: used.count + attempts };
      xp += Math.max(0, earned); count += attempts;
    }
    day.xp += xp; day.count += count;
    progress.days[key] = day;
    progress.xp += xp;
    Object.keys(progress.days).sort().slice(0, -90).forEach(old => delete progress.days[old]);
    quiz.reward = { xp, count, at, day: key };
    return quiz.reward;
  }
  function summary(course, at = Date.now()) {
    const progress = state(course);
    const today = progress.days[dayKey(at)] || { count: 0, xp: 0 };
    const level = Math.floor(progress.xp / 100) + 1;
    const practiced = eligible(course);
    const next = practiced.map(lesson => lesson.memory?.dueAt).filter(time => finite(time) && time > at).sort((a, b) => a - b)[0];
    return { xp: progress.xp, level, levelProgress: progress.xp % 100, goal: progress.goal, today: today.count,
      due: dueLessons(course, at).length, practiced: practiced.length, next,
      recalled: practiced.filter(lesson => lesson.memory?.stage >= 2).length };
  }
  const api = { DAY, number, correct, state, dayKey, memoryLabel, recordEvidence, dueLessons, reviewQuestions, waitingQuestions, settle, summary };
  root.GuidedLearning = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
