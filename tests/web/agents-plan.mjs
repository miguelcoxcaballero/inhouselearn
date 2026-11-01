// spawn_agents v3 (engine/src/agents.js and engine/src/agents/*) without a browser
// or a model: the plan (ids, dependencies, cycles, waves, lint, the gate), the
// effort per role, the scheduler with a fake runSubAgent (concurrency cap and its
// adaptive limit, dependency results in the downstream task, skips on failure, the
// budget and not starting what cannot finish, the verifier and its rounds of fixes,
// the trimmed digest with agent_report, the cap of the whole answer) and a parent
// abort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// CI runs these without engine/node_modules: agents.js only needs pi-ai's
// Type to describe its parameters, so a stub stands in when it is missing.
let agents;
try {
  agents = await import('../../engine/src/agents.js');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  const stub = 'const f = (...a) => ({ a }); export const Type = new Proxy({}, { get: () => f });';
  const hooks = 'export async function resolve(specifier, context, next) {' +
    ' if (specifier === "@earendil-works/pi-ai") return { url: "data:text/javascript," + encodeURIComponent(' + JSON.stringify(stub) + '), shortCircuit: true };' +
    ' return next(specifier, context); }';
  register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);
  agents = await import('../../engine/src/agents.js?stub');
}
const { planAgents, createAgentTools, createSubAgentReportTool, pickLevel } = agents;
// The decision rules are pure modules of their own.
const policy = await import('../../engine/src/agents/policy.js');
const { partialSummary } = await import('../../engine/src/agents/run.js');

const LONG = ' Lee los archivos que hagan falta, haz el cambio completo con cuidado y devuelve qué archivos cambiaste y cómo lo comprobaste.';
const agent = (name, extra) => Object.assign({ name, task: 'Tarea de ' + name + '.' + LONG }, extra);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TIMING = { stagger: 5, backoff: 5, grace: 50 };

function spawnTool(runSubAgent, extra) {
  return createAgentTools(Object.assign({ runSubAgent, timing: TIMING }, extra)).find((tool) => tool.name === 'spawn_agents');
}
const textOf = (result) => result.content[0].text;

test('plan: unknown dependency and cycles are refused with a clear message', () => {
  assert.throws(() => planAgents([agent('A', { id: 'a', depends_on: ['x'] })]), /depends_on «x» no existe/);
  assert.throws(() => planAgents([agent('A', { id: 'a', depends_on: ['b'] }), agent('B', { id: 'b', depends_on: ['a'] })]), /Hay un ciclo: a → b → a/);
  assert.throws(() => planAgents([agent('A', { id: 'a', depends_on: ['a'] })]), /Hay un ciclo: a → a/);
});

test('plan: automatic ids, waves by longest path, lint warnings', () => {
  const plan = planAgents([
    agent('Base', { id: 'base' }),
    agent('Base'),
    agent('Dup', { id: 'base' }),
    agent('Mid', { id: 'mid', depends_on: ['base'] }),
    agent('Top', { id: 'top', depends_on: ['mid', 'base'] })
  ]);
  const ids = plan.nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.equal(ids[0], 'base');
  assert.ok(ids[1] && ids[1] !== 'base' && ids[2] !== 'base');
  assert.deepEqual(plan.nodes.map((node) => node.wave), [1, 1, 1, 2, 3]);
  assert.equal(plan.waves, 3);

  const lint = planAgents([
    { name: 'Corto', task: 'Arregla lo de antes.' },
    agent('Uno', { task: 'Cambia src/app.js para que salude en inglés.' + LONG }),
    agent('Dos', { task: 'Añade un test y toca también src/app.js para exportar saludo.' + LONG }),
    agent('Tres', { depends_on: ['uno', 'dos'], task: 'Revisa src/app.js cuando Uno termine.' + LONG })
  ]);
  const all = lint.warnings.join('\n');
  assert.match(all, /«Corto» es muy corta/);
  assert.match(all, /«Corto» menciona «antes»/);
  assert.match(all, /«Uno» y «Dos» nombran los dos src\/app\.js/);
  assert.doesNotMatch(all, /«Tres»/, 'a dependant naming the same file is fine');
});

test('the tools: spawn_agents and agent_report', () => {
  assert.deepEqual(createAgentTools({ runSubAgent() {} }).map((tool) => tool.name), ['spawn_agents', 'agent_report']);
});

