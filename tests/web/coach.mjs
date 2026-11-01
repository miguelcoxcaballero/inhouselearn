// createToolCoach (engine/src/coach.js): the hints the engine adds to tool
// results so the model does not repeat a failing call or skip checking its work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolCoach, NOTE_MARK, COACH_NOTES, ULTRA_NUDGE_AT, withoutNotes } from '../../engine/src/coach.js';

const call = (name, args, isError, text = isError ? 'Error: no existe' : 'ok') => ({
  toolCall: { id: 'c' + Math.random(), name, arguments: args },
  args,
  result: { content: [{ type: 'text', text }], details: {} },
  isError
});
const noteOf = (out) => {
  if (!out) return '';
  const last = out.content[out.content.length - 1];
  return last.type === 'text' && last.text.startsWith(NOTE_MARK) ? last.text : '';
};

test('first failure, then the same failing call again', async () => {
  const coach = createToolCoach();
  const first = await coach(call('read_file', { path: 'a.md', offset: 1 }, true));
  assert.ok(noteOf(first).includes(COACH_NOTES.firstFailure));
  assert.equal(first.content[0].text, 'Error: no existe', 'keeps the original result first');
  // Same arguments in another key order: still the same call.
  const repeat = await coach(call('read_file', { offset: 1, path: 'a.md' }, true));
  assert.ok(noteOf(repeat).includes(COACH_NOTES.repeat));
  assert.ok(!noteOf(repeat).includes(COACH_NOTES.firstFailure));
  // Other arguments: no repeat note, and the first-failure note is not given twice.
  const other = await coach(call('read_file', { path: 'b.md' }, true));
  assert.ok(!noteOf(other).includes(COACH_NOTES.repeat));
  const fourth = await coach(call('search_files', { pattern: 'x' }, true));
  assert.ok(noteOf(fourth).includes(COACH_NOTES.manyErrors(4)));
  const fifth = await coach(call('search_files', { pattern: 'y' }, true));
  assert.ok(!noteOf(fifth).includes('errores de herramientas'), 'many-errors note only once');
  assert.equal(coach.errors, 5);
});

test('web_fetch errors suggest another source', async () => {
  const coach = createToolCoach();
  const out = await coach(call('web_fetch', { url: 'https://example.com' }, true));
  assert.ok(noteOf(out).includes(COACH_NOTES.webFetch));
});

test('success hints once per tool, only where they apply', async () => {
  const coach = createToolCoach();
  assert.ok(noteOf(await coach(call('doc_edit', { code: '' }, false))).includes('doc_view'));
  assert.equal(await coach(call('doc_edit', { code: '' }, false)), undefined, 'only once');
  assert.ok(noteOf(await coach(call('latex_compile', {}, false))).includes('doc_view'));
  assert.equal(await coach(call('write_file', { path: 'apuntes.md', content: 'x' }, false)), undefined, 'not for notes');
  assert.ok(noteOf(await coach(call('write_file', { path: 'src/app.mjs', content: 'x' }, false))).includes('run_js'));
  assert.ok(noteOf(await coach(call('edit_file', { path: 'data.json' }, false))).includes('run_js'));
  assert.ok(noteOf(await coach(call('github_write_files', {}, false))).includes('github_ci_status'));
  assert.equal(await coach(call('read_file', { path: 'a' }, false)), undefined);
});

test('never a note on Guided Learning and bookkeeping tools', async () => {
  const coach = createToolCoach();
  for (const name of ['set_course_plan', 'quiz', 'final_exam', 'check_diagram', 'think', 'update_plan', 'ask_user', 'submit_result']) {
    assert.equal(await coach(call(name, { a: 1 }, true)), undefined, name + ' failing');
    assert.equal(await coach(call(name, { a: 1 }, true)), undefined, name + ' repeated');
    assert.equal(await coach(call(name, { a: 1 }, false)), undefined, name + ' ok');
  }
  assert.equal(coach.errors, 0, 'silent tools do not count as errors');
});

test('Ultra code: a reminder to fan out after 4 calls made alone, and once more at 12', async () => {
  const coach = createToolCoach({ ultra: true });
  assert.deepEqual(ULTRA_NUDGE_AT, [4, 12]);
  for (let calls = 1; calls <= 16; calls++) {
    const note = noteOf(await coach(call('read_file', { path: 'f' + calls }, false)));
    if (calls === 4 || calls === 12) {
      assert.ok(note.includes(COACH_NOTES.ultra(calls)), 'reminder at call ' + calls + ': ' + note);
      assert.ok(note.includes('spawn_agents') && note.includes('acceptance'));
    } else assert.equal(note, '', 'no reminder at call ' + calls);
  }
});

test('Ultra code: no reminder once it fanned out, none when Ultra is off, bookkeeping tools do not count', async () => {
  const fanned = createToolCoach({ ultra: true });
  await fanned(call('read_file', { path: 'a' }, false));
  assert.equal(await fanned(call('spawn_agents', { agents: [] }, false)), undefined);
  for (let i = 0; i < 20; i++) assert.equal(await fanned(call('read_file', { path: 'x' + i }, false)), undefined, 'after spawn_agents');
  const off = createToolCoach();
  for (let i = 0; i < 20; i++) assert.equal(await off(call('read_file', { path: 'y' + i }, false)), undefined, 'Ultra off');
  const alone = createToolCoach({ ultra: true });
  for (const name of ['update_plan', 'think', 'ask_user']) for (let i = 0; i < 6; i++) assert.equal(await alone(call(name, { i }, false)), undefined, name + ' does not count');
  for (let i = 1; i <= 3; i++) assert.equal(await alone(call('read_file', { path: 'z' + i }, false)), undefined);
  const fourth = await alone(call('web_search', { query: 'q' }, false));
  assert.ok(noteOf(fourth).includes(COACH_NOTES.ultra(4)), 'the fourth real call');
  // The reminder never reaches what the user sees, and a failing call keeps its own hints too.
  assert.deepEqual(withoutNotes(fourth.content), [{ type: 'text', text: 'ok' }]);
  const failing = createToolCoach({ ultra: true });
  for (let i = 1; i <= 3; i++) await failing(call('read_file', { path: 'e' + i }, true));
  const both = noteOf(await failing(call('read_file', { path: 'e4' }, true)));
  assert.ok(both.includes(COACH_NOTES.ultra(4)) && both.includes(COACH_NOTES.manyErrors(4)));
});

test('withoutNotes removes only the notes', async () => {
  const coach = createToolCoach();
  const out = await coach(call('read_file', { path: 'x' }, true));
  assert.deepEqual(withoutNotes(out.content), [{ type: 'text', text: 'Error: no existe' }]);
});
