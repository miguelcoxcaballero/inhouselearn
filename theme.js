/* ─── Modo noche de inhouse learn (theme.js) ─────────────────────────────
   Tres estados en localStorage (`inhouselearn.theme`):
     «auto»  sigue al sistema (prefers-color-scheme), también si el móvil
             cambia de tema con la app abierta,
     «light» / «dark»  lo fijan para siempre.
   El CSS (theme.css) solo mira el atributo data-theme de <html>, y las
   vistas de visuals.js leen el mismo atributo para dibujar los diagramas
   de mermaid en el tema que toca. Se carga en el <head>, antes de la
   primera pintura, para que al abrir en oscuro no haya un destello claro.
   El control vive en el menú «+» ([data-theme-pref]); el resto de la app
   no necesita saber nada. */
(function () {
  'use strict';
  var KEY = 'inhouselearn.theme';
  var META = { light: '#f5f5f0', dark: '#171713' };
  var HINT = { auto: 'Sigue al sistema', light: 'Siempre claro', dark: 'Siempre oscuro' };
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var pref = read();
  var mode = '';

  function read() {
    try {
      var saved = localStorage.getItem(KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'auto';
    } catch (error) { return 'auto'; }
  }
  function systemDark() { return !!(media && media.matches); }
  function resolve(value) {
    if (value === 'dark' || value === 'light') return value;
    return systemDark() ? 'dark' : 'light';
  }

  function syncControls() {
    var buttons = document.querySelectorAll('[data-theme-pref]');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-theme-pref') === pref;
      buttons[i].setAttribute('aria-checked', on ? 'true' : 'false');
      buttons[i].setAttribute('tabindex', on ? '0' : '-1');
    }
    var hint = document.getElementById('theme-hint');
    if (hint) hint.textContent = HINT[pref] + (pref === 'auto' ? (systemDark() ? ' · oscuro' : ' · claro') : '');
  }

  function paint(announce) {
    var next = resolve(pref);
    var changed = next !== mode;
    mode = next;
    root.setAttribute('data-theme', next);
    root.setAttribute('data-theme-pref', pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', META[next]);
    syncControls();
    if (!changed || !announce) return;
    root.classList.add('theme-switching');
    window.setTimeout(function () { root.classList.remove('theme-switching'); }, 320);
    try { document.dispatchEvent(new CustomEvent('themechange', { detail: { mode: mode, pref: pref } })); } catch (error) {}
  }

  function set(value) {
    pref = value === 'light' || value === 'dark' ? value : 'auto';
    try { localStorage.setItem(KEY, pref); } catch (error) {}
    paint(true);
  }

  // Antes de la primera pintura: el CSS ya sabe qué tema toca.
  paint(false);

  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-theme-pref]') : null;
    if (button) set(button.getAttribute('data-theme-pref'));
  });

  // Las flechas mueven entre Auto, Claro y Oscuro, como un grupo de opciones.
  document.addEventListener('keydown', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('.plus-theme-option') : null;
    if (!button) return;
    var order = ['auto', 'light', 'dark'];
    var step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    var index = Math.max(0, order.indexOf(button.getAttribute('data-theme-pref')));
    var next = order[(index + step + order.length) % order.length];
    set(next);
    var focus = document.querySelector('[data-theme-pref="' + next + '"]');
    if (focus) focus.focus();
  });

  // En «Auto», el móvil puede entrar en modo oscuro mientras la app está abierta.
  if (media) {
    var onSystemChange = function () { paint(true); };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  // El control se monta aquí, como la sección de aprobación (approval.js),
  // para no repetir el marcado del menú «+» en index.html.
  function mountControl() {
    if (document.getElementById('plus-theme')) return;
    var menu = document.getElementById('plus-menu');
    if (!menu) return;
    var box = document.createElement('div');
    box.className = 'plus-theme';
    box.id = 'plus-theme';
    box.innerHTML =
      '<div class="plus-theme-head">' +
        '<span class="plus-theme-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></span>' +
        '<span class="plus-theme-title">Modo noche<small id="theme-hint">' + HINT[pref] + '</small></span>' +
      '</div>' +
      '<div class="plus-theme-options" role="radiogroup" aria-label="Modo noche">' +
        '<button class="plus-theme-option" type="button" role="radio" data-theme-pref="auto">Auto</button>' +
        '<button class="plus-theme-option" type="button" role="radio" data-theme-pref="light">Claro</button>' +
        '<button class="plus-theme-option" type="button" role="radio" data-theme-pref="dark">Oscuro</button>' +
      '</div>';
    menu.appendChild(box);
    syncControls();
  }

  function boot() { mountControl(); syncControls(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.inhouseTheme = {
    get preference() { return pref; },
    get mode() { return mode; },
    set: set,
    refresh: function () { paint(false); }
  };
})();
