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

// ── Design Arena (the other benchmark OpenRouter publishes), one model listed twice, the guarantee ──
// 14 models where intelligence ≈ 4.5 + 0.14 · (Design Arena's mean Elo − 1050): Elo 1050 … 1310.
const withArena = Array.from({ length: 14 }, (_, i) => {
  const agentic = 5 + i * 4;
  return { id: 'co/arena-' + i, arena: 1050 + i * 20, agentic, coding: Math.round(agentic * 0.9 + 30), intelligence: Math.round((0.7 * agentic + 1 + ((i * 7) % 3 - 1) * 0.2) * 10) / 10 };
});

test('a model with only Design Arena gets an estimate, marked with its basis and its typical error', () => {
  const out = ModelScores.estimate(withArena.concat([{ id: 'co/new', intelligence: null, agentic: null, coding: null, arena: 1150 }]));
  const got = out[out.length - 1];
  assert.equal(got.iqEstimated, true);
  assert.equal(got.iqBasis, 'arena');
  assert.ok(Math.abs(got.intelligence - 18.5) < 1.5, 'about 18.5: ' + got.intelligence);
  assert.ok(got.iqError >= 0 && got.iqError < 3, 'typical error: ' + got.iqError);
  // Artificial Analysis' own indices win when the model has them too.
  const both = ModelScores.estimate(withArena.concat([{ id: 'co/both', intelligence: null, agentic: 40, coding: 66, arena: 1150 }])).pop();
  assert.ok(both.iqEstimated && both.iqBasis !== 'arena', 'Artificial Analysis first: ' + both.iqBasis);
});

test('a line is never extended beyond its data: outside the range there is no number', () => {
  const far = ModelScores.estimate(withArena.concat([
    { id: 'co/low', intelligence: null, agentic: null, coding: null, arena: 600 },
    { id: 'co/high', intelligence: null, agentic: null, coding: null, arena: 1900 },
    { id: 'co/edge', intelligence: null, agentic: null, coding: null, arena: 1330 },
    { id: 'co/agentic-far', intelligence: null, agentic: 400, coding: null, arena: null }
  ])).slice(-4);
  assert.equal(far[0].intelligence, null);
  assert.equal(far[1].intelligence, null);
  assert.equal(far[3].intelligence, null);
  assert.equal(far[2].iqEstimated, true, 'a little beyond the data is inside the margin');
});

test('one model listed twice shares what one of its entries has (exact numbers, never an estimate)', () => {
  const list = [
    { id: 'co/x', canonical: 'co/x-20260101', intelligence: 41.5, coding: 50, agentic: 30, arena: null },
    { id: 'co/x:free', canonical: 'co/x-20260101', intelligence: null, coding: null, agentic: null, arena: null },
    { id: 'co/y', canonical: 'co/y-1', intelligence: null, coding: 60, agentic: null, arena: null },
    { id: 'co/y:free', canonical: 'co/y-1', intelligence: null, coding: null, agentic: null, arena: 1200 },
    { id: 'co/z', canonical: '', intelligence: null },
    { id: 'co/w', intelligence: 10 }
  ];
  const snapshot = JSON.stringify(list);
  const out = ModelScores.withSameModelScores(list);
  assert.equal(JSON.stringify(list), snapshot, 'input untouched');
  assert.equal(out[1].intelligence, 41.5);
  assert.equal(out[1].coding, 50);
  assert.equal(out[1].iqEstimated, undefined);
  assert.equal(out[3].coding, 60, 'the poorer entry takes what the richer one has…');
  assert.equal(out[3].arena, 1200, '…and keeps what it had');
  assert.equal(out[3].intelligence, null, 'an estimate-only group gives no intelligence');
  assert.equal(out[0], list[0]);
  assert.equal(out[4], list[4], 'no canonical slug: left alone');
  assert.equal(out[5], list[5]);
});

test('a DeepSeek-shaped list: each model OpenRouter says something about gets a number, the one with nothing gets none', () => {
  const deepseek = [
    { id: 'deepseek/deepseek-v4.1-flash-1017', intelligence: null, coding: null, agentic: null, arena: 1283 },
    { id: 'deepseek/deepseek-v4.1-flash', intelligence: null, coding: null, agentic: null, arena: null },
    { id: 'deepseek/deepseek-v4-pro-0813', intelligence: 23.1, coding: 68.8, agentic: 41.3, arena: null },
    { id: 'deepseek/deepseek-v4-flash-0731', intelligence: null, coding: 69.1, agentic: 41, arena: 1205 },
    { id: 'deepseek/deepseek-v3.2', intelligence: null, coding: 44.2, agentic: null, arena: 1130 },
    { id: 'deepseek/deepseek-chat-v3.1', intelligence: null, coding: null, agentic: null, arena: 1076 },
    { id: 'deepseek/deepseek-r1-0528', intelligence: null, coding: null, agentic: null, arena: 1115 }
  ];
  const out = ModelScores.estimate(withArena.concat(deepseek));
  const byId = Object.fromEntries(out.map((entry) => [entry.id, entry]));
  assert.equal(byId['deepseek/deepseek-v4-pro-0813'].intelligence, 23.1, 'its own number stays');
  assert.equal(byId['deepseek/deepseek-v4-pro-0813'].iqEstimated, undefined);
  ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v3.2', 'deepseek/deepseek-chat-v3.1', 'deepseek/deepseek-r1-0528'].forEach((id) => {
    assert.equal(typeof byId[id].intelligence, 'number', id + ' has a number');
    assert.equal(byId[id].iqEstimated, true, id + ' is marked as an estimate');
  });
  assert.equal(byId['deepseek/deepseek-v4.1-flash'].intelligence, null, 'no benchmark at all: no number, nothing invented');
  assert.deepEqual(ModelScores.summary(out.slice(-7)), { exact: 1, estimated: 5, none: 1 });
});

test('guarantee: with any benchmark inside the range of the data a model gets a number; with none it gets none', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const crowd = [];
  for (let i = 0; i < 120; i++) {
    const t = rand();
    crowd.push({ id: 'co/c' + i, intelligence: null, agentic: rand() < 0.5 ? 5 + t * 52 : null, coding: rand() < 0.5 ? 35 + t * 46 : null, arena: rand() < 0.6 ? 1050 + t * 260 : null });
  }
  const out = ModelScores.estimate(withArena.concat(crowd)).slice(withArena.length);
  let withData = 0;
  out.forEach((entry) => {
    if ([entry.agentic, entry.coding, entry.arena].some((value) => value != null)) {
      withData++;
      assert.equal(typeof entry.intelligence, 'number', entry.id + ' has a benchmark but no number');
      assert.equal(entry.iqEstimated, true);
    } else assert.equal(entry.intelligence, null, entry.id + ' has no benchmark, so no number');
  });
  assert.ok(withData > 80, 'the crowd really exercised the fits: ' + withData);
});