test('effort: explore reads at medium and 25 steps, build writes at high and 40; the model can override', () => {
  const plan = planAgents([
    agent('Lector', { id: 'r', role: 'explore' }),
    agent('Autor', { id: 'w' }),
    agent('Profundo', { id: 'p', role: 'explore', effort: 'max' }),
    agent('Raro', { id: 'x', effort: 'ultra' })
  ]);
  const by = Object.fromEntries(plan.nodes.map((node) => [node.id, node]));
  assert.deepEqual([by.r.effort, by.r.maxSteps], ['medium', 25]);
  assert.deepEqual([by.w.effort, by.w.maxSteps], ['high', 40]);
  assert.equal(by.p.effort, 'max');
  assert.equal(by.x.effort, 'high', 'an unknown effort falls back to the role\'s');
  const ladder = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  assert.equal(pickLevel(ladder, 'explore'), 'medium');
  assert.equal(pickLevel(ladder, 'build'), 'high');
  assert.equal(pickLevel(ladder, 'build', 'max'), 'xhigh');
  assert.equal(pickLevel(ladder, 'explore', 'low'), 'low');
  assert.equal(pickLevel(['off', 'low', 'medium', 'high'], 'build'), 'high');
  assert.equal(pickLevel([], 'build'), '', 'a model that does not reason has no level');
});

test('jobs and rows carry the effort and the step cap of the role', async () => {
  const jobs = {};
  const tool = spawnTool(async (job) => { jobs[job.id] = job; return { text: 'ok', cost: 0 }; });
  const result = await tool.execute('e1', { verify: false, agents: [agent('Lector', { id: 'r', role: 'explore' }), agent('Autor', { id: 'w', effort: 'max' })] });
  assert.deepEqual([jobs.r.effort, jobs.r.maxSteps], ['medium', 25]);
  assert.deepEqual([jobs.w.effort, jobs.w.maxSteps], ['max', 40]);
  const rows = Object.fromEntries(result.details.agents.map((row) => [row.id, row]));
  assert.deepEqual([rows.r.effort, rows.r.maxSteps, rows.w.effort, rows.w.maxSteps], ['medium', 25, 'max', 40]);
});

test('policy: rounds, parallel limit, start verdict, verifier, failing key', () => {
  assert.equal(policy.fixRoundsFrom(undefined), 1);
  assert.equal(policy.fixRoundsFrom(0), 0);
  assert.equal(policy.fixRoundsFrom(9), 3);
  assert.equal(policy.fixRoundsFrom(-2), 0);
  assert.equal(policy.fixRoundsFrom('2'), 2);
  let state = { limit: 6, calm: 0, max: 6 };
  state = policy.nextParallel(state, 'limit');
  assert.equal(state.limit, 3);
  state = policy.nextParallel(state, 'limit');
  assert.equal(state.limit, 2);
  state = policy.nextParallel(state, 'limit');
  assert.equal(state.limit, 2, 'never below two');
  state = policy.nextParallel(state, 'ok');
  assert.equal(state.limit, 2);
  state = policy.nextParallel(state, 'ok');
  assert.equal(state.limit, 3, 'two calm finishes give one back');
  assert.deepEqual(policy.startVerdict({ spent: 0.3, budget: 1, finishedCosts: [] }), { ok: true });
  assert.equal(policy.startVerdict({ spent: 0.95, budget: 1, finishedCosts: [] }).near, true);
  assert.equal(policy.startVerdict({ spent: 0.9, budget: 1, finishedCosts: [0.45, 0.45] }).ok, false);
  assert.equal(policy.startVerdict({ spent: 1.2, budget: 1, finishedCosts: [] }).ok, false);
  assert.equal(policy.shouldVerify([{ role: 'explore' }, { role: 'explore' }], []), false);
  assert.equal(policy.shouldVerify([{ role: 'explore' }, { role: 'build' }], []), true);
  assert.equal(policy.failingKey([{ criterion: 'b', ok: false }, { criterion: 'a', ok: false }, { criterion: 'c', ok: true }]), 'a|b');
});

