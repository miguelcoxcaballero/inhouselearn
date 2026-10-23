// LaTeX in widgets: JSON-damaged commands (\frac → form feed), "\$…\$" escaped
// for Markdown, doubled backslashes and bare "x^2" options must all reach KaTeX.
const { chromium } = require('playwright');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1100, height: 900 } });
  // Written the way models write it: valid JSON where "\f" is a form feed, and
  // a second deck with "\$" (invalid JSON) mixed with a correct "\\,".
  const deckA = '{"type":"flashcards","title":"Reglas","cards":[{"front":"$\\frac{d}{dx}(x^n) =$","back":"$n\\\\,x^{n-1}$"}]}';
  const deckB = '{"type":"flashcards","title":"Reglas","cards":[{"front":"\\frac{d}{dx}(\\sin x)","back":"\\$n\\\\,x^{n-1}\\$ (bajas el exponente y le restas 1)"}]}';
  await page.evaluate((t) => window.__replies.push({ text: t }), 'Tarjetas:\n\n```visual\n' + deckA + '\n```\n\nY más:\n\n```visual\n' + deckB + '\n```\n');
  await send(page, 'Tarjetas de derivadas');
  await idle(page);
  await page.waitForTimeout(800);
  const faces = await page.evaluate(() => [...document.querySelectorAll('.viz-flash .viz-card-text')].map((el) => ({ katex: el.querySelectorAll('.katex').length, text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60), raw: /\\|\$|frac/.test(el.querySelector('.katex') ? el.innerText.replace(/[\s\S]*/, '') : el.textContent) })));
  check('flashcards: every face is drawn by KaTeX, no raw \\frac, \\$ or $', faces.length === 4 && faces.every((f) => f.katex >= 1 && !f.raw), faces);
  await page.locator('.viz-flash').first().screenshot({ path: SCRATCH + '/latex-flash.png' });

  // Guided quiz with options written without delimiters.
  await page.click('#hamburger-btn'); await page.click('#new-chat-btn');
  await page.click('#plus-btn'); await page.click('#guided-btn');
  await page.evaluate(() => window.__replies.push({ text: 'Plan.', tools: [{ name: 'set_course_plan', args: { title: 'Derivadas', goal: 'G', units: [{ title: 'U', lessons: [{ title: 'L', objectives: ['o'] }] }] } }] }, { text: 'Listo.' }));
  await send(page, 'Quiero aprender derivadas'); await idle(page);
  await page.evaluate(() => window.__replies.push({ text: 'Empezamos.' }));
  await page.click('[data-g-start]'); await idle(page);
  const questions = [
    { question: '¿Cuál es la derivada de x^2?', options: ['x', 'x^2', '2x^2', '2x'], correct: 3, explanation: 'Bajas el 2: \\frac{d}{dx}x^2 = 2x.' },
    { question: 'Si $f(x) = x^5$, ¿cuánto vale $f\'(2)$?', options: ['10', '16', '80', '32'], correct: 2, explanation: '$5\\cdot 2^4 = 80$' },
    { question: '¿Cuánto vale \\frac{d}{dx}\\sin x?', options: ['\\cos x', '-\\cos x', '\\sin x', '\\tan x'], correct: 0, explanation: 'Es el coseno.' },
    { question: 'Derivada de e^{3x}', options: ['3e^{3x}', 'e^{3x}', '3x e^{3x-1}', 'e^3'], correct: 0, explanation: 'Regla de la cadena.' }
  ];
  await page.evaluate((qs) => window.__replies.push({ text: 'Test.', tools: [{ name: 'quiz', args: { questions: qs } }] }, { text: 'Suerte.' }), questions);
  await page.click('[data-g-quick="test"]'); await idle(page);
  const quiz = [];
  // Focused quizzes reveal one question at a time. Inspect each actual question
  // before answering so all formulas and plain-number options remain covered.
  for (let index = 0; index < questions.length; index++) {
    quiz.push(await page.evaluate(() => {
      const q = document.querySelector('.g-q:not(.compact)');
      return {
      q: q.querySelector('.g-q-text').querySelectorAll('.katex').length,
      math: [...q.querySelectorAll('.g-opt-text')].map((o) => (o.querySelector('.katex') ? 'K' : o.textContent.trim())).sort().join(' ')
      };
    }));
    if (index === 0) await page.locator('.g-q').first().screenshot({ path: SCRATCH + '/latex-quiz.png' });
    await page.locator('.g-q:not(.compact) [data-g-answer]').first().click();
  }
  check('quiz: questions and formula options drawn by KaTeX, plain numbers stay text', quiz.length === 4 && quiz.every((q) => q.q >= 1) &&
    quiz[0].math === 'K K K K' && quiz[1].math.split(' ').every((m) => /^\d+$/.test(m)) && quiz[2].math === 'K K K K' && quiz[3].math === 'K K K K', quiz);
  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript/.test(e))));
  await browser.close();
})();
