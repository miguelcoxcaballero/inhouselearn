const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
const { openApp, send, idle, SCRATCH } = require('./mock.cjs');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  try {
    const { page, errors } = await openApp(browser, devices['Pixel 7']);
    const broken = 'El rey firmó el decreto yCwПрезидент. Le felicitamos y nos，表达 nuestra satisfacción.';
    const fixed = 'El rey firmó el decreto. Le felicitamos y expresamos nuestra satisfacción.';
    const queue = (...replies) => page.evaluate((items) => window.__replies.push(...items), replies.map((reply) => ({ chunk: 1000, delay: 1, ...reply })));
    await queue({ text: broken }, { text: fixed });
    await send(page, 'Explícame la caída de la monarquía española.');
    await idle(page);
    const result = await page.evaluate(() => {
      const message = getActiveChat().messages.at(-1);
      return { content: message.content, parts: message.parts, transcript: message.piMessages, requests: window.__requests };
    });
    assert.equal(result.content, fixed);
    assert.equal(result.parts[0].text, fixed);
    assert.equal(result.transcript[0].content[0].text, fixed);
    assert.equal(result.requests.length, 2);
    assert.ok(!result.requests[1].tools?.length);
    console.log('PASS new response repaired and saved consistently, with no repair tools');

    const valid = '¿Por qué? α + β = π.\n\n```js\nconst texto = "Президент";\n```';
    await queue({ text: valid });
    await send(page, 'Dame un ejemplo de código.');
    await idle(page);
    assert.equal(await page.evaluate(() => window.__requests.length), 3);
    assert.equal(await page.evaluate(() => getActiveChat().messages.at(-1).content), valid);
    console.log('PASS code, accents and mathematical symbols survive without extra requests');

    const oldId = await page.evaluate((text) => {
      const chat = getActiveChat();
      const message = createMessage('assistant', text, false);
      chat.messages.push(message);
      saveState({ skipDrive: true }); renderThread();
      return message.id;
    }, broken);
    await queue({ text: fixed });
    await page.click('[data-repair-msg="' + oldId + '"]');
    await idle(page);
    assert.equal(await page.evaluate((id) => getActiveChat().messages.find((m) => m.id === id).content, oldId), fixed);
    assert.equal(await page.locator('[data-repair-msg="' + oldId + '"]').count(), 0);
    console.log('PASS saved message repaired without regenerating the conversation');

    await page.evaluate(([id, text]) => { getActiveChat().messages.find((m) => m.id === id).content = text; renderThread(); }, [oldId, broken]);
    await queue({ text: broken });
    await page.click('[data-repair-msg="' + oldId + '"]'); await idle(page);
    assert.equal(await page.evaluate((id) => getActiveChat().messages.find((m) => m.id === id).content, oldId), broken);
    assert.match(await page.locator('#composer-status').textContent(), /No se ha podido corregir/);
    console.log('PASS unsuccessful correction keeps the original saved text');

    const requestCount = await page.evaluate(() => window.__requests.length);
    await page.evaluate((text) => window.__replies.push({ text, chunk: 1, delay: 100 }), fixed);
    await page.click('[data-repair-msg="' + oldId + '"]');
    await page.waitForFunction((count) => window.__requests.length > count, requestCount);
    await page.click('#send-btn'); await idle(page);
    assert.equal(await page.evaluate((id) => getActiveChat().messages.find((m) => m.id === id).content, oldId), broken);
    console.log('PASS cancelling a correction preserves the saved message');

    // Drive the actual course tools through OpenRouter, including repaired JSON.
    await page.click('#hamburger-btn'); await page.click('#new-chat-btn'); await page.click('#plus-btn'); await page.click('#guided-btn');
    await queue({ text: 'Plan.', tools: [{ name: 'set_course_plan', args: { title: 'Historia', goal: 'Comprender el cambio', units: [{ title: 'España', lessons: [{ title: 'La monarquía', objectives: ['Comprender el cambio'] }] }] } }] }, { text: 'Listo.' });
    await send(page, 'Quiero aprender historia de España.'); await idle(page);
    await queue({ text: 'Empezamos.' }); await page.click('[data-g-start]'); await idle(page);
    const question = (n) => ({ question: '¿Quién firmó el decreto ' + n + '?', options: ['El rey de España', 'El primer ministro', 'El jefe de gobierno'], correct: 0, explanation: 'Lo firmó el rey.' });
    const cleanQuiz = { questions: [question(1), question(2)] };
    const dirtyQuiz = JSON.parse(JSON.stringify(cleanQuiz));
    dirtyQuiz.questions[0].question = '¿Quién firmó el decreto Президент?';
    await queue({ text: 'Prueba.', tools: [{ name: 'quiz', args: dirtyQuiz }] }, { text: JSON.stringify(cleanQuiz) }, { text: 'Adelante.' });
    await page.click('[data-g-quick="test"]'); await idle(page);
    assert.equal(await page.locator('.g-quiz').count(), 1);
    assert.ok(!(await page.locator('.g-quiz').textContent()).includes('Президент'));
    assert.ok(!await page.evaluate(() => JSON.stringify(getActiveChat().messages.at(-1).piMessages).includes('Президент')));
    const quiz = await page.evaluate(() => Object.values(getActiveChat().course.quizzes)[0]);
    await page.locator('.g-quiz').screenshot({ path: SCRATCH + '/shots/quiz-unanswered.png' });
    for (let i = 0; i < quiz.questions.length; i++) {
      await page.click('[data-g-answer="' + quiz.id + ':' + i + ':' + quiz.questions[i].correct + '"]');
    }
    assert.equal(await page.locator('.g-q.compact.right').count(), 2);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      const layout = await page.evaluate(() => {
        const card = document.querySelector('.g-quiz');
        const compact = card.querySelector('.g-q.compact');
        return { border: getComputedStyle(card).borderTopWidth, shadow: getComputedStyle(card).boxShadow, nestedBorder: getComputedStyle(compact).borderLeftWidth, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(layout, { border: '0px', shadow: 'none', nestedBorder: '0px', overflow: false });
      await page.locator('.g-quiz').screenshot({ path: SCRATCH + '/shots/quiz-clean-' + width + '.png' });
    }
    console.log('PASS quiz text repaired before display, answer scoring and flat mobile/desktop layout');

    const cleanExam = { questions: [1, 2, 3, 4].map((n) => ({ ...question(n), lesson: 'L1' })) };
    const dirtyExam = JSON.parse(JSON.stringify(cleanExam));
    dirtyExam.questions[0].explanation = 'Lo firmó el rey 表达.';
    await queue({ text: 'Examen.', tools: [{ name: 'final_exam', args: dirtyExam }] }, { text: JSON.stringify(cleanExam) }, { text: 'Adelante.' });
    await page.click('[data-g-submit="' + quiz.id + '"]'); await idle(page);
    const exam = await page.evaluate(() => Object.values(getActiveChat().course.quizzes).find((q) => q.kind === 'exam'));
    assert.ok(exam);
    assert.equal(exam.questions[0].explanation, 'Lo firmó el rey.');
    for (let i = 0; i < exam.questions.length; i++) {
      await page.click('[data-g-answer="' + exam.id + ':' + i + ':' + exam.questions[i].correct + '"]');
    }
    await queue({ text: 'Curso completado.' });
    await page.click('[data-g-submit="' + exam.id + '"]'); await idle(page);
    assert.equal(await page.evaluate(() => getActiveChat().course.status), 'done');
    assert.equal(await page.evaluate(() => Object.values(getActiveChat().course.quizzes).find((q) => q.kind === 'exam').score), 100);
    console.log('PASS final exam repaired, graded and course completed');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
