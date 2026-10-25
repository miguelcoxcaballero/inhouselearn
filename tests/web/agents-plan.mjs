// spawn_agents v2 (engine/src/agents.js) without a browser or a model: the
// plan (ids, dependencies, cycles, waves, lint) and the scheduler with a fake
// runSubAgent (concurrency cap, dependency results in the downstream task,
// skips on failure, the budget, the verifier and a parent abort).
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
const { planAgents, createAgentTools, createSubAgentReportTool } = agents;

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
  assert.ok(['No empieza: presupuesto agotado', 'No empieza: falló «Barato»'].includes(rows.luego.doing), rows.luego.doing);
  assert.equal(result.details.budget, 0.2);
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
    seen.push({ id: job.id, role: job.role, readOnly: job.readOnly, task: job.task });
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
  assert.match(verifier[0].task, /Objetivo: Una API con tests/);
  assert.match(verifier[0].task, /1\. Hay tests\n2\. La API responde/);
  assert.match(verifier[0].task, /### API \(id api, done\)/);
  assert.match(verifier[0].task, /submit_result con data/);
  const fix = seen.filter((item) => item.id === 'api');
  assert.equal(fix.length, 2);
  assert.match(fix[1].task, /El verificador encontró: Añade la ruta \/hola\. Corrige solo eso\./);
  assert.equal(result.details.verify.passed, true);
  assert.equal(result.details.verify.checks.length, 2);
  assert.ok(result.details.agents.find((row) => row.id === 'verify'));
});

test('no report: one is made from the text; long texts are clipped', async () => {
  const long = 'x'.repeat(3000) + ' https://github.com/a/b/pull/3';
  const tool = spawnTool(async () => ({ text: long, cost: 0 }));
  const result = await tool.execute('s9', { verify: false, agents: [agent('Largo')] });
  assert.match(textOf(result), /\(texto completo en el panel del agente\)/);
  assert.equal(result.details.agents[0].report.synthesized, true);
  assert.ok(result.details.agents[0].result.length <= 4000);
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
