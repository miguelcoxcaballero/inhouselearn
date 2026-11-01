/* The intelligence number of the models in the picker. No DOM, no network.

   Everything here comes from what OpenRouter itself publishes in its model list and is worked
   out when the list arrives, so a model OpenRouter adds (or later completes) is covered with no
   change to the app: nothing is looked up by hand and nothing is invented.

   · exact: Artificial Analysis' intelligence index, as OpenRouter gives it.
   · same model: a Claude model of the user's own key takes its OpenRouter twin's scores
     (withTwinScores), and two list entries of one model (the same canonical slug, e.g. a
     «:free» copy) share the scores one of them has (withSameModelScores). Exact, not estimates.
   · estimate (marked iqEstimated, drawn with «~», with iqBasis and iqError): a model OpenRouter
     gives no index for but other benchmarks: Artificial Analysis' coding and agentic indices and,
     failing those, Design Arena's Elo (the other benchmark OpenRouter publishes). Least squares on
     the models that do have the index; a fit needs enough models and a good R², and a model whose
     value falls outside the range the fit was made on gets nothing (a line is never extended
     beyond its data).
   · none: a model with no benchmark at all gets no number (the picker says so). */
(function (root) {
  'use strict';
  const MIN_SAMPLES = 10;
  const MIN_R2 = 0.5;
  // Both indices only replace the single agentic one when they clearly explain more: the
  // two are highly correlated, and a fit on both can be unstable for a model off their line.
  const BOTH_GAIN = 0.03;
  // How far beyond its data a fit may be used, as a share of the range it was made on.
  const RANGE_MARGIN = 0.15;
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  // The predictors a fit can use: Artificial Analysis' indices first, then Design Arena's Elo.
  const PREDICTORS = [['agentic', 'coding'], ['agentic'], ['coding'], ['arena']];

  // Least squares: intelligence ≈ c + Σ a_i · x_i (normal equations, Gauss with pivoting).
  function fit(rows, keys) {
    const k = keys.length + 1;
    const A = Array.from({ length: k }, () => new Array(k).fill(0));
    const B = new Array(k).fill(0);
    rows.forEach((row) => {
      const v = [1].concat(keys.map((key) => row[key]));
      for (let i = 0; i < k; i++) {
        B[i] += v[i] * row.intelligence;
        for (let j = 0; j < k; j++) A[i][j] += v[i] * v[j];
      }
    });
    for (let i = 0; i < k; i++) {
      let pivot = i;
      for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r;
      if (Math.abs(A[pivot][i]) < 1e-9) return null;
      [A[i], A[pivot]] = [A[pivot], A[i]];
      [B[i], B[pivot]] = [B[pivot], B[i]];
      for (let r = i + 1; r < k; r++) {
        const factor = A[r][i] / A[i][i];
        for (let c = i; c < k; c++) A[r][c] -= factor * A[i][c];
        B[r] -= factor * B[i];
      }
    }
    const coef = new Array(k).fill(0);
    for (let i = k - 1; i >= 0; i--) {
      let sum = B[i];
      for (let j = i + 1; j < k; j++) sum -= A[i][j] * coef[j];
      coef[i] = sum / A[i][i];
    }
    const mean = rows.reduce((sum, row) => sum + row.intelligence, 0) / rows.length;
    let residual = 0;
    let total = 0;
    rows.forEach((row) => {
      const predicted = coef[0] + keys.reduce((sum, key, i) => sum + coef[i + 1] * row[key], 0);
      residual += (row.intelligence - predicted) ** 2;
      total += (row.intelligence - mean) ** 2;
    });
    // The range of each predictor in the data: the fit is only trusted inside it.
    const ranges = keys.map((key) => {
      const values = rows.map((row) => row[key]);
      return [Math.min.apply(null, values), Math.max.apply(null, values)];
    });
    return { keys, coef, r2: total > 0 ? 1 - residual / total : 0, n: rows.length, rmse: Math.sqrt(residual / rows.length), ranges };
  }

  // The fits this list supports, by predictors («agentic+coding», «agentic», «coding», «arena»).
  function fits(entries) {
    const real = entries.filter((entry) => entry && isNum(entry.intelligence) && !entry.iqEstimated);
    const out = {};
    PREDICTORS.forEach((keys) => {
      const rows = real.filter((entry) => keys.every((key) => isNum(entry[key])));
      if (rows.length < MIN_SAMPLES) return;
      const found = fit(rows, keys);
      if (found && found.r2 >= MIN_R2) out[keys.join('+')] = found;
    });
    return out;
  }

  // The fits that can serve one model, best first, from the scores it has: both Artificial Analysis
  // indices when they clearly help, else agentic (the better predictor), else coding, and only
  // then Design Arena.
  function candidates(entry, models) {
    const has = (key) => isNum(entry[key]);
    const both = models['agentic+coding'];
    const agentic = models.agentic;
    const coding = models.coding;
    const arena = models.arena;
    const out = [];
    if (has('agentic') && has('coding') && both && (!agentic || both.r2 >= agentic.r2 + BOTH_GAIN)) out.push(both);
    if (has('agentic') && agentic) out.push(agentic);
    if (has('coding') && coding) out.push(coding);
    if (has('agentic') && has('coding') && both) out.push(both);
    if (has('arena') && arena) out.push(arena);
    return out;
  }

  // A model inside the range its fit was made on (plus a margin): never an extrapolation.
  function inRange(model, entry) {
    return model.keys.every((key, i) => {
      const low = model.ranges[i][0];
      const high = model.ranges[i][1];
      const margin = (high - low) * RANGE_MARGIN;
      return entry[key] >= low - margin && entry[key] <= high + margin;
    });
  }

  // A new list (the entries are never changed: the OpenRouter one is cached as it came) where
  // every model without an intelligence number but with other benchmarks gets an estimate.
  function estimate(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const models = fits(list);
    return list.map((entry) => {
      if (!entry || isNum(entry.intelligence)) return entry;
      const model = candidates(entry, models).find((candidate) => inRange(candidate, entry));
      if (!model) return entry;
      const value = model.coef[0] + model.keys.reduce((sum, key, i) => sum + model.coef[i + 1] * entry[key], 0);
      return Object.assign({}, entry, {
        intelligence: Math.max(1, Math.min(100, Math.round(value * 10) / 10)),
        iqEstimated: true,
        iqBasis: model.keys.join('+'),
        iqError: Math.round(model.rmse * 10) / 10
      });
    });
  }

  // A Claude model of the user's own key has no scores of its own: it takes its twin's.
  function withTwinScores(direct, twin) {
    if (!direct || !twin || isNum(direct.intelligence)) return direct;
    return Object.assign({}, direct, {
      intelligence: isNum(twin.intelligence) ? twin.intelligence : null,
      coding: isNum(twin.coding) ? twin.coding : null,
      agentic: isNum(twin.agentic) ? twin.agentic : null,
      arena: isNum(twin.arena) ? twin.arena : null
    });
  }

  // Entries that are one model listed twice (the same canonical slug) share what one has: the
  // richest of the group gives its numbers to the others where they have none.
  const richness = (entry) => (isNum(entry.intelligence) && !entry.iqEstimated ? 8 : 0) + (isNum(entry.agentic) ? 4 : 0) + (isNum(entry.coding) ? 2 : 0) + (isNum(entry.arena) ? 1 : 0);
  function withSameModelScores(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const best = new Map();
    list.forEach((entry) => {
      if (!entry || !entry.canonical) return;
      const known = best.get(entry.canonical);
      if (!known || richness(entry) > richness(known)) best.set(entry.canonical, entry);
    });
    return list.map((entry) => {
      const donor = entry && entry.canonical ? best.get(entry.canonical) : null;
      if (!donor || donor === entry) return entry;
      const gaps = {};
      ['intelligence', 'coding', 'agentic', 'arena'].forEach((key) => {
        if (!isNum(entry[key]) && isNum(donor[key]) && !(key === 'intelligence' && donor.iqEstimated)) gaps[key] = donor[key];
      });
      return Object.keys(gaps).length ? Object.assign({}, entry, gaps) : entry;
    });
  }

  // How a list stands: with its real number, with an estimate, with nothing.
  function summary(entries) {
    const out = { exact: 0, estimated: 0, none: 0 };
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      if (!entry) return;
      if (!isNum(entry.intelligence)) out.none++;
      else if (entry.iqEstimated) out.estimated++;
      else out.exact++;
    });
    return out;
  }

  const api = { estimate, withTwinScores, withSameModelScores, summary, fits, fit, MIN_SAMPLES, MIN_R2 };
  root.ModelScores = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
