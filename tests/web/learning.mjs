import test from 'node:test';
import assert from 'node:assert/strict';
import Learning from '../../learning.js';
const at = Date.UTC(2026, 9, 23, 12);
const choice = (question, lessonId) => ({ question, lessonId, options: ['Correct', 'Mistake'], correct: 0 });
const make = () => ({ units: [{ lessons: [{ id: 'L1', key: 'forces', status: 'done' }, { id: 'L2', key: 'energy', status: 'done' }, { id: 'L3', status: 'skipped' }] }], quizzes: {} });
const finish = (course, id, questions, answers, time = at, hints = {}) => {
  const quiz = { id, kind: 'check', questions, answers, hints, submitted: true, createdAt: new Date(time).toISOString() };
  course.quizzes[id] = quiz; Learning.settle(course, quiz, time); return quiz;
};
test('numeric answers accept decimal commas, signs and exponents without evaluating expressions or silently dropping units', () => {
  for (const [value, expected] of [['1,25',1.25],['1.25e3',1250],['−0,5',-.5],['.2',.2],[0,0]]) assert.equal(Learning.number(value),expected);
  for (const value of ['', ' ', '1/2', '12 N', '1,2,3', 'NaN', 'Infinity', '1e999', 'alert(1)']) assert.equal(Learning.number(value),null);
  assert.ok(Learning.correct({type:'numeric',answer:10,tolerance:.1},10.1));
  assert.ok(!Learning.correct({type:'numeric',answer:10,tolerance:.1},10.1001));
  assert.ok(Learning.correct({type:'numeric',answer:0,tolerance:0},0));
  assert.ok(!Learning.correct({type:'numeric',answer:0,tolerance:0},''));
  assert.ok(!Learning.correct({type:'numeric',answer:1e-20,tolerance:0},0));
  assert.ok(!Learning.correct({type:'numeric',answer:0,tolerance:0},1e-20));
});
test('retrieval intervals grow only after due successful independent practice, early practice keeps the appointment', () => {
  const lesson = {};
  Learning.recordEvidence(lesson,100,false,at);
  assert.equal(lesson.memory.dueAt,at+Learning.DAY);
  Learning.recordEvidence(lesson,100,false,at+10000);
  assert.equal(lesson.memory.stage,1); assert.equal(lesson.memory.dueAt,at+Learning.DAY);
  Learning.recordEvidence(lesson,100,false,at+Learning.DAY);
  assert.equal(lesson.memory.stage,2); assert.equal(lesson.memory.dueAt,at+4*Learning.DAY);
  Learning.recordEvidence(lesson,100,false,at+4*Learning.DAY);
  assert.equal(lesson.memory.stage,3); assert.equal(lesson.memory.dueAt,at+11*Learning.DAY);
  Learning.recordEvidence(lesson,0,false,at+5*Learning.DAY);
  assert.equal(lesson.memory.stage,0); assert.equal(lesson.memory.dueAt,at+5*Learning.DAY+600000);
  Learning.recordEvidence(lesson,100,true,at+6*Learning.DAY);
  assert.equal(lesson.memory.stage,1); assert.equal(Learning.memoryLabel(lesson,at+6*Learning.DAY),'Con ayuda');
});
test('awards are idempotent, capped per concept/day, survive JSON reload and roll over by day', () => {
  const course=make(), questions=[1,2,3,4].map(n=>choice('Q'+n,'L1'));
  const quiz=finish(course,'a',questions,{0:0,1:0,2:0,3:0});
  assert.equal(quiz.reward.xp,40);
  Learning.settle(course,quiz,at); assert.equal(course.learning.xp,40);
  const restored=JSON.parse(JSON.stringify(course));
  finish(restored,'b',questions,{0:0,1:0,2:0,3:0});
  assert.equal(restored.learning.xp,40); assert.equal(Learning.summary(restored,at).today,4);
  finish(restored,'c',questions,{0:0,1:0,2:0,3:0},at+Learning.DAY);
  assert.equal(restored.learning.xp,80); assert.equal(Learning.summary(restored,at+Learning.DAY).today,4);
});
test('mixed review prioritizes errors, alternates concepts, excludes untested skipped lessons and leaves sources untouched', () => {
  const course=make();
  finish(course,'a',[choice('F1','L1'),choice('F2','L1')],{0:0,1:1});
  finish(course,'b',[choice('E1','L2'),choice('E2','L2')],{0:0,1:0});
  const source=JSON.stringify(course.quizzes);
  const review=Learning.reviewQuestions(course,at+Learning.DAY);
  assert.deepEqual(review.map(q=>q.lessonId),['L1','L2','L1','L2']);
  assert.equal(review[0].question,'F2');
  review[0].options.reverse(); assert.equal(JSON.stringify(course.quizzes),source);
  assert.equal(Learning.dueLessons(course,at+Learning.DAY).length,2);
});
test('existing courses migrate without invented XP or retrospective memory evidence', () => {
  const course=make();
  course.quizzes.legacy={submitted:true,lessonId:'L1',questions:[choice('old')],answers:{0:0},createdAt:'2020-01-01'};
  assert.equal(Learning.summary(course,at).xp,0);
  assert.equal(Learning.summary(course,at).due,1);
  assert.equal(Learning.memoryLabel(course.units[0].lessons[0],at),'Por repasar');
  assert.equal(Learning.memoryLabel(course.units[0].lessons[2],at),'Sin comprobar');
  assert.ok(!course.units[0].lessons[0].memory);
});
