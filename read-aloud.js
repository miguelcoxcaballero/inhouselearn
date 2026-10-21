import { detectLanguage } from './vendor/inhouse-read/language-detect.js';
import { SUPERTONIC_LANGUAGES, SUPERTONIC_STYLES, supertonicVoiceName } from './vendor/inhouse-read/neural-voice/supertonic-catalog.js';

const KEY = 'inhouseLearn.readAloud.v1';
let preferences = { voices: { es: 'F2', en: 'F5' }, language: '', rate: 1, ready: false };
try { const saved = JSON.parse(localStorage.getItem(KEY)); if (saved) preferences = { ...preferences, ...saved, voices: { ...preferences.voices, ...saved.voices } }; } catch (_) {}
let session, pendingText;
const bar = document.createElement('div');
bar.className = 'read-aloud-bar'; bar.hidden = true;
bar.innerHTML = '<span class="read-aloud-status" role="status" aria-live="polite"></span><button type="button" data-read="pause">Pausar</button><button type="button" data-read="settings">Voces</button><button type="button" data-read="stop" aria-label="Detener lectura">Cerrar</button>';
document.querySelector('.composer-inner').prepend(bar);
const status = bar.querySelector('[role=status]'), pause = bar.querySelector('[data-read=pause]');
const dialog = document.createElement('dialog'); dialog.className = 'voice-menu'; dialog.id = 'read-aloud-settings'; dialog.setAttribute('aria-labelledby', 'read-aloud-title');
dialog.innerHTML = `<form>
  <header class="voice-menu-head"><div><h2 id="read-aloud-title">Voces de lectura</h2><p>Inhouse Read · Gratis, en tu dispositivo</p></div><button type="button" class="voice-menu-close" data-read="close" aria-label="Cerrar ajustes de voz" title="Cerrar"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
  <label class="voice-menu-row"><span>Idioma del texto</span><select name="language" title="Detectar el idioma automáticamente en cada frase"><option value="">Automático</option></select></label>
  <label class="voice-menu-row"><span>Velocidad</span><select name="rate"><option value="0.8">0,8×</option><option value="1">1×</option><option value="1.2">1,2×</option><option value="1.5">1,5×</option></select></label>
  <label class="voice-menu-row"><span>Voces para</span><select name="voice-language"></select></label>
  <div class="voice-menu-options" role="group" aria-label="Voz para el idioma seleccionado"></div>
  <p class="voice-menu-note">Primera descarga: 225 MB. Después se reutiliza. La velocidad depende del dispositivo.</p>
  <p class="voice-menu-error" data-read="error" role="alert"></p>
  <footer class="voice-menu-foot"><a href="vendor/inhouse-read/licenses/supertonic3-OpenRAIL-M.txt" target="_blank" rel="noopener">Licencia · Supertone</a><button type="submit" class="btn btn-primary btn-sm">Guardar</button></footer>
</form>`;
document.body.append(dialog);
const language = dialog.querySelector('[name=language]'), voiceLanguage = dialog.querySelector('[name=voice-language]'), voiceList = dialog.querySelector('.voice-menu-options'), rate = dialog.querySelector('[name=rate]');
const names = new Intl.DisplayNames(['es'], { type: 'language' });
for (const lang of [...SUPERTONIC_LANGUAGES].sort((a, b) => names.of(a).localeCompare(names.of(b)))) {
  for (const select of [language, voiceLanguage]) { const option = new Option(names.of(lang), lang); select.add(option); }
}
let draftVoices;
function renderVoices() {
  voiceList.replaceChildren(...SUPERTONIC_STYLES.map(style => {
    const label = document.createElement('label'); label.className = 'voice-menu-option';
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'voice'; input.value = style;
    input.checked = style === (draftVoices[voiceLanguage.value] || 'F1');
    input.onchange = () => { if (input.checked) draftVoices[voiceLanguage.value] = style; };
    label.append(input, document.createTextNode(supertonicVoiceName(voiceLanguage.value, style)));
    return label;
  }));
}
function configure(text) {
  window.closeProfileMenu?.();
  window.closeModelMenu?.();
  pendingText = typeof text === 'string' ? text : null;
  draftVoices = { ...preferences.voices };
  language.value = preferences.language; voiceLanguage.value = 'es'; rate.value = String(preferences.rate); renderVoices();
  dialog.querySelector('[type=submit]').textContent = pendingText ? 'Activar y escuchar' : 'Guardar';
  dialog.showModal();
}
voiceLanguage.onchange = renderVoices;
dialog.querySelector('[data-read=close]').onclick = () => { pendingText = null; dialog.close(); };
dialog.querySelector('form').onsubmit = event => {
  event.preventDefault();
  const next = { ready: true, language: language.value, voices: draftVoices, rate: Number(rate.value) };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) { dialog.querySelector('[data-read=error]').textContent = 'No se pudo guardar la configuración.'; return; }
  preferences = next;
  const text = pendingText || session?.text; pendingText = null; dialog.close();
  if (text) play(text);
};
dialog.addEventListener('cancel', () => { pendingText = null; });
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    pendingText = null; dialog.close();
  }
});
function stop() {
  const s = session; session = null;
  s?.worker.terminate();
  s?.context.close().catch(() => {});
  bar.hidden = true;
}
function chunks(text) {
  const holder = document.createElement('div');
  // Use the app's existing Markdown renderer; read visible prose, not tool/code payloads.
  if (window.marked && window.DOMPurify) {
    holder.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text), { FORBID_TAGS: ['img', 'iframe', 'video', 'audio', 'source', 'object', 'embed', 'svg', 'math'] });
  } else holder.textContent = text;
  holder.querySelectorAll('pre,script,style,svg').forEach(node => node.remove());
  holder.querySelectorAll('p,li,h1,h2,h3,h4,br,blockquote,tr').forEach(node => node.append(document.createTextNode('\n')));
  const plain = (holder.textContent || text).replace(/https?:\/\/\S+/g, '').trim();
  const sentences = new Intl.Segmenter(preferences.language || 'es', { granularity: 'sentence' }).segment(plain);
  const result = [];
  let fallback = preferences.language || detectLanguage(plain.slice(0, 2000), 'es').split('-')[0];
  for (const { segment } of sentences) {
    const lang = preferences.language || detectLanguage(segment, fallback).split('-')[0];
    if (!SUPERTONIC_LANGUAGES.includes(lang)) throw new Error('Este idioma no está disponible en las voces de Inhouse Read. Elige un idioma en Voces.');
    fallback = lang;
    const limit = ['ja', 'ko'].includes(lang) ? 110 : 260;
    let rest = segment.trim();
    while (rest) {
      let end = rest.length <= limit ? rest.length : rest.lastIndexOf(' ', limit);
      if (end < limit / 3) end = Math.min(rest.length, limit);
      result.push({ text: rest.slice(0, end).trim(), lang, style: preferences.voices[lang] || 'F1', rate: preferences.rate });
      rest = rest.slice(end).trim();
    }
  }
  return result.filter(item => /\p{L}|\p{N}/u.test(item.text));
}
function play(text) {
  if (!preferences.ready) { configure(text); return; }
  stop(); window.InhouseDictation?.cancel();
  bar.hidden = false;
  try {
    const items = chunks(text);
    if (!items.length) { status.textContent = 'No hay texto para leer.'; return; }
    const context = new AudioContext({ latencyHint: 'playback' });
    context.resume().catch(() => {});
    const worker = new Worker('read-aloud-worker.js?v=20261021-voice1', { type: 'module' });
    const s = session = { text, items, context, worker, next: 0, done: 0, queued: 0, busy: false, started: false, paused: false, until: 0, ready: [] };
    pause.textContent = 'Pausar'; pause.disabled = false;
    status.textContent = 'Preparando las voces…';
    const pump = () => {
      if (session !== s || s.busy || s.next >= items.length || s.queued + s.ready.length >= 3) return;
      s.busy = true; worker.postMessage(items[s.next++]);
    };
    const schedule = () => {
      if (!s.started && s.ready.length < Math.min(2, items.length)) return;
      s.started = true;
      for (const data of s.ready.splice(0)) {
        const buffer = context.createBuffer(1, data.pcm.length, data.sampleRate); buffer.copyToChannel(data.pcm, 0);
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
        const when = Math.max(context.currentTime + 0.03, s.until);
        source.start(when); s.until = when + buffer.duration; s.queued++;
        source.onended = () => {
          source.disconnect();
          if (session !== s) return;
          s.queued--; s.done++;
          if (s.done === items.length) { stop(); return; }
          status.textContent = s.paused ? 'Lectura en pausa' : `Leyendo · ${s.done + 1}/${items.length}`;
          pump();
        };
      }
      status.textContent = s.paused ? 'Lectura en pausa' : `Leyendo · ${s.done + 1}/${items.length}`;
    };
    worker.onmessage = ({ data }) => {
      if (session !== s) return;
      if (data.type === 'progress') { if (!s.started) status.textContent = data.text; return; }
      if (data.type === 'error') { stop(); bar.hidden = false; pause.disabled = true; status.textContent = data.text; return; }
      s.busy = false; s.ready.push(data); schedule(); pump();
    };
    worker.onerror = event => { event.preventDefault(); if (session !== s) return; stop(); bar.hidden = false; pause.disabled = true; status.textContent = 'No se pudo cargar la voz. Comprueba la conexión y vuelve a pulsar Escuchar.'; };
    pump();
  } catch (error) { stop(); bar.hidden = false; pause.disabled = true; status.textContent = error.message; }
}
async function togglePause() {
  const s = session; if (!s) return;
  s.paused = !s.paused;
  if (s.paused) await s.context.suspend(); else await s.context.resume();
  if (session !== s) return;
  pause.textContent = s.paused ? 'Continuar' : 'Pausar'; status.textContent = s.paused ? 'Lectura en pausa' : `Leyendo · ${s.done + 1}/${s.items.length}`;
}
pause.onclick = () => togglePause().catch(() => {});
bar.querySelector('[data-read=stop]').onclick = stop;
bar.querySelector('[data-read=settings]').onclick = () => configure();
document.getElementById('read-aloud-settings-btn').onclick = () => configure();
window.addEventListener('pagehide', stop);
window.InhouseReadAloud = { play, stop, configure,
  suspend: () => { if (session && !session.paused) togglePause().catch(() => {}); },
  back: () => { if (!dialog.open) return false; pendingText = null; dialog.close(); return true; }
};
