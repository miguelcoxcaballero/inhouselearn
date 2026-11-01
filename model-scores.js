/* The intelligence number of the models in the picker. No DOM, no network.

   OpenRouter publishes Artificial Analysis' intelligence index for only some of its
   models: for many it gives the coding and agentic indices and a null intelligence
   (and for some, nothing at all); and a Claude model used with the user's own API key
   is built by the app, with no scores. So rows that used to show their speedometer
   and number stopped showing them. This brings the number back, honestly:

   · withTwinScores: the Claude copy takes the scores of its OpenRouter twin (the same
     model, listed there as «anthropic/claude-x-y.z»): exact, not an estimate.
   · estimate: a model with coding and/or agentic but no intelligence gets an estimate
     (marked iqEstimated, drawn with «~»), fitted by least squares on the models that
     do have all of them, so it follows whatever OpenRouter publishes. A fit is only
     used with enough models and a good enough R²; a model with none of the three
     scores shows no speedometer (nothing is invented for it). */
(function (root) {
  'use strict';
  const MIN_SAMPLES = 10;
  const MIN_R2 = 0.5;
  // Both indices only replace the single agentic one when they clearly explain more: the
  // two are highly correlated, and a fit on both can be unstable for a model off their line.
  const BOTH_GAIN = 0.03;
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  // The predictors a fit can use.
  const PREDICTORS = [['agentic', 'coding'], ['agentic'], ['coding']];

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
    return { keys, coef, r2: total > 0 ? 1 - residual / total : 0, n: rows.length };
  }

  // The fits this list supports, by predictors («agentic+coding», «agentic», «coding»).
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

  // The fit to use for one model, from what scores it has: both indices when they clearly
  // help, else agentic (the better predictor), else coding.
  function choose(entry, models) {
    const hasAgentic = isNum(entry.agentic);
    const hasCoding = isNum(entry.coding);
    const both = models['agentic+coding'];
    const agentic = models.agentic;
    const coding = models.coding;
    if (hasAgentic && hasCoding && both && (!agentic || both.r2 >= agentic.r2 + BOTH_GAIN)) return both;
    if (hasAgentic && agentic) return agentic;
    if (hasCoding && coding) return coding;
    if (hasAgentic && hasCoding && both) return both;
    return null;
  }

  // A new list (the entries are never changed: the OpenRouter one is cached as it came)
  // where every model without an intelligence number but with coding and/or agentic gets
  // an estimate.
  function estimate(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const models = fits(list);
    return list.map((entry) => {
      if (!entry || isNum(entry.intelligence)) return entry;
      const model = choose(entry, models);
      if (!model) return entry;
      const value = model.coef[0] + model.keys.reduce((sum, key, i) => sum + model.coef[i + 1] * entry[key], 0);
      return Object.assign({}, entry, { intelligence: Math.max(1, Math.min(100, Math.round(value * 10) / 10)), iqEstimated: true });
    });
  }

  // A Claude model of the user's own key has no scores of its own: it takes its twin's.
  function withTwinScores(direct, twin) {
    if (!direct || !twin || isNum(direct.intelligence)) return direct;
    return Object.assign({}, direct, {
      intelligence: isNum(twin.intelligence) ? twin.intelligence : null,
      coding: isNum(twin.coding) ? twin.coding : null,
      agentic: isNum(twin.agentic) ? twin.agentic : null
    });
  }

  const api = { estimate, withTwinScores, fits, fit, MIN_SAMPLES, MIN_R2 };
  root.ModelScores = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
