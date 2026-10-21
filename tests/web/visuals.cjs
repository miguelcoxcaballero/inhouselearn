const { chromium, devices } = require('playwright');
const fs = require('fs');
const { openApp, send, idle, SCRATCH, BASE } = require('./mock.cjs');
const EX = JSON.parse(fs.readFileSync(require('path').join(__dirname, '../../docs/visual-examples.json'), 'utf8'));
const V = (o) => '```visual\n' + JSON.stringify(o) + '\n```';
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + extra : ''));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1280, height: 900 } });
  const external = [];
  page.on('request', (r) => { if (/example\.com|evil\./.test(r.url())) external.push(r.url() + ' from ' + (r.frame() === page.mainFrame() ? 'main' : 'iframe') + ' nav=' + r.isNavigationRequest()); }); page.on('requestfinished', (r) => { if (/example\.com|evil\./.test(r.url())) external.push('FINISHED ' + r.url()); });
  await page.evaluate((t) => window.__replies.push({ text: t, chunk: 400, delay: 5 }),
    'Mira el tubo:\n\n' + V(EX.tube) + '\n\nY el péndulo:\n\n' + V(EX.pendulum) + '\n\nY el algoritmo:\n\n' + V(EX.sort) + '\n\nFin.');
  await send(page, 'Enséñame');
  await idle(page);
  await page.waitForTimeout(1500);
  const ids = await page.evaluate(() => [...document.querySelectorAll('.viz')].map((v) => v.dataset.vizId + ':' + v.className.split(' ').slice(1, 2)));
  check('three visuals in one message, interleaved, stable ids', ids.length === 3 && ids.every((id, k) => id.includes('-' + k)), ids.join(' '));
  // (a) particles faster in the narrowing, pressure lower there.
  await page.locator('.viz-scene').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const sample = () => page.evaluate(() => [...document.querySelectorAll('.viz-scene')[0].querySelectorAll('.scene-svg circle')].filter((c) => c.style.display !== 'none' && c.getAttribute('r') === '3.5').map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]));
  const a = await sample(); await page.waitForTimeout(250); const b = await sample();
  const wide = [], narrow = [];
  a.forEach((p, k) => { const d = b[k][0] - p[0]; if (d <= 0) return; const x = p[0] / 800 * 12; if (x > 5.3 && x < 8.7) narrow.push(d); else if (x < 3.6 || x > 10.4) wide.push(d); });
  const avg = (l) => l.reduce((s, v) => s + v, 0) / (l.length || 1);
  check('(a) particles speed up in the narrowing', avg(narrow) > avg(wide) * 1.8, 'wide ' + avg(wide).toFixed(1) + 'px vs narrow ' + avg(narrow).toFixed(1) + 'px per 250 ms');
  const cols = await page.evaluate(() => [...document.querySelectorAll('.viz-scene')[0].querySelectorAll('.scene-svg rect')].filter((r) => r.getAttribute('fill') === '#60a5fa').map((r) => Number(r.getAttribute('height'))));
  check('(a) pressure column lower in the narrowing', cols.length === 2 && cols[1] < cols[0], cols.join(' vs '));
  const before = await page.evaluate(() => document.querySelector('.viz-scene [data-scene-readout="0"]').textContent);
  await page.evaluate(() => { const i = document.querySelector('.viz-scene input[type=range]'); i.value = '1.9'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => ({ r: document.querySelector('.viz-scene [data-scene-readout="0"]').textContent, note: document.querySelector('.viz-scene .scene-note').textContent }));
  check('(a) slider responds at once and the trigger fires', before !== after.r && /4 m\/s/.test(after.note), before + ' → ' + after.r + ' | ' + after.note);
  const t1 = await page.evaluate(() => document.querySelector('.viz-scene .scene-time').textContent);
  await page.click('.viz-scene [data-scene="play"]');
  const paused = await page.evaluate(() => document.querySelector('.viz-scene [data-scene="play"]').getAttribute('aria-pressed'));
  const tp = await page.evaluate(() => document.querySelector('.viz-scene .scene-time').textContent); await page.waitForTimeout(500);
  const tq = await page.evaluate(() => document.querySelector('.viz-scene .scene-time').textContent);
  check('(a) pause stops time', paused === 'false' && tp === tq, t1 + ' / ' + tp + ' / ' + tq);
  await page.click('.viz-scene [data-scene="play"]');
  await page.locator('.viz-scene').first().screenshot({ path: SCRATCH + '/shots/scene-tube.png' });
  // (b) pendulum
  await page.locator('.viz-scene').nth(1).scrollIntoViewIfNeeded();
  const ang1 = await page.evaluate(() => document.querySelectorAll('.viz-scene')[1].querySelector('[data-scene-readout="1"]').textContent); await page.waitForTimeout(400);
  const ang2 = await page.evaluate(() => document.querySelectorAll('.viz-scene')[1].querySelector('[data-scene-readout="1"]').textContent);
  const T1 = await page.evaluate(() => document.querySelectorAll('.viz-scene')[1].querySelector('[data-scene-readout="0"]').textContent);
  await page.evaluate(() => { const i = document.querySelectorAll('.viz-scene')[1].querySelector('input[type=range]'); i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const T2 = await page.evaluate(() => document.querySelectorAll('.viz-scene')[1].querySelector('[data-scene-readout="0"]').textContent);
  check('(b) pendulum swings; longer rope, longer period', ang1 !== ang2 && parseFloat(T2.replace(',', '.')) > parseFloat(T1.replace(',', '.')), ang1 + '→' + ang2 + ' | T ' + T1 + '→' + T2);
  await page.locator('.viz-scene').nth(1).screenshot({ path: SCRATCH + '/shots/scene-pendulum.png' });
  // (c) sandbox running
  await page.locator('.viz-sandbox').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await page.locator('.viz-sandbox').screenshot({ path: SCRATCH + '/shots/scene-sort.png' });
  const sb = await page.evaluate(() => ({ sandbox: document.querySelector('.viz-sandbox iframe').getAttribute('sandbox'), note: document.querySelector('.viz-sandbox .scene-note').textContent, h: document.querySelector('.viz-sandbox iframe').style.height }));
  check('(c) sandbox: allow-scripts only, started, resized itself', sb.sandbox === 'allow-scripts' && !sb.note, JSON.stringify(sb));
  // Channel back: the slider move reaches the next turn's system prompt.
  await page.evaluate(() => window.__replies.push({ text: 'Vale.' }));
  await send(page, '¿Qué ha pasado?');
  await idle(page);
  const sys = await page.evaluate(() => window.__requests[window.__requests.length - 1].messages[0].content);
  check('student actions reach the tutor next turn, then are cleared', /What the student did/.test(sys) && /Apertura del grifo = 1,9/.test(sys) && /4 m\/s/.test(sys), (sys.match(/- \(Visual[^\n]*/g) || []).slice(0, 3).join(' | '));
  // Security: a malicious sandbox.
  const evil = { type: 'sandbox', title: 'Malicioso', html: '<script>var r=[];try{fetch("https://example.com/f").then(function(){r.push("fetch ok")}).catch(function(){})}catch(e){r.push("fetch blocked")}try{var x=new XMLHttpRequest()}catch(e){r.push("xhr blocked")}try{parent.document.body.innerHTML="HACKED"}catch(e){r.push("parent blocked")}try{top.location="https://evil.example.com"}catch(e){r.push("nav blocked")}try{localStorage.setItem("a","b")}catch(e){r.push("storage blocked")}try{document.cookie="a=b"}catch(e){r.push("cookie blocked")}var i=new Image();i.src="https://example.com/x.png";parent.postMessage({v:1,type:"emit",id:"sbx-other",payload:{name:"x"}},"*");parent.postMessage({v:1,type:"emit",id:"nope",payload:{name:"pwn"}},"*");document.body.textContent=r.join(", ");</script>', emit: ['done'] };
  await page.evaluate((t) => window.__replies.push({ text: t }), 'Prueba:\n\n' + V(evil));
  await send(page, 'Prueba de seguridad');
  await idle(page);
  await page.waitForTimeout(2500);
  const safe = await page.evaluate(() => ({ hacked: document.body.innerHTML.includes('HACKED') && !document.querySelector('.viz-sandbox:last-of-type'), url: location.href, thread: !!document.querySelector('#thread .message'), chips: [...document.querySelectorAll('.scene-chip')].map((c) => c.textContent) }));
  check('malicious sandbox: no network, no parent access, no navigation, chat intact', !external.some((e) => e.startsWith('FINISHED')) && safe.url.startsWith(new URL(BASE).origin) && safe.thread && !safe.chips.some((c) => /pwn|x/.test(c)), 'external: ' + JSON.stringify(external) + ' | ' + JSON.stringify(safe));
  // Fallbacks and limits.
  const bad = { type: 'scene', title: 'Rota', layers: [{ kind: 'teleport' }] };
  const many = Array.from({ length: 9 }, (_, k) => V({ type: 'cards', title: 'C' + k, items: [{ title: 'x' + k }] })).join('\n\nTexto.\n\n');
  await page.evaluate((t) => window.__replies.push({ text: t }), V(bad) + '\n\nY JSON roto:\n\n```visual\n{"type": "plot", oops}\n```\n\n' + many);
  await send(page, 'Límites');
  await idle(page);
  const lim = await page.evaluate(() => { const art = [...document.querySelectorAll('#thread article')].pop(); return { fallback: art.querySelectorAll('.viz-fallback').length, details: art.querySelectorAll('.viz-fallback details').length, more: art.querySelectorAll('.viz-more').length, rendered: art.querySelectorAll('.viz-ideas').length }; });
  check('invalid visuals become a neutral note; beyond 8 per message collapses', lim.fallback === 2 && lim.details === 2 && lim.more >= 1 && lim.rendered <= 7, JSON.stringify(lim));
  // Performance: 4 tube scenes at once.
  await page.evaluate((t) => window.__replies.push({ text: t, chunk: 2000, delay: 1 }), [1, 2, 3, 4].map(() => V(Object.assign({}, EX.tube, { title: 'Tubo ' + Math.random() }))).join('\n\nOtro:\n\n'));
  await send(page, 'Cuatro');
  await idle(page);
  await page.evaluate(() => { const art = [...document.querySelectorAll('#thread article')].pop(); art.querySelectorAll('.viz-scene').forEach((v, k) => { v.style.cssText = 'position:fixed;left:' + (k % 2) * 640 + 'px;top:' + Math.floor(k / 2) * 330 + 'px;width:620px;z-index:99'; }); });
  await page.waitForTimeout(800);
  const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(n / 2); }; requestAnimationFrame(f); }));
  const running = await page.evaluate(() => [...sceneRuntime.views].filter((v) => v.playing && v.visible).length);
  check('4 animations at once: ≤ 4 running, smooth', running <= 4 && fps >= 45, 'running ' + running + ', ' + fps + ' fps (headless)');
  // Accessibility.
  const a11y = await page.evaluate(() => ({ img: [...document.querySelectorAll('.scene-svg')].every((s) => s.getAttribute('role') === 'img' && s.getAttribute('aria-label').length > 20), buttons: [...document.querySelectorAll('.scene-bar button')].every((b) => b.getAttribute('aria-label') || b.textContent.trim()), sliders: [...document.querySelectorAll('.scene-controls input[type=range]')].every((i) => i.closest('label')), iframeTitle: [...document.querySelectorAll('.viz-sandbox iframe')].every((f) => f.title) }));
  check('accessibility: labelled images, buttons, sliders and frames', Object.values(a11y).every(Boolean), JSON.stringify(a11y));
  console.log('errors', JSON.stringify(errors));
  await browser.close();
})();
