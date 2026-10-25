// index.html must keep the wiring of the model's tools and of Estudio. A commit
// once rewrote index.html from an older copy and silently dropped all of it
// (0ac6023); this fails the build if that happens again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const NEEDED = {
  'createInteractTools(': 'ask_user and update_plan',
  'studyToolsFor(': 'the Estudio tools',
  'renderStepPlanCard(': 'the plan card in the thread',
  'currentMomentText()': 'the date in the system prompt',
  'InhouseStudy.brief(': 'what the model knows of the user',
  'src="study.js': 'study.js',
  'src="study-view.js': 'study-view.js',
  'id="study-btn"': 'the Estudio button',
  'InhouseStudy.configureDrive': 'study.json in Drive',
  'WEB_FETCH_NOISE': 'web_fetch without menus',
  'writeStateDb(': 'the saved chats in IndexedDB',
  'showLiveCost(': 'the live cost on other devices'
};

test('index.html keeps the tools, Estudio and persistence wiring', () => {
  for (const [needle, what] of Object.entries(NEEDED)) {
    assert.ok(html.includes(needle), 'index.html lost ' + what + ' (' + needle + '): was it rewritten from an older copy? See commit 0ac6023.');
  }
});
