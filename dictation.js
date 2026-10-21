/* Whisper runs on-device in a worker. Audio never leaves this browser. */
(() => {
  'use strict';
  const KEY = 'inhouseLearn.dictation.v1';
  const MIC = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';
  let host, button, panel, label, review, retry, dialog, session = null, settings = {};
  function refresh() { host.refresh(); }
  function live(s) { return session === s && host.chatId() === s.chatId; }
  function release(s) {
    clearInterval(s.timer);
    s.stream?.getTracks().forEach(track => track.stop());
  }
  function cancel(message = '') {
    const s = session;
    session = null;
    if (s) {
      s.worker?.terminate();
      s.decodeContext?.close().catch(() => {});
      if (s.recorder?.state === 'recording') s.recorder.stop();
      release(s);
    }
    refresh();
    if (message) host.status(message);
  }
  function configure() {
    if (session && session.state !== 'error') return;
    dialog.querySelector('[name=model]').value = settings.model || 'base';
    dialog.querySelector('[name=language]').value = settings.language ?? 'es';
    dialog.showModal();
  }
  function fail(s, message) {
    if (!live(s)) return;
    s.decodeContext?.close().catch(() => {});
    s.decodeContext = null;
    release(s);
    if (s.blob) { s.state = 'error'; s.error = message; refresh(); }
    else cancel(message);
  }
  async function start() {
    if (session || host.busy()) return;
    const appVersion = navigator.userAgent.match(/InhouseLearnApp\/(\d+)\.(\d+)\.(\d+)/);
    if (appVersion && Number(appVersion[1]) === 1 && Number(appVersion[2]) === 0 && Number(appVersion[3]) < 3) {
      host.status('Actualiza la app a la versión 1.0.3 o posterior para permitir el micrófono (Perfil → Actualizaciones).');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      host.status('Este navegador no permite grabar audio. Usa Chrome o Safari actualizado, con HTTPS.'); return;
    }
    if (!settings.ready) { configure(); return; }
    window.InhouseReadAloud?.stop();
    const s = session = { chatId: host.chatId(), draft: host.composer.value, state: 'permission', chunks: [], bytes: 0 };
    host.status(''); refresh();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!live(s) || document.hidden) { stream.getTracks().forEach(track => track.stop()); if (live(s)) cancel(); return; }
      s.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      s.recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
      s.recorder.ondataavailable = event => {
        if (!live(s) || !event.data.size) return;
        s.chunks.push(event.data); s.bytes += event.data.size;
        if (s.bytes >= 24 * 1024 * 1024 && s.state === 'recording') stop(false);
      };
      s.recorder.onerror = () => { if (live(s)) cancel('No se pudo grabar el audio. Vuelve a intentarlo.'); };
      s.recorder.onstop = () => {
        release(s);
        if (!live(s)) return;
        s.blob = new Blob(s.chunks, { type: s.recorder.mimeType || s.chunks[0]?.type || 'audio/webm' });
        s.chunks = [];
        if (s.duration < 350 || s.blob.size < 100) { cancel('La grabación es demasiado corta. Pulsa el micrófono y habla.'); return; }
        if (s.blob.size > 25 * 1024 * 1024) { cancel('El audio es demasiado grande. Graba un mensaje más corto.'); return; }
        transcribe(s);
      };
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { if (live(s) && s.state === 'recording') stop(false); }));
      s.recorder.start(1000);
      s.started = performance.now(); s.state = 'recording';
      s.timer = setInterval(() => {
        if (!live(s)) { cancel(); return; }
        if (performance.now() - s.started >= 300000) stop(false);
        else syncUi();
      }, 250);
      refresh();
    } catch (error) {
      fail(s, error.name === 'NotAllowedError' ? 'Permite el micrófono en los ajustes de la app o del navegador y vuelve a intentarlo.' : 'No se puede acceder al micrófono. Comprueba que esté disponible.');
    }
  }
  function stop(send) {
    const s = session;
    if (!s || s.state !== 'recording') return;
    if (!live(s)) { cancel(); return; }
    s.send = send; s.duration = performance.now() - s.started; s.state = 'transcribing';
    clearInterval(s.timer);
    s.recorder.stop();
    release(s); refresh();
  }
  async function transcribe(s) {
    if (!live(s)) return;
    s.state = 'transcribing'; s.progress = 'Preparando audio…'; refresh();
    try {
      const context = s.decodeContext = new AudioContext({ sampleRate: 16000 });
      const decoded = await context.decodeAudioData(await s.blob.arrayBuffer());
      await context.close(); s.decodeContext = null;
      if (!live(s)) return;
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
      const audio = (await offline.startRendering()).getChannelData(0);
      if (!live(s)) return;
      let energy = 0;
      for (const sample of audio) energy += sample * sample;
      if (Math.sqrt(energy / audio.length) < 0.0001) { cancel('No se ha detectado voz. Prueba a grabar de nuevo.'); return; }
      const worker = s.worker = new Worker('dictation-worker.js?v=20261021-voice1', { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (!live(s)) return;
        if (data.type === 'progress') { s.progress = data.text; syncUi(); return; }
        worker.terminate(); s.worker = null;
        if (data.type === 'error') { fail(s, 'No se pudo cargar o ejecutar Whisper. Comprueba la conexión y el espacio disponible; puedes reintentar o usar el modelo ligero en los ajustes.'); return; }
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text) { cancel('No se ha reconocido voz. Prueba a grabar de nuevo.'); return; }
        host.composer.value = [s.draft.trim(), text].filter(Boolean).join('\n');
        session = null; s.blob = null;
        host.resize(); refresh();
        if (s.send) host.send();
        else { host.composer.focus(); host.status('Dictado listo. Puedes revisarlo y enviarlo.'); }
      };
      worker.onerror = event => { event.preventDefault(); worker.terminate(); s.worker = null; fail(s, 'No se pudo iniciar el reconocimiento. Comprueba la conexión y vuelve a intentarlo.'); };
      worker.postMessage({ audio, model: settings.model || 'base', language: settings.language || null }, [audio.buffer]);
    } catch (_) { fail(s, 'No se pudo procesar el audio. Puedes volver a intentarlo.'); }
  }
  function syncUi() {
    if (!host) return;
    if (session && !live(session)) { cancel(); return; }
    const s = session;
    button.disabled = host.busy() || !!s && s.state !== 'recording';
    button.classList.toggle('is-recording', s?.state === 'recording');
    button.setAttribute('aria-pressed', String(s?.state === 'recording'));
    button.setAttribute('aria-label', s?.state === 'recording' ? 'Terminar y revisar dictado' : 'Dictar con IA');
    panel.hidden = !s;
    host.composer.readOnly = !!s;
    if (!s) return;
    host.sendButton.disabled = s.state !== 'recording';
    host.sendButton.setAttribute('aria-label', 'Transcribir y enviar');
    host.sendLabel.textContent = 'Enviar';
    for (const id of ['attach-btn', 'file-input', 'guided-btn']) { const node = document.getElementById(id); if (node) node.disabled = true; }
    review.hidden = s.state !== 'recording'; retry.hidden = s.state !== 'error';
    panel.dataset.state = s.state;
    const seconds = Math.floor((performance.now() - (s.started || performance.now())) / 1000);
    const text = s.state === 'permission' ? 'Esperando permiso del micrófono…' : s.state === 'transcribing' ? (s.progress || 'Transcribiendo con IA…') : s.state === 'error' ? s.error : `Grabando · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · Habla con naturalidad`;
    if (label.textContent !== text) label.textContent = text;
  }
  window.InhouseDictation = {
    init(options) {
      host = options;
      try { settings = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) {}
      button = document.createElement('button'); button.type = 'button'; button.id = 'dictation-btn'; button.className = 'attach-btn dictation-btn'; button.innerHTML = MIC; button.title = 'Dictar con IA';
      host.sendButton.after(button);
      panel = document.createElement('div'); panel.className = 'dictation-panel'; panel.id = 'dictation-panel'; panel.hidden = true;
      panel.innerHTML = '<span class="dictation-indicator" aria-hidden="true"></span><span class="dictation-label" role="status" aria-live="polite"></span><div class="dictation-actions"><button type="button" data-voice="cancel">Cancelar</button><button type="button" data-voice="retry" hidden>Reintentar</button><button type="button" data-voice="review">Revisar</button></div>';
      host.composer.before(panel); label = panel.querySelector('.dictation-label'); review = panel.querySelector('[data-voice=review]'); retry = panel.querySelector('[data-voice=retry]');
      panel.querySelector('[data-voice=cancel]').onclick = () => cancel(); review.onclick = () => stop(false); retry.onclick = () => session && transcribe(session);
      button.onclick = () => session ? stop(false) : start();
      dialog = document.createElement('dialog'); dialog.id = 'dictation-settings'; dialog.className = 'dictation-settings'; dialog.setAttribute('aria-labelledby', 'dictation-title');
      dialog.innerHTML = '<form><h2 id="dictation-title">Dictado con IA</h2><p>Habla con naturalidad: Whisper convierte tu voz en texto dentro del dispositivo, gratis y sin cuenta. El audio no se envía a ningún servidor.</p><p>Pulsa el micrófono para grabar, Revisar para editar o la flecha para transcribir y enviar.</p><label>Modelo<select name="model"><option value="base">Equilibrado · unos 77 MB</option><option value="small">Más preciso · unos 250 MB</option><option value="tiny">Ligero · unos 42 MB</option></select></label><p>La primera vez se descarga el modelo de Hugging Face y el motor (unos 22 MB). Después se reutiliza la caché del navegador. La velocidad y precisión dependen del móvil y del modelo; el más preciso necesita más memoria.</p><label>Idioma<select name="language"><option value="es">Español</option><option value="">Detectar automáticamente</option><option value="en">English</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="pt">Português</option><option value="it">Italiano</option></select></label><p class="dictation-privacy">Máximo 5 minutos por mensaje. Puedes cancelar la descarga o transcripción en cualquier momento.</p><p data-voice="settings-error" role="alert"></p><div class="dictation-actions"><button type="button" data-voice="close">Cerrar</button><button type="submit">Activar dictado</button></div></form>';
      document.body.append(dialog);
      dialog.querySelector('[data-voice=close]').onclick = () => dialog.close();
      dialog.querySelector('form').onsubmit = event => {
        event.preventDefault();
        const next = { ready: true, model: dialog.querySelector('[name=model]').value, language: dialog.querySelector('[name=language]').value };
        try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) { dialog.querySelector('[data-voice=settings-error]').textContent = 'No se pudo guardar. Habilita el almacenamiento del navegador.'; return; }
        settings = next; dialog.close(); host.status('Dictado preparado. Pulsa el micrófono para empezar.');
      };
      document.getElementById('dictation-settings-btn')?.addEventListener('click', configure);
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.suspend(); });
      window.addEventListener('pagehide', () => cancel());
      refresh();
    },
    syncUi,
    handleSend() { if (!session) return false; stop(true); return true; },
    back() { if (dialog?.open) { dialog.close(); return true; } if (session) { cancel(); return true; } return false; },
    suspend() { if (session?.state === 'recording') stop(false); },
    cancel: () => host && cancel()
  };
})();
