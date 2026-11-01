// The intelligence number of the model picker (model-scores.js), without a browser:
// the Claude copy takes its twin's scores, and a model with only coding/agentic gets
// an estimate fitted on the models that have them (never invented from nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import ModelScores from '../../model-scores.js';

// A list where intelligence = 0.7 · agentic + 1 (+ a little noise) and coding follows agentic.
const model = (id, agentic, extra) => Object.assign({ id, intelligence: Math.round((0.7 * agentic + 1 + ((agentic * 7) % 3 - 1) * 0.2) * 10) / 10, agentic, coding: Math.round(agentic * 0.9 + 30) }, extra);
const base = Array.from({ length: 14 }, (_, i) => model('co/model-' + i, 5 + i * 4));

test('a model without intelligence but with agentic/coding gets a marked estimate on the same scale', () => {
  const target = { id: 'co/new', intelligence: null, agentic: 40, coding: 66 };
  const out = ModelScores.estimate(base.concat([target]));
  const got = out[out.length - 1];
  assert.equal(got.iqEstimated, true);
  assert.ok(Math.abs(got.intelligence - (0.7 * 40 + 1)) < 1.5, 'about 29: ' + got.intelligence);
  // Only agentic, only coding: the single-predictor fits.
  const onlyAgentic = ModelScores.estimate(base.concat([{ id: 'co/a', intelligence: null, agentic: 20, coding: null }])).pop();
  assert.ok(onlyAgentic.iqEstimated && Math.abs(onlyAgentic.intelligence - 15) < 1.5, 'agentic only: ' + onlyAgentic.intelligence);
  const onlyCoding = ModelScores.estimate(base.concat([{ id: 'co/c', intelligence: null, agentic: null, coding: 66 }])).pop();
  assert.ok(onlyCoding.iqEstimated && onlyCoding.intelligence > 20 && onlyCoding.intelligence < 40, 'coding only: ' + onlyCoding.intelligence);
});

test('real numbers are never touched, nothing is invented, and the entries are not mutated', () => {
  const nothing = { id: 'co/none', intelligence: null, agentic: null, coding: null };
  const real = { id: 'co/real', intelligence: 33.3, agentic: 5, coding: 5 };
  const input = base.concat([nothing, real]);
  const snapshot = JSON.stringify(input);
  const out = ModelScores.estimate(input);
  assert.equal(JSON.stringify(input), snapshot, 'input untouched');
  assert.equal(out[out.length - 2], nothing, 'no scores at all: the same entry, no number');
  assert.equal(out[out.length - 1].intelligence, 33.3);
  assert.equal(out[out.length - 1].iqEstimated, undefined);
  // An estimate is not used as data for another one.
  const again = ModelScores.estimate(out);
  assert.equal(again[again.length - 2].intelligence, null);
});

test('too few models, or scores that do not follow each other, give no estimate', () => {
  const few = base.slice(0, 5).concat([{ id: 'co/new', intelligence: null, agentic: 40, coding: 66 }]);
  assert.equal(ModelScores.estimate(few).pop().intelligence, null);
  const noise = Array.from({ length: 14 }, (_, i) => ({ id: 'co/n' + i, intelligence: (i * 37) % 50, agentic: (i * 11) % 7 * 9, coding: (i * 5) % 9 * 8 }));
  const out = ModelScores.estimate(noise.concat([{ id: 'co/new', intelligence: null, agentic: 40, coding: 66 }]));
  assert.equal(out[out.length - 1].iqEstimated, undefined);
  assert.equal(ModelScores.estimate(undefined).length, 0);
});

test('a Claude copy takes the scores of its OpenRouter twin', () => {
  const twin = { id: 'anthropic/claude-opus-5.5', intelligence: 58.4, coding: null, agentic: null };
  const direct = { id: 'claude-api/claude-opus-5-5', intelligence: null, coding: null, agentic: null };
  const merged = ModelScores.withTwinScores(direct, twin);
  assert.equal(merged.intelligence, 58.4);
  assert.equal(merged.id, 'claude-api/claude-opus-5-5');
  assert.equal(direct.intelligence, null, 'not mutated');
  assert.equal(ModelScores.withTwinScores(direct, undefined), direct, 'no twin: unchanged');
  const own = { id: 'x', intelligence: 40 };
  assert.equal(ModelScores.withTwinScores(own, twin), own, 'its own number is kept');
  // A twin with only coding/agentic: the copy then gets an estimate like any other model.
  const sonnet = ModelScores.withTwinScores({ id: 'claude-api/claude-sonnet-5', intelligence: null }, { id: 'anthropic/claude-sonnet-5', intelligence: null, coding: 71.5, agentic: 43.6 });
  const list = ModelScores.estimate(base.concat([sonnet]));
  assert.equal(list[list.length - 1].iqEstimated, true);
});
