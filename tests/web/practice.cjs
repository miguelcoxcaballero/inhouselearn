const { chromium, devices } = require('playwright');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const V = (o) => '```visual\n' + JSON.stringify(o) + '\n```';
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + extra : ''));
const SPECS = {
  match: { type: 'match', title: 'Orgánulos y función', pairs: [{ left: 'Mitocondria', right: 'Respiración celular' }, { left: 'Ribosoma', right: 'Síntesis de proteínas' }, { left: 'Cloroplasto', right: 'Fotosíntesis' }, { left: 'Núcleo', right: 'Guarda el ADN' }] },
  order: { type: 'order', title: 'Ordena la mitosis', items: ['Profase', 'Metafase', 'Anafase', 'Telofase'], explanation: 'PMAT.' },
  categorize: { type: 'categorize', title: '¿Ácido o base?', categories: ['Ácido', 'Base'], items: [{ text: 'HCl', category: 0 }, { text: 'NaOH', category: 1 }, { text: 'Vinagre', category: 0 }, { text: 'Lejía', category: 1 }] },
  fill: { type: 'fill', title: 'Derivadas', text: 'La derivada de \\(x^2\\) es [[2x|x^2|2]] y la de una constante es [[0|1|la constante]].' },
  estimate: { type: 'estimate', question: '¿Qué % del cuerpo humano es agua?', min: 0, max: 100, step: 1, answer: 60, unit: '%', tolerance: 5, explanation: 'Alrededor del 60 %.' },
  truefalse: { type: 'truefalse', title: 'Rápido', statements: [{ text: 'El Sol es una estrella', answer: true }, { text: 'La Luna emite luz propia', answer: false, explanation: 'Refleja la del Sol.' }] },
  check: { type: 'check', question: '¿2+2?', options: ['4', '3', '5'], correct: 0, explanation: 'Suma.' }
};
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, devices['Pixel 7']);
  await page.evaluate((t) => window.__replies.push({ text: t, chunk: 500, delay: 5 }), Object.values(SPECS).map(V).join('\n\nSigue.\n\n'));
  await send(page, 'Practica');
  await idle(page);
  const kinds = await page.evaluate(() => [...document.querySelectorAll('.viz')].map((v) => v.className.split(' ')[1]));
  console.log(await page.evaluate(() => document.querySelector('.viz-fallback') && document.querySelector('.viz-fallback').innerText.slice(0, 200)), typeof errors, JSON.stringify(errors.slice(0,3)));
  check('all six practice types render (+ check)', ['viz-practice', 'viz-practice', 'viz-practice', 'viz-practice', 'viz-practice', 'viz-practice', 'viz-check'].every((k, i) => kinds[i] === k), kinds.join(' '));
  // match: right column shuffled, pairing works, wrong pair counted.
  const m = await page.evaluate(() => { const el = document.querySelector('.viz-match'); return [...el.querySelectorAll('[data-side="r"]')].map((b) => b.dataset.k).join(''); });
  await page.click('.viz-match [data-side="l"][data-k="0"]'); await page.click('.viz-match [data-side="r"][data-k="1"]');
  for (const k of [0, 1, 2, 3]) { await page.click('.viz-match [data-side="l"][data-k="' + k + '"]'); await page.click('.viz-match [data-side="r"][data-k="' + k + '"]'); }
  const mr = await page.evaluate(() => document.querySelector('.viz-match .px-result').textContent);
  check('match: shuffled right column, pairs, counts misses', m !== '0123' && /1 fallo/.test(mr), m + ' | ' + mr);
  // order: starts shuffled; arrange via swaps then check.
  const start = await page.evaluate(() => [...document.querySelectorAll('.viz-order .px-text')].map((b) => b.textContent).join(','));
  for (let guard = 0; guard < 10; guard++) {
    const texts = await page.evaluate(() => [...document.querySelectorAll('.viz-order .px-text')].map((b) => b.textContent));
    const want = ['Profase', 'Metafase', 'Anafase', 'Telofase'];
    const pos = texts.findIndex((t, i) => t !== want[i]);
    if (pos < 0) break;
    await page.click('.viz-order [data-swap="' + pos + '"]'); await page.click('.viz-order [data-swap="' + texts.indexOf(want[pos]) + '"]');
  }
  await page.click('.viz-order [data-px="check"]');
  const or = await page.evaluate(() => document.querySelector('.viz-order .px-result').textContent);
  check('order: shuffled at first, solved by the student', start !== 'Profase,Metafase,Anafase,Telofase' && /correcto/.test(or), start + ' | ' + or);
  // categorize: place all, one wrong.
  const place = async (text, cat) => { await page.click('.viz-categorize .px-pool .px-chip:has-text("' + text + '")'); await page.click('.viz-categorize .px-bucket[data-cat="' + cat + '"]'); };
  await place('HCl', 0); await place('NaOH', 1); await place('Vinagre', 1); await place('Lejía', 1);
  await page.click('.viz-categorize [data-px="check"]');
  const cr = await page.evaluate(() => ({ r: document.querySelector('.viz-categorize .px-result').textContent, wrong: document.querySelectorAll('.viz-categorize .px-chip.wrong').length }));
  check('categorize: places items and marks the wrong one', cr.wrong === 1 && /1 mal colocado /.test(cr.r), JSON.stringify(cr));
  // fill: choose answers.
  await page.selectOption('.viz-fill select[data-blank="0"]', '2x'); await page.selectOption('.viz-fill select[data-blank="1"]', '1');
  await page.click('.viz-fill [data-px="check"]');
  const fr = await page.evaluate(() => ({ r: document.querySelector('.viz-fill .px-result').textContent, first: [...document.querySelector('.viz-fill select[data-blank="0"]').options].slice(1).map((o) => o.value).join('|') }));
  check('fill: options shuffled, graded', /1 de 2/.test(fr.r) && fr.first !== '2x|x^2|2', JSON.stringify(fr));
  // estimate
  await page.evaluate(() => { const i = document.querySelector('.viz-estimate input'); i.value = '58'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('.viz-estimate [data-px="lock"]');
  const er = await page.evaluate(() => ({ r: document.querySelector('.viz-estimate .px-result').textContent, real: !document.querySelector('.viz-estimate .px-real').hidden }));
  check('estimate: guess, lock, reveal the real value', er.real && /Muy cerca/.test(er.r) && /2 %/.test(er.r), er.r);
  // truefalse
  await page.click('.viz-truefalse [data-answer="0:1"]'); await page.click('.viz-truefalse [data-answer="1:1"]');
  const tr = await page.evaluate(() => document.querySelector('.viz-truefalse .px-result').textContent);
  check('truefalse: instant marks and score', /1 de 2/.test(tr), tr);
  const dist = await page.evaluate(() => { const c = [0, 0, 0, 0]; for (let k = 0; k < 400; k++) { const el = vizCheck({ type: 'check', question: 'Q' + k, options: ['bien', 'mal1', 'mal2', 'mal3'], correct: 0, explanation: '' }, {}); const pos = [...el.querySelectorAll('.viz-check-opt')].findIndex((b) => /bien/.test(b.textContent)); c[pos]++; } return c; });
  check('check: right answer spread over A–D (400 questions written with it first)', dist.every((n) => n > 70 && n < 130), dist.join(' / '));
  await page.locator('.viz-match').scrollIntoViewIfNeeded(); await page.locator('.viz-match').screenshot({ path: SCRATCH + '/shots/px-match.png' });
  await page.locator('.viz-categorize').screenshot({ path: SCRATCH + '/shots/px-categorize.png' });
  await page.locator('.viz-fill').screenshot({ path: SCRATCH + '/shots/px-fill.png' });
  await page.locator('.viz-estimate').screenshot({ path: SCRATCH + '/shots/px-estimate.png' });
  await page.locator('.viz-order').screenshot({ path: SCRATCH + '/shots/px-order.png' });
  await page.locator('.viz-truefalse').screenshot({ path: SCRATCH + '/shots/px-tf.png' });
  // Variety: the next request lists the types used.
  await page.evaluate(() => window.__replies.push({ text: 'ok' }));
  await send(page, 'Más');
  await idle(page);
  const sys = await page.evaluate(() => window.__requests[window.__requests.length - 1].messages[0].content);
  check('next request tells the model which types it already used', /already used in this chat \(oldest first\): .*categorize.*truefalse/.test(sys), (sys.match(/Visual types you already used[^\n]*/) || [''])[0].slice(0, 160));
  // Guided quiz: a model that always writes the right answer first and longest.
  await page.click('#hamburger-btn');
  await page.click('#new-chat-btn');
  await page.click('#plus-btn');
  await page.click('#guided-btn');
  await page.evaluate(() => window.__replies.push({ text: 'Plan.', tools: [{ name: 'set_course_plan', args: { title: 'T', goal: 'G', units: [{ title: 'U', lessons: [{ title: 'L', objectives: ['o'] }] }] } }] }, { text: 'Listo.' }));
  await send(page, 'Quiero aprender algo');
  await idle(page);
  await page.evaluate(() => window.__replies.push({ text: 'Empezamos.' }));
  await page.click('[data-g-start]'); await idle(page);
  const long = (n) => ({ question: 'Pregunta ' + n, options: ['La respuesta correcta, explicada con todo detalle y matices', 'No', 'Quizá', 'Nunca'], correct: 0, explanation: 'Porque sí.' });
  const fair = (n) => ({ question: 'Pregunta ' + n, options: ['Respuesta correcta ' + n, 'Respuesta errónea a', 'Respuesta errónea b', 'Respuesta errónea c'], correct: 0, explanation: 'Porque sí.' });
  await page.evaluate(([a, b]) => window.__replies.push({ text: 'Test.', tools: [{ name: 'quiz', args: { questions: a } }] }, { text: 'Corrijo.', tools: [{ name: 'quiz', args: { questions: b } }] }, { text: 'Suerte.' }),
    [[1, 2, 3, 4].map(long), [1, 2, 3, 4].map(fair)]);
  await page.click('[data-g-quick="test"]');
  await idle(page);
  const q = await page.evaluate(() => {
    const course = getActiveChat().course;
    const quizzes = Object.values(course.quizzes);
    const steps = getActiveChat().messages.flatMap((m) => m.toolSteps || []).filter((s) => s.name === 'quiz');
    return { quizzes: quizzes.length, firstRejected: steps.length >= 2 && steps[0].status === 'error' && /clearly the longest/.test(steps[0].output), positions: quizzes[0] ? quizzes[0].questions.map((qq) => qq.correct).join('') : '', rightTexts: quizzes[0] ? quizzes[0].questions.every((qq) => /correcta/.test(qq.options[qq.correct])) : false };
  });
  check('tutor quiz: long giveaway answers sent back; positions spread over A–D', q.firstRejected && q.quizzes === 1 && q.rightTexts && new Set(q.positions).size === 4, JSON.stringify(q));
  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
