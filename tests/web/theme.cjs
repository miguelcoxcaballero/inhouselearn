// Modo noche: sigue al sistema, se puede fijar y se recuerda al recargar.
//
//   python3 -m http.server 8765 --bind 127.0.0.1 &
//   CHROMIUM=/usr/bin/chromium node tests/web/theme.cjs
//
// Deja dos capturas en $OUT: theme-dark.png y theme-plus-menu.png.
const { chromium } = require('playwright');
const { openApp, SCRATCH } = require('./mock.cjs');

let failures = 0;
function check(ok, label, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
}

function luminance(color) {
  const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return (Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114) / 255;
}

function state(page) {
  return page.evaluate(() => ({
    mode: document.documentElement.getAttribute('data-theme'),
    pref: document.documentElement.getAttribute('data-theme-pref'),
    bg: getComputedStyle(document.body).backgroundColor,
    color: getComputedStyle(document.body).color,
    composer: getComputedStyle(document.querySelector('.composer-area')).backgroundColor,
    meta: (document.querySelector('meta[name="theme-color"]') || {}).content,
    stored: localStorage.getItem('inhouselearn.theme')
  }));
}

async function pick(page, pref) {
  await page.click('#plus-btn');
  await page.waitForSelector('#plus-theme [data-theme-pref="' + pref + '"]');
  await page.click('#plus-theme [data-theme-pref="' + pref + '"]');
  await page.waitForTimeout(350);
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    // 1. Sistema en oscuro, nada guardado: la app abre en oscuro.
    const dark = await openApp(browser, { colorScheme: 'dark' });
    const page = dark.page;
    const first = await state(page);
    check(first.mode === 'dark' && first.pref === 'auto', 'el sistema oscuro abre la app en oscuro', JSON.stringify(first));
    check(luminance(first.bg) < 0.25, 'el fondo de la pagina es oscuro', first.bg);
    check(luminance(first.color) > 0.6, 'el texto es claro', first.color);
    check(luminance(first.composer) < 0.3, 'el compositor no se queda blanco', first.composer);
    check(String(first.meta).toLowerCase() === '#171713', 'theme-color acompana al tema', first.meta);
    await page.screenshot({ path: SCRATCH + '/theme-dark.png' });

    // 2. El control vive en el menu + y no cierra el menu al tocarlo.
    await page.click('#plus-btn');
    await page.waitForSelector('#plus-theme');
    const checked = await page.getAttribute('#plus-theme [data-theme-pref="auto"]', 'aria-checked');
    check(checked === 'true', 'Auto viene marcado en el menu +', String(checked));
    await page.screenshot({ path: SCRATCH + '/theme-plus-menu.png' });

    // 3. Claro: se fija, se ve en el acto y sigue abierto el menu.
    await page.click('#plus-theme [data-theme-pref="light"]');
    await page.waitForTimeout(350);
    const light = await state(page);
    check(light.mode === 'light' && light.pref === 'light', 'Claro fija el tema claro', JSON.stringify(light));
    check(luminance(light.bg) > 0.7, 'el fondo vuelve a ser claro', light.bg);
    check(light.stored === 'light', 'la eleccion se guarda', String(light.stored));
    const stillOpen = await page.evaluate(() => !document.getElementById('plus-menu').classList.contains('hidden'));
    check(stillOpen, 'el menu + sigue abierto despues de elegir');

    // 4. Al recargar se recuerda, aunque el sistema siga en oscuro.
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(600);
    const reloaded = await state(page);
    check(reloaded.mode === 'light' && reloaded.pref === 'light', 'al recargar se mantiene Claro', JSON.stringify(reloaded));

    // 5. Auto vuelve a seguir al sistema, y lo sigue en caliente.
    await pick(page, 'auto');
    const auto = await state(page);
    check(auto.mode === 'dark' && auto.pref === 'auto', 'Auto vuelve al tema del sistema', JSON.stringify(auto));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(350);
    const switched = await state(page);
    check(switched.mode === 'light', 'Auto cambia si el sistema cambia con la app abierta', JSON.stringify(switched));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(350);
    const back = await state(page);
    check(back.mode === 'dark', 'y vuelve al oscuro', JSON.stringify(back));

    check(dark.errors.length === 0, 'sin errores de JavaScript', dark.errors.slice(0, 2).join(' | '));
    await dark.context.close();

    // 6. Sistema en claro: la app sigue clara por defecto.
    const lightCtx = await openApp(browser, { colorScheme: 'light' });
    const clear = await state(lightCtx.page);
    check(clear.mode === 'light' && clear.pref === 'auto', 'el sistema claro abre la app clara', JSON.stringify(clear));
    check(luminance(clear.bg) > 0.7, 'el fondo claro de siempre no cambia', clear.bg);
    check(lightCtx.errors.length === 0, 'sin errores de JavaScript en claro', lightCtx.errors.slice(0, 2).join(' | '));
    await lightCtx.context.close();
  } finally {
    await browser.close();
  }
  console.log(failures ? failures + ' FAIL' : 'theme: all PASS');
  process.exit(failures ? 1 : 0);
})();
