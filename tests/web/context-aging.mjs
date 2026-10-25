// ageToolResults (engine/src/context.js): old tool results are trimmed before
// each request so a long turn fits the model's context, without breaking the
// toolCall/toolResult pairs, touching the newest rounds or mutating the input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageToolResults, estimateContextChars } from '../../engine/src/context.js';

const TOOLS = ['read_file', 'web_fetch', 'read_library', 'github_read_file', 'drive_read'];

// 30 rounds: user → assistant(toolCall) → toolResult(20k) → assistant(text).
function transcript() {
  const messages = [{ role: 'system', content: 'Eres un tutor.' }];
  for (let i = 0; i < 30; i++) {
    const name = TOOLS[i % TOOLS.length];
    const text = ('Resultado ' + i + ' ').padEnd(20000, String.fromCharCode(97 + (i % 26)));
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Pregunta ' + i }] });
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'call' + i, name, arguments: { path: 'f' + i } }], stopReason: 'toolUse' });
    const content = [{ type: 'text', text }];
    if (i % 7 === 0) content.push({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    messages.push({ role: 'toolResult', toolCallId: 'call' + i, toolName: name, content, isError: false });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Respuesta ' + i }], stopReason: 'stop' });
  }
  return messages;
}

const textOf = (message) => message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');

test('old results respect oldMax, the marker names the tool, the last rounds stay intact', () => {
  const input = transcript();
  const out = ageToolResults(input, { oldMax: 3000, keepRounds: 2 });
  const results = out.filter((message) => message.role === 'toolResult');
  assert.equal(results.length, 30);
  results.forEach((message, i) => {
    const text = textOf(message);
    if (i >= 28) {
      assert.deepEqual(message, input.find((item) => item.toolCallId === message.toolCallId), 'round ' + i + ' must stay as it was');
      return;
    }
    assert.ok(text.length <= 3000 + 300, 'round ' + i + ' too long: ' + text.length);
    for (const block of message.content.filter((item) => item.type === 'text' && item.text.length > 200)) {
      assert.ok(block.text.length <= 3000, 'trimmed block over oldMax: ' + block.text.length);
      assert.match(block.text, new RegExp('recortado: \\d+ de 20000 caracteres\\. Si lo necesitas, vuelve a llamar a ' + message.toolName + ' con los mismos argumentos'));
      assert.ok(block.text.startsWith('Resultado ' + i + ' '), 'keeps the head');
    }
    assert.ok(!message.content.some((block) => block.type === 'image'), 'old images become text');
    if (i % 7 === 0) assert.ok(message.content.some((block) => block.type === 'text' && /imagen retirada/.test(block.text) && block.text.includes(message.toolName)));
  });
});

test('the input is never mutated and pairs are kept in order', () => {
  const input = transcript();
  const frozen = JSON.stringify(input);
  const out = ageToolResults(input, { oldMax: 2000, budget: 50000 });
  assert.equal(JSON.stringify(input), frozen);
  assert.equal(out.length, input.length);
  out.forEach((message, i) => {
    assert.equal(message.role, input[i].role);
    if (message.role === 'toolResult') {
      const call = out[i - 1].content.find((block) => block.type === 'toolCall');
      assert.equal(call.id, message.toolCallId, 'toolResult right after its toolCall');
      assert.equal(message.toolCallId, input[i].toolCallId);
    }
  });
  // Messages without changes keep their identity (cheap and cache-friendly).
  assert.equal(out[1], input[1]);
});

test('idempotent and deterministic, also with a budget', () => {
  for (const opts of [{ oldMax: 4000 }, { oldMax: 6000, budget: 100000 }, { budget: 1000 }, {}]) {
    const once = ageToolResults(transcript(), opts);
    const again = ageToolResults(transcript(), opts);
    assert.deepEqual(once, again, 'deterministic ' + JSON.stringify(opts));
    const twice = ageToolResults(once, opts);
    assert.deepEqual(twice, once, 'idempotent ' + JSON.stringify(opts));
  }
});

test('a budget makes the estimate fit when the old results allow it', () => {
  const input = transcript();
  const before = estimateContextChars(input);
  const budget = 80000;
  const out = ageToolResults(input, { budget });
  const after = estimateContextChars(out);
  assert.ok(before > 600000, 'synthetic transcript is big: ' + before);
  assert.ok(after <= budget, 'fits the budget: ' + after);
  // The newest two rounds still whole.
  const results = out.filter((message) => message.role === 'toolResult');
  assert.equal(textOf(results[29]).length, 20000);
  assert.equal(textOf(results[28]).length, 20000);
});

test('a small transcript comes back as the same array', () => {
  const input = transcript().slice(0, 9);
  assert.equal(ageToolResults(input, { oldMax: 50000 }), input);
  assert.deepEqual(ageToolResults([], {}), []);
});
