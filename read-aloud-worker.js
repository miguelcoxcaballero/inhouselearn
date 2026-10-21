import * as ort from './vendor/inhouse-read/ort.wasm.min.mjs';
import { requireRustVoiceCore } from './vendor/inhouse-read/rust-voice-core.js';
import { createSupertonicRuntime } from './vendor/inhouse-read/neural-voice/supertonic-runtime.js';
import { finishSupertonic } from './vendor/inhouse-read/neural-voice/synth-flow.js';
import { SUPERTONIC_ASSETS, supertonicAssetUrl } from './vendor/inhouse-read/neural-voice/supertonic-catalog.js';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./vendor/inhouse-read/', import.meta.url).href;
let engine;
async function load() {
  await requireRustVoiceCore();
  const cache = await caches.open('inhouse-learn-supertonic3-v1');
  const buffers = {}, styles = {};
  let config, indexer, completed = 0;
  for (const asset of SUPERTONIC_ASSETS) {
    const url = supertonicAssetUrl(asset);
    let response = await cache.match(url);
    if (!response) {
      self.postMessage({ type: 'progress', text: `Descargando voces · ${Math.round(completed / 210204134 * 100)} %` });
      response = await fetch(url);
      if (!response.ok) throw new Error('No se pudieron descargar las voces.');
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== asset.bytes || digest !== asset.sha256) throw new Error('La descarga de voz está incompleta. Reintenta.');
      response = new Response(bytes);
      await cache.put(url, response.clone());
    }
    if (asset.path.endsWith('.onnx')) buffers[asset.path.split('/').pop().replace('.onnx', '')] = await response.arrayBuffer();
    else if (asset.path === 'onnx/tts.json') config = await response.json();
    else if (asset.path === 'onnx/unicode_indexer.json') indexer = await response.json();
    else if (asset.path.startsWith('voice_styles/')) styles[asset.path.split('/').pop().replace('.json', '')] = await response.json();
    completed += asset.bytes;
  }
  self.postMessage({ type: 'progress', text: 'Preparando las voces…' });
  return createSupertonicRuntime({ ort, buffers, styles, config, indexer });
}
self.onmessage = async ({ data }) => {
  try {
    engine ||= await load();
    self.postMessage({ type: 'progress', text: 'Preparando lectura…' });
    const result = await engine.synthesize(data.text, { lang: data.lang, style: data.style, rate: data.rate || 1 });
    const finished = finishSupertonic(result.pcm, data.text, result.marks || [], { sampleRate: result.sampleRate, rate: data.rate || 1 });
    if (!finished?.pcm.length) throw new Error('Audio vacío');
    self.postMessage({ type: 'audio', pcm: finished.pcm, sampleRate: result.sampleRate }, [finished.pcm.buffer]);
  } catch (_) {
    self.postMessage({ type: 'error', text: 'No se pudo preparar la voz. Comprueba la conexión, la memoria y el espacio disponible y vuelve a intentarlo.' });
  }
};