test('a plan that cannot work is refused once, before anything starts; then it runs', async () => {
  let started = 0;
  const tool = spawnTool(async () => { started++; return { text: 'hecho', cost: 0 }; });
  const bad = { verify: false, agents: [{ name: 'Corto', task: 'Arregla eso.' }, agent('Otro', { task: 'Mira lo de arriba y sigue con ello sin más dudas.' + LONG })] };
  const first = await tool.execute('g1', bad);
  assert.equal(started, 0, 'nobody started');
  assert.equal(first.details.refused, true);
  assert.match(textOf(first), /^Plan NO ejecutado: no ha empezado ningún agente y no se ha gastado nada/);
  assert.match(textOf(first), /«Corto» tiene \d+ caracteres y no hay context/);
  assert.match(textOf(first), /«Otro» dice «arriba»/);
  const second = await tool.execute('g2', bad);
  assert.equal(started, 2, 'the same plan goes through the second time');
  assert.equal(second.details.agents.length, 2);
  // With a shared context a short task is fine, and «antes» alone is just a word.
  const withContext = await spawnTool(async () => ({ text: 'ok', cost: 0 })).execute('g3', { verify: false, context: 'Repositorio demo, rama main.', agents: [{ name: 'Corto', task: 'Lee README.md antes de nada.' }] });
  assert.equal(withContext.details.refused, undefined);
  assert.equal(withContext.details.agents.length, 1);
  const word = await spawnTool(async () => ({ text: 'ok', cost: 0 })).execute('g4', { verify: false, agents: [agent('Largo', { task: 'Antes de empezar, lee con calma los apuntes del tema y resume lo importante para repasarlos.' + LONG })] });
  assert.equal(word.details.refused, undefined);
});

test('the verifier runs when something is written, with criteria or with 3+ agents; two readers do not need one', async () => {
  const run = (list, extra) => spawnTool(async () => ({ text: 'ok', cost: 0 })).execute('v', Object.assign({ agents: list }, extra));
  const has = (result) => result.details.agents.some((row) => row.id === 'verify');
  assert.equal(has(await run([agent('A', { role: 'explore' }), agent('B', { role: 'explore' })])), false, 'two readers');
  assert.equal(has(await run([agent('A'), agent('B', { role: 'explore' })])), true, 'one writes');
  assert.equal(has(await run([agent('A', { role: 'explore' }), agent('B', { role: 'explore' }), agent('C', { role: 'explore' })])), true, 'three agents');
  assert.equal(has(await run([agent('A', { role: 'explore' })], { acceptance: ['Algo comprobable'] })), true, 'criteria');
  assert.equal(has(await run([agent('A')])), false, 'a single writer');
  assert.equal(has(await run([agent('A'), agent('B')], { verify: false })), false, 'verify:false');
});

