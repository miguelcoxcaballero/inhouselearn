import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textQualityIssues, protectedTextSpans } from '../../engine/src/text-quality.js';

test('detects the mixed scripts in the reported lesson and damaged UTF-8', () => {
  for (const text of ['Moncloa yCwПрезидент …', 'Le felicitamos y nos，表达 nuestra satisfacción.', 'La monarquÃ­a', 'Constituci�n', 'Es una respuesta بالعربية', 'Respuesta שלום']) {
    assert.ok(textQualityIssues(text, 'Historia de España').length, text);
  }
});

test('preserves Spanish, accents, emoji, maths and code', () => {
  for (const text of ['¿Por qué cayó la monarquía? 📚', 'α + β = π; Ω y μ', '\\(\\text{表达}\\) y $$x^2$$', '```js\nconst nombre = "Президент";\n```', '`表达`', 'https://example.com/表达']) {
    assert.deepEqual(textQualityIssues(text), [], text);
  }
});

test('respects scripts and language subjects requested by the student', () => {
  for (const [text, context] of [['你好', 'Enséñame chino'], ['Привет', 'Aprender ruso'], ['こんにちは', 'Japonés básico'], ['مرحبا', 'Curso de árabe'], ['שלום', 'Aprender hebreo'], ['안녕', 'Coreano'], ['नमस्ते', 'Hindi'], ['Привет', 'Что это значит?']]) {
    assert.deepEqual(textQualityIssues(text, context), [], context);
  }
});

test('protected spans keep their order and exact contents', () => {
  assert.deepEqual(protectedTextSpans('Texto `código` con \\(x^2\\) y\n```js\n"你好"\n```'), ['`código`', '\\(x^2\\)', '```js\n"你好"\n```']);
});
