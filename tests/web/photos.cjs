// Imágenes y vistas previas dentro del chat (image, gallery, preview):
// aparecen mientras el modelo sigue escribiendo, se limpian y no dejan pasar
// ni javascript: ni scripts dentro de un SVG.
//
//   python3 -m http.server 8765 --bind 127.0.0.1 &
//   CHROMIUM=/usr/bin/chromium node tests/web/photos.cjs
const { chromium } = require('playwright');
const { openApp, send, idle } = require('./mock.cjs');

const V = (o) => '```visual\n' + JSON.stringify(o) + '\n```';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

let failures = 0;
function check(label, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + extra : ''));
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const { page, errors } = await openApp(browser, { viewport: { width: 1100, height: 900 } });
  try {
    // 1. La vista previa aparece cuando su bloque se cierra, no al final.
    const answer = 'Mira cómo quedaría la tarjeta:\n\n' +
      V({ type: 'preview', title: 'Tarjeta nueva', device: 'phone', height: 260,
          html: '<div class="card">Hola <b>mundo</b></div>',
          css: '.card{border:1px solid #ccc;border-radius:14px;padding:12px;background:#fff}' }) +
      '\n\nY una foto de referencia:\n\n' +
      V({ type: 'image', src: PNG, alt: 'píxel de prueba', caption: 'Imagen de prueba' }) +
      '\n\nAhora te explico el resto con calma, palabra por palabra, para que se note que la respuesta sigue escribiéndose mientras ya ves lo de arriba en el chat.';
    await page.evaluate((t) => window.__replies.push({ text: t, chunk: 6, delay: 55 }), answer);
    await send(page, 'Enséñame la vista previa');
    await page.waitForSelector('.viz-preview-card', { timeout: 20000 });
    check('la vista previa aparece mientras el modelo sigue escribiendo', await page.evaluate(() => appState.busy === true));
    await page.waitForSelector('.viz-photo-img', { timeout: 20000 });
    await idle(page);
    await page.waitForTimeout(400);

    const first = await page.evaluate(() => {
      const article = [...document.querySelectorAll('#thread article')].pop();
      const img = article.querySelector('.viz-photo-img');
      const frame = article.querySelector('.viz-preview-live');
      const caption = article.querySelector('.viz-photo figcaption');
      return {
        src: img && img.getAttribute('src'),
        loaded: !!(img && img.naturalWidth > 0),
        alt: img && img.getAttribute('alt'),
        caption: caption ? caption.textContent.trim() : '',
        sandbox: frame ? frame.getAttribute('sandbox') : 'missing',
        srcdoc: frame ? (frame.getAttribute('srcdoc') || '') : '',
        title: frame ? frame.getAttribute('title') : '',
        reach: (() => { try { return !!frame.contentDocument; } catch (e) { return false; } })()
      };
    });
    check('la imagen se carga con su texto alternativo y su pie', first.loaded && first.src === PNG && first.alt === 'píxel de prueba' && /Imagen de prueba/.test(first.caption), JSON.stringify(first).slice(0, 200));
    check('la vista previa es un iframe sin scripts (sandbox="")', first.sandbox === '' && first.srcdoc.includes('class="card"') && /border-radius:14px/.test(first.srcdoc) && !!first.title, 'sandbox=' + JSON.stringify(first.sandbox) + ' title=' + first.title);
    check('la vista previa no puede tocar la página', first.reach === false);

    // 2. Lo que no debe pasar: javascript: y scripts dentro del SVG.
    const nasty = 'Cosas raras:\n\n' +
      V({ type: 'image', src: 'javascript:alert(1)', alt: 'malo' }) + '\n\n' +
      V({ type: 'image', svg: '<svg viewBox="0 0 10 10"><script>window.__pwn = 1;</script><circle cx="5" cy="5" r="4" fill="#E07A3C"/></svg>', alt: 'círculo' }) + '\n\n' +
      V({ type: 'gallery', title: 'Dos', images: [{ src: PNG, alt: 'a' }, { src: PNG, alt: 'b', caption: 'b' }] });
    await page.evaluate((t) => window.__replies.push({ text: t, chunk: 4000, delay: 1 }), nasty);
    await send(page, 'Raras');
    await idle(page);
    await page.waitForTimeout(300);
    const safe = await page.evaluate(() => {
      const article = [...document.querySelectorAll('#thread article')].pop();
      return {
        fallback: article.querySelectorAll('.viz-fallback').length,
        scripts: article.querySelectorAll('.viz-photo-canvas script').length,
        svg: article.querySelectorAll('.viz-photo-canvas svg').length,
        badImg: article.querySelectorAll('img[src^="javascript"]').length,
        tiles: article.querySelectorAll('.viz-photo-tile').length,
        pwn: !!window.__pwn
      };
    });
    check('src javascript: se rechaza con un aviso neutral', safe.fallback >= 1 && safe.badImg === 0, JSON.stringify(safe));
    check('el SVG se dibuja sin scripts', safe.svg === 1 && safe.scripts === 0 && !safe.pwn, JSON.stringify(safe));
    check('galería: una imagen por hueco', safe.tiles === 2, String(safe.tiles));

    console.log('errors', JSON.stringify(errors));
  } finally {
    await browser.close();
  }
  console.log(failures ? failures + ' FAIL' : 'photos: all PASS');
  process.exit(failures ? 1 : 0);
})();
