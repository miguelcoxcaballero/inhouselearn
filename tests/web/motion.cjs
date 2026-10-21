const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
const { openApp } = require('./mock.cjs');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  try {
    const { page, errors } = await openApp(browser, devices['Pixel 7']);
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'motion-fixture';
      fixture.style.cssText = 'position:fixed;inset:0;z-index:10000;background:var(--bg);overflow:auto;padding:16px';
      document.body.append(fixture);
      fixture.append(vizSequence({ items: ['Uno', 'Dos', 'Tres'] }, {}));
    });
    const order = await page.evaluate(() => {
      const row = document.querySelector('#motion-fixture .px-row');
      const key = row.dataset.motionKey;
      const before = row.getBoundingClientRect().top;
      const button = row.querySelector('[aria-label="Bajar"]');
      button.focus(); button.click();
      const moved = document.querySelector('[data-motion-key="' + key + '"]');
      return { key, before, immediate: moved.getBoundingClientRect().top, running: moved.getAnimations().length, focus: document.activeElement.closest('.px-row')?.dataset.motionKey };
    });
    assert.ok(Math.abs(order.immediate - order.before) < 2, 'reorder starts at the old visual position');
    assert.ok(order.running > 0);
    assert.equal(order.focus, order.key);
    await page.waitForTimeout(350);
    assert.ok(await page.evaluate(({ key, before }) => document.querySelector('[data-motion-key="' + key + '"]').getBoundingClientRect().top > before + 20, order));
    console.log('PASS order items move continuously and keyboard focus follows the item');

    const quiz = await page.evaluate(() => {
      const fixture = document.querySelector('#motion-fixture'); fixture.replaceChildren();
      const chat = getActiveChat(); const course = courseOf(chat);
      course.status = 'learning';
      course.quizzes.motion = { id: 'motion', kind: 'check', questions: [1, 2].map((n) => ({ question: 'Pregunta ' + n, options: ['Respuesta uno', 'Respuesta dos', 'Respuesta tres'], correct: 0, explanation: 'Explicación.' })), answers: {} };
      fixture.innerHTML = renderQuizCard(course, course.quizzes.motion);
      const before = fixture.firstElementChild.getBoundingClientRect().height;
      fixture.querySelector('[data-g-answer="motion:0:0"]').focus();
      guidedAnswer(chat, 'motion', 0, 0);
      const card = fixture.firstElementChild;
      return { before, immediate: card.getBoundingClientRect().height, running: card.getAnimations().length, focus: document.activeElement.dataset.gAnswer };
    });
    assert.ok(Math.abs(quiz.immediate - quiz.before) < 2, 'quiz does not jump to collapsed height');
    assert.ok(quiz.running > 0);
    assert.equal(quiz.focus, 'motion:1:0');
    await page.waitForTimeout(80);
    const interrupted = await page.evaluate(() => {
      const before = document.querySelector('[data-g-quiz="motion"]').getBoundingClientRect().height;
      guidedAnswer(getActiveChat(), 'motion', 1, 0);
      return { before, immediate: document.querySelector('[data-g-quiz="motion"]').getBoundingClientRect().height };
    });
    assert.ok(Math.abs(interrupted.immediate - interrupted.before) < 3, 'rapid answers continue from the current height');
    await page.waitForTimeout(350);
    const settled = await page.evaluate(() => ({ height: document.querySelector('[data-g-quiz="motion"]').getBoundingClientRect().height, active: interactiveMotion.active.size }));
    assert.ok(settled.height < quiz.before - 100);
    assert.equal(settled.active, 0);
    console.log('PASS quiz collapse, rapid answers and transition cleanup');

    const steps = await page.evaluate(() => {
      const fixture = document.querySelector('#motion-fixture'); fixture.replaceChildren();
      const card = vizSteps({ steps: [{ body: 'Primero.' }, { body: 'Después.' }, { body: 'Al final.' }], result: 'Hecho.' }, {});
      fixture.append(card);
      const before = card.getBoundingClientRect().height;
      card.querySelector('[data-step="all"]').click();
      return { before, immediate: card.getBoundingClientRect().height, running: card.getAnimations().length };
    });
    assert.ok(Math.abs(steps.before - steps.immediate) < 2);
    assert.ok(steps.running > 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(60);
    const reduced = await page.evaluate(() => {
      document.querySelector('[data-step="next"]').click();
      return { active: interactiveMotion.active.size, animations: document.querySelector('.viz-steps').getAnimations({ subtree: true }).length, shown: document.querySelectorAll('.viz-step.shown').length };
    });
    assert.deepEqual(reduced, { active: 0, animations: 0, shown: 1 });
    console.log('PASS reveal height is animated; reduced motion cancels animation and keeps controls working');

    // Match scheduler calls against browser frames on a coarse-pointer device.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const cadence = await page.evaluate(async () => {
      const fixture = document.querySelector('#motion-fixture'); fixture.replaceChildren();
      let advances = 0, frames = 0;
      const view = { el: fixture, playing: true, visible: true, advance() { advances++; }, pause() { this.playing = false; } };
      sceneRuntime.views.add(view);
      sceneSchedule();
      await new Promise((resolve) => {
        const tick = () => { frames++; if (frames < 16) requestAnimationFrame(tick); else resolve(); };
        requestAnimationFrame(tick);
      });
      sceneRuntime.views.delete(view);
      return { frames, advances, coarse: sceneRuntime.coarse };
    });
    assert.equal(cadence.coarse, true);
    assert.ok(cadence.advances >= cadence.frames - 2, JSON.stringify(cadence));
    console.log('PASS mobile scenes follow browser frames without a fixed 30 fps cap');

    const slider = await page.evaluate(async () => {
      const fixture = document.querySelector('#motion-fixture'); fixture.replaceChildren();
      const state = {};
      const card = vizPlot({ type: 'formula', params: { a: { min: 0, max: 10, value: 0, step: 1 } }, readouts: [{ label: 'Doble', expr: 'a*2' }] }, state);
      fixture.append(card);
      const output = card.querySelector('[data-viz-readout]');
      let updates = 0;
      const observer = new MutationObserver((records) => { updates += records.length; });
      observer.observe(output, { childList: true });
      const input = card.querySelector('input');
      for (let i = 1; i <= 10; i++) { input.value = i; input.dispatchEvent(new Event('input')); }
      await new Promise(requestAnimationFrame);
      await Promise.resolve();
      observer.disconnect();
      return { updates, value: state.values.a, output: output.textContent };
    });
    assert.deepEqual(slider, { updates: 1, value: 10, output: '20' });
    console.log('PASS rapid slider input renders the latest result once per frame');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