test('scheduler: at most 6 at a time out of 8, everything done', async () => {
  let running = 0;
  let peak = 0;
  const starts = [];
  const tool = spawnTool(async (job) => {
    running++; peak = Math.max(peak, running); starts.push(Date.now());
    job.onUpdate({ doing: 'Leyendo', cost: 0.001, steps: 1 });
    await sleep(60);
    running--;
    return { text: 'Hecho por ' + job.name, cost: 0.002 };
  });
  const updates = [];
  const result = await tool.execute('s1', { verify: false, agents: Array.from({ length: 8 }, (_, i) => agent('Agente ' + (i + 1))) }, undefined, (u) => updates.push(u));
  assert.equal(peak, 6);
  assert.ok(starts.every((t, i) => !i || t - starts[i - 1] >= 4), 'starts are staggered');
  assert.equal(result.details.agents.length, 8);
  assert.ok(result.details.agents.every((row) => row.status === 'done' && row.startedAt && row.endedAt >= row.startedAt));
  assert.ok(updates.some((u) => u.details.agents.some((row) => row.status === 'queued' && row.doing === 'En cola')));
  assert.match(textOf(result), /\(8 agentes en 1 oleada: 8 ok, 0 fallidos, 0 sin empezar, \$0\.0160\)/);
  assert.match(textOf(result), /## Agente 1 \[done\]\nHecho por Agente 1/);
  assert.match(textOf(result), /Gasto de Ultra code en esta respuesta: \$0\.0160 de \$8\.00\./);
});

test('a provider that limits requests halves how many agents start at once', async () => {
  let running = 0;
  let limited = false;
  let violations = 0;
  const tries = {};
  const tool = spawnTool(async (job) => {
    tries[job.id] = (tries[job.id] || 0) + 1;
    // After the first 429 no NEW agent may start while three are already running
    // (a retry of the same agent is not a new start).
    if (limited && tries[job.id] === 1 && running >= 3) violations++;
    running++;
    try {
      await sleep(20);
      if (job.id === 'a1' && tries[job.id] === 1) { limited = true; throw new Error('OpenRouter 429: rate limit'); }
      return { text: 'ok', cost: 0 };
    } finally {
      running--;
    }
    // calm: 99 keeps the pool from growing back while the test measures the slowed one.
  }, { timing: Object.assign({}, TIMING, { calm: 99 }) });
  const updates = [];
  const result = await tool.execute('p1', { verify: false, agents: Array.from({ length: 9 }, (_, i) => agent('Agente ' + (i + 1), { id: 'a' + (i + 1) })) }, undefined, (u) => updates.push(u));
  assert.ok(result.details.agents.every((row) => row.status === 'done'), JSON.stringify(result.details.agents.map((row) => [row.id, row.status])));
  assert.equal(violations, 0);
  assert.ok(updates.some((u) => u.details.notice && /limita las peticiones: ahora van 3 agentes a la vez/.test(u.details.notice)), 'the board was told while it lasted');
  assert.equal(result.details.notice, undefined, 'and the finished card carries no stale notice');
  assert.equal(tries.a1, 2);
});

test('scheduler: dependency results reach the downstream task; a failure skips dependants', async () => {
  const tasks = {};
  const tool = spawnTool(async (job) => {
    tasks[job.id] = job.task;
    if (job.id === 'roto') throw new Error('El modelo devolvió algo raro');
    return { text: 'Resultado de ' + job.name + ': la API vive en api/index.js', cost: 0.01 };
  });
  const updates = [];
  const result = await tool.execute('s2', {
    context: 'Repositorio tester/demo, rama feat/x.',
    verify: false,
    agents: [
      agent('Investigar', { id: 'inv', role: 'explore', returns: 'la lista de rutas' }),
      agent('Roto', { id: 'roto' }),
      agent('Construir', { id: 'build', depends_on: ['inv'] }),
      agent('Después', { id: 'after', depends_on: ['roto'] })
    ]
  }, undefined, (u) => updates.push(u));
  assert.match(tasks.inv, /^Contexto común \(lo mismo para todos los agentes\):\nRepositorio tester\/demo/);
  assert.match(tasks.inv, /Devuelve: la lista de rutas/);
  assert.match(tasks.build, /Resultados de los agentes de los que dependes:\n### Investigar \(inv\)\nResultado de Investigar: la API vive en api\/index\.js/);
  assert.match(tasks.build, /\n\nTu tarea:\nTarea de Construir\./);
  assert.ok(updates.some((u) => u.details.agents.find((row) => row.id === 'build' && row.doing === 'En espera de «Investigar»')));
  const rows = Object.fromEntries(result.details.agents.map((row) => [row.id, row]));
  assert.equal(rows.roto.status, 'error');
  assert.equal(rows.after.status, 'skipped');
  assert.equal(rows.after.doing, 'No empieza: falló «Roto»');
  assert.equal(tasks.after, undefined);
  assert.equal(result.details.waves, 2);
  assert.match(textOf(result), /2 ok, 1 fallidos, 1 sin empezar/);
  assert.match(textOf(result), /Siguiente paso sugerido: repite solo «Roto», «Después»/);
});

test('scheduler: on_failure stop skips everything not started', async () => {
  const tool = spawnTool(async (job) => {
    if (job.id === 'a') throw new Error('falla');
    await sleep(20);
    return { text: 'ok', cost: 0 };
  });
  const result = await tool.execute('s3', { on_failure: 'stop', verify: false, agents: [agent('A', { id: 'a' }), agent('B', { id: 'b', depends_on: ['c'] }), agent('C', { id: 'c' })] });
  const rows = Object.fromEntries(result.details.agents.map((row) => [row.id, row]));
  assert.equal(rows.b.status, 'skipped');
  assert.match(rows.b.doing, /No empieza: falló/);
});

test('scheduler: the budget stops the most expensive agent and skips the queue', async () => {
  const tool = spawnTool(async (job) => {
    for (let i = 1; i <= 50; i++) {
      if (job.signal.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; error.partialText = 'Llevaba ' + i + ' pasos'; throw error; }
      job.onUpdate({ doing: 'Paso ' + i, cost: (job.id === 'caro' ? 0.03 : 0.005) * i, steps: i });
      await sleep(5);
    }
    return { text: 'fin', cost: 0.1 };
  });
  const result = await tool.execute('s4', {
    budget_usd: 0.2, verify: false,
    agents: [agent('Caro', { id: 'caro' }), agent('Barato', { id: 'barato' }), agent('Luego', { id: 'luego', depends_on: ['barato'] })]
  });
  const rows = Object.fromEntries(result.details.agents.map((row) => [row.id, row]));
  assert.equal(rows.caro.status, 'stopped');
  assert.equal(rows.caro.doing, 'Parado: presupuesto agotado ($0.20)');
  assert.match(rows.caro.result, /Llevaba \d+ pasos/);
  assert.equal(rows.luego.status, 'skipped');
  assert.match(rows.luego.doing, /^No empieza: (presupuesto (casi )?agotado|falló «Barato»)$/, rows.luego.doing);
  assert.equal(result.details.budget, 0.2);
});

test('an agent that the rest of the budget could not finish is not started', async () => {
  const tool = spawnTool(async (job) => { job.onUpdate({ cost: 0.45, steps: 1 }); await sleep(5); return { text: 'ok', cost: 0.45 }; });
  const result = await tool.execute('b1', { verify: false, budget_usd: 1, agents: [
    agent('A', { id: 'a' }), agent('B', { id: 'b', depends_on: ['a'] }), agent('C', { id: 'c', depends_on: ['b'] })
  ] });
  const rows = Object.fromEntries(result.details.agents.map((row) => [row.id, row]));
  assert.equal(rows.a.status, 'done');
  assert.equal(rows.b.status, 'done');
  assert.equal(rows.c.status, 'skipped');
  assert.equal(rows.c.doing, 'No empieza: presupuesto casi agotado');
  assert.match(textOf(result), /1 sin empezar/);
});

test('scheduler: step cap, stop by the user and transient retries', async () => {
  let controls = null;
  let tries = 0;
  const tool = spawnTool(async (job) => {
    if (job.id === 'flaky') {
      tries++;
      if (tries < 3) throw new Error('OpenRouter 429: rate limit');
      return { text: 'por fin', cost: 0.001 };
    }
    if (job.id === 'pasos') {
      for (let i = 1; i <= 45 && !job.signal.aborted; i++) { job.onUpdate({ steps: i }); await sleep(1); }
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    // 'mio' waits until the user stops it.
    await new Promise((resolve) => job.signal.addEventListener('abort', resolve));
    throw Object.assign(new Error('aborted'), { name: 'AbortError', partialText: 'medio hecho' });
  }, { registerControls: (id, c) => { controls = c; }, unregisterControls: () => { controls = 'gone'; } });
  const run = tool.execute('s5', { verify: false, agents: [agent('Flaky', { id: 'flaky' }), agent('Pasos', { id: 'pasos' }), agent('Mío', { id: 'mio' })] });
  await sleep(80);
  assert.equal(typeof controls.stop, 'function');
  controls.stop('mio');
  const result = await run;
  const rows = Object.fromEntries(result.details.agents.map((row) => [row.id, row]));
  assert.equal(rows.flaky.status, 'done');
  assert.equal(tries, 3);
  assert.equal(rows.pasos.status, 'stopped');
  assert.equal(rows.pasos.doing, 'Parado: límite de 40 pasos');
  assert.equal(rows.mio.status, 'stopped');
  assert.equal(rows.mio.doing, 'Parado por ti');
  assert.match(textOf(result), /medio hecho/);
  assert.equal(controls, 'gone');
});

test('scheduler: a reader is cut at its own, lower step cap', async () => {
  const tool = spawnTool(async (job) => {
    for (let i = 1; i <= 40 && !job.signal.aborted; i++) { job.onUpdate({ steps: i }); await sleep(1); }
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  const result = await tool.execute('s5b', { verify: false, agents: [agent('Lector', { id: 'r', role: 'explore' })] });
  assert.equal(result.details.agents[0].doing, 'Parado: límite de 25 pasos');
});

test('max_steps raises or lowers the step cap of one agent (never above 100, never below 5)', () => {
  const task = 'x'.repeat(60);
  const plan = planAgents([
    { name: 'A', task, max_steps: 80 },
    { name: 'B', task, role: 'explore' },
    { name: 'C', task, max_steps: 1000 },
    { name: 'D', task, max_steps: 2 },
    { name: 'E', task, role: 'explore', max_steps: 12 }
  ], { context: 'contexto común' });
  assert.deepEqual(plan.nodes.map((node) => node.maxSteps), [80, 25, 100, 40, 12]);
});

test('an agent stopped before its report still tells what it did: its last steps and the files it touched', () => {
  const said = partialSummary({ doing: 'Parado: límite de 40 pasos', trail: [{ t: 'Leído ultra.css' }, { t: 'Editado ultra.js' }], files: ['ultra.js'] });
  assert.match(said, /Se paró antes de entregar su informe \(Parado: límite de 40 pasos\)/);
  assert.match(said, /Leído ultra\.css · Editado ultra\.js/);
  assert.match(said, /Archivos que tocó: ultra\.js/);
  assert.match(said, /max_steps/);
  assert.equal(partialSummary({ doing: 'Parado', trail: [], files: [] }), '');
  assert.equal(partialSummary(undefined), '');
});

test('scheduler: an agent cut at its step cap hands over what it did instead of coming back empty', async () => {
  const tool = spawnTool(async (job) => {
    job.onWrite('src/a.js', 'edit');
    for (let i = 1; i <= 60 && !job.signal.aborted; i++) { job.onUpdate({ steps: i, trail: [{ t: 'Leído a.js' }, { t: 'Editado src/a.js' }] }); await sleep(1); }
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  const result = await tool.execute('s5c', { verify: false, agents: [agent('Obrero', { id: 'o' })] });
  assert.equal(result.details.agents[0].status, 'stopped');
  assert.match(textOf(result), /Se paró antes de entregar su informe/);
  assert.match(textOf(result), /Editado src\/a\.js/);
  assert.match(textOf(result), /src\/a\.js/);
});

test('scheduler: no retry after the agent wrote something', async () => {
  let tries = 0;
  const tool = spawnTool(async (job) => {
    tries++;
    job.onWrite('a.txt', 'write');
    throw new Error('network error');
  });
  const result = await tool.execute('s6', { verify: false, agents: [agent('Uno')] });
  assert.equal(tries, 1);
  assert.equal(result.details.agents[0].status, 'error');
});

test('touched files: the second agent is warned and the result lists the conflict', async () => {
  const warnings = {};
  const tool = spawnTool(async (job) => {
    await sleep(job.id === 'a' ? 0 : 30);
    warnings[job.id] = job.onWrite('src/app.js', 'edit');
    return { text: 'cambié src/app.js', cost: 0 };
  });
  const result = await tool.execute('s7', { verify: false, agents: [agent('A', { id: 'a' }), agent('B', { id: 'b' })] });
  assert.equal(warnings.a, undefined);
  assert.equal(warnings.b, 'Aviso: «A» ya cambió src/app.js en esta ejecución; vuelve a leerlo con read_file e integra sus cambios en vez de sustituirlos.');
  assert.match(textOf(result), /### Archivos tocados\n⚠ Conflicto posible: src\/app\.js \(A, B\)/);
  assert.deepEqual(result.details.files, [{ path: 'src/app.js', agents: ['A', 'B'], conflict: true }]);
});

test('reports and the verifier with one round of fixes', async () => {
  const seen = [];
  let verifierRuns = 0;
  const tool = spawnTool(async (job) => {
    seen.push({ id: job.id, role: job.role, readOnly: job.readOnly, task: job.task, effort: job.effort });
    if (job.id === 'verify') {
      verifierRuns++;
      const passed = verifierRuns > 1;
      job.onReport({ summary: 'Revisado', status: 'done', data: {
        passed,
        checks: [{ criterion: 'Hay tests', ok: true, evidence: 'tests/a.test.js', owner_id: 'tests' }, { criterion: 'La API responde', ok: passed, evidence: passed ? 'api.js:12' : 'falta la ruta /hola', owner_id: 'api' }],
        fixes: passed ? [] : [{ owner_id: 'api', instruction: 'Añade la ruta /hola.' }]
      } });
      return { text: 'Verificado.', cost: 0.01 };
    }
    job.onReport({ summary: 'Hecho ' + job.name, status: 'done', confidence: 0.8, artifacts: [{ kind: 'file', ref: job.id + '.js' }] });
    return { text: 'texto corto de ' + job.name, cost: 0.01 };
  });
  const result = await tool.execute('s8', {
    goal: 'Una API con tests', acceptance: ['Hay tests', 'La API responde'],
    agents: [agent('API', { id: 'api' }), agent('Tests', { id: 'tests' })]
  });
  const text = textOf(result);
  assert.match(text, /^Verificación: 2\/2 criterios OK\./);
  assert.match(text, /## API \[done, confianza 0\.8\]\nHecho API\nArtefactos:\n- file: api\.js/);
  const verifier = seen.filter((item) => item.id === 'verify');
  assert.equal(verifier.length, 2);
  assert.equal(verifier[0].readOnly, true);
  assert.equal(verifier[0].role, 'verify');
  assert.equal(verifier[0].effort, 'high');
  assert.match(verifier[0].task, /Objetivo: Una API con tests/);
  assert.match(verifier[0].task, /1\. Hay tests\n2\. La API responde/);
  assert.match(verifier[0].task, /### API \(id api, done\)/);
  assert.match(verifier[0].task, /intentar refutar lo hecho/);
  assert.match(verifier[0].task, /submit_result con data/);
  const fix = seen.filter((item) => item.id === 'api');
  assert.equal(fix.length, 2);
  assert.match(fix[1].task, /El verificador encontró: Añade la ruta \/hola\. Corrige solo eso\./);
  assert.equal(result.details.verify.passed, true);
  assert.equal(result.details.verify.checks.length, 2);
  assert.equal(result.details.rounds, 1);
  assert.match(text, /1 ronda de arreglos tras la verificación\./);
  assert.ok(result.details.agents.find((row) => row.id === 'verify'));
});

test('fix rounds: as many as asked, stopping when the same checks keep failing', async () => {
  const run = async (rounds, failing) => {
    const seen = { verify: 0, api: 0 };
    const tool = spawnTool(async (job) => {
      seen[job.id] = (seen[job.id] || 0) + 1;
      if (job.id === 'verify') {
        const check = failing(seen.verify);
        job.onReport({ summary: 'Revisado', status: 'done', data: {
          passed: !check,
          checks: [{ criterion: check || 'Todo bien', ok: !check, evidence: 'x', owner_id: 'api' }],
          fixes: check ? [{ owner_id: 'api', instruction: 'Arregla ' + check }] : []
        } });
        return { text: 'v', cost: 0 };
      }
      job.onReport({ summary: 'Hecho', status: 'done' });
      return { text: 'ok', cost: 0 };
    });
    const result = await tool.execute('f', { goal: 'g', acceptance: ['Algo'], fix_rounds: rounds, agents: [agent('API', { id: 'api' }), agent('Tests', { id: 'tests' })] });
    return { seen, result };
  };
  // A different failure each time: the three rounds are used and the fourth check passes.
  const progressing = await run(3, (n) => (n <= 3 ? 'criterio ' + n : ''));
  assert.equal(progressing.seen.api, 4, 'the original run and three fixes');
  assert.equal(progressing.seen.verify, 4);
  assert.equal(progressing.result.details.rounds, 3);
  assert.equal(progressing.result.details.verify.passed, true);
  // The same check failing again: it stops after the first fix.
  const stuck = await run(3, () => 'siempre lo mismo');
  assert.equal(stuck.seen.api, 2);
  assert.equal(stuck.seen.verify, 2);
  assert.equal(stuck.result.details.rounds, 1);
  assert.match(textOf(stuck.result), /1 ronda de arreglos/);
  // fix_rounds 0: the verdict is reported and nobody is sent back.
  const none = await run(0, () => 'falla');
  assert.equal(none.seen.api, 1);
  assert.equal(none.seen.verify, 1);
  assert.equal(none.result.details.rounds, undefined);
});

test('no report: one is made from the text; long texts are clipped', async () => {
  const long = 'x'.repeat(3000) + ' https://github.com/a/b/pull/3';
  const tool = spawnTool(async () => ({ text: long, cost: 0 }));
  const result = await tool.execute('s9', { verify: false, agents: [agent('Largo')] });
  assert.match(textOf(result), /\(texto completo en el panel del agente\)/);
  assert.equal(result.details.agents[0].report.synthesized, true);
  assert.ok(result.details.agents[0].result.length <= 4000);
});

test('many agents: results come back trimmed and agent_report reads one in full', async () => {
  const summary = (id) => 'Resumen largo del agente ' + id + '. ' + 'detalle '.repeat(380);
  const tools = createAgentTools({ timing: TIMING, runSubAgent: async (job) => { job.onReport({ summary: summary(job.id), status: 'done' }); return { text: 'fin ' + job.id, cost: 0 }; } });
  const spawn = tools.find((tool) => tool.name === 'spawn_agents');
  const reader = tools.find((tool) => tool.name === 'agent_report');
  const none = await reader.execute('d0', { agent: 'a1' });
  assert.equal(none.isError, true, 'nothing to read before any run');
  const result = await spawn.execute('d1', { verify: false, agents: Array.from({ length: 12 }, (_, i) => agent('Agente ' + (i + 1), { id: 'a' + (i + 1) })) });
  const text = textOf(result);
  assert.match(text, /recortado; agent_report con «a1» da el texto completo/);
  assert.match(text, /Hay informes recortados: agent_report/);
  assert.ok(text.length < 40000, 'the digest is bounded: ' + text.length);
  const full = await reader.execute('d2', { agent: 'a1' });
  assert.ok(!full.isError);
  assert.ok(full.content[0].text.includes(summary('a1').slice(0, 2500)), 'the whole report is there');
  assert.match(full.content[0].text, /Texto final:\nfin a1/);
  const byName = await reader.execute('d3', { agent: 'agente 2', part: 'report' });
  assert.match(byName.content[0].text, /^## Agente 2 \(a2, build, done\)/);
  const task = await reader.execute('d4', { agent: 'a3', part: 'task' });
  assert.match(task.content[0].text, /Tu tarea:\nTarea de Agente 3\./);
  const unknown = await reader.execute('d5', { agent: 'nadie' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /No hay ningún agente «nadie» en esta respuesta\. Agentes: a1 \(Agente 1\)/);
});

test('the answer as a whole has a spending cap shared by every spawn_agents call', async () => {
  const tools = createAgentTools({ turnBudget: 0.3, timing: TIMING, runSubAgent: async (job) => { job.onUpdate({ cost: 0.09 }); return { text: 'ok', cost: 0.09 }; } });
  const spawn = tools.find((tool) => tool.name === 'spawn_agents');
  const first = await spawn.execute('t1', { verify: false, budget_usd: 5, agents: [agent('A'), agent('B'), agent('C')] });
  assert.equal(first.details.budget, 0.3, 'the call\'s budget is clamped to what the answer may still spend');
  assert.match(textOf(first), /Gasto de Ultra code en esta respuesta: \$0\.2700 de \$0\.30\./);
  const second = await spawn.execute('t2', { verify: false, agents: [agent('D')] });
  assert.equal(second.details.refused, true);
  assert.match(textOf(second), /^Tope de gasto de Ultra code en esta respuesta alcanzado \(\$0\.2700 de \$0\.30\)/);
  assert.equal(second.details.agents, undefined, 'nothing started');
});

test('submit_result tool', async () => {
  let got = null;
  const tool = createSubAgentReportTool((report) => { got = report; });
  assert.equal(tool.name, 'submit_result');
  const out = await tool.execute('t', { summary: 'Listo', status: 'partial', artifacts: [{ kind: 'commit', ref: 'abc1234' }], open_issues: ['falta X'], confidence: 0.5, data: { a: 1 } });
  assert.equal(out.content[0].text, 'Recibido. Termina con una frase.');
  assert.equal(got.status, 'partial');
  assert.deepEqual(got.data, { a: 1 });
});

test('a parent abort settles every agent as stopped before rethrowing', async () => {
  const controller = new AbortController();
  const updates = [];
  const tool = spawnTool(async (job) => {
    await new Promise((resolve, reject) => {
      job.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  const run = tool.execute('s10', { verify: false, agents: [agent('A', { id: 'a' }), agent('B', { id: 'b', depends_on: ['a'] }), agent('C', { id: 'c' })] }, controller.signal, (u) => updates.push(u));
  await sleep(40);
  controller.abort();
  await assert.rejects(run, (error) => error.name === 'AbortError');
  const final = updates[updates.length - 1].details.agents;
  assert.ok(final.every((row) => row.status === 'stopped' && row.doing === 'Detenido' && row.endedAt), JSON.stringify(final.map((row) => [row.id, row.status, row.doing])));
});
