import { pipeline, env } from './vendor/transformers/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers/', import.meta.url).href;
const models = {
  base: ['Xenova/whisper-base', '64da57285918e20ea79ea5c88eed7197933abaa8'],
  tiny: ['Xenova/whisper-tiny', '5332fcc35e32a33b86612b9a57a89be7906102b1'],
  small: ['Xenova/whisper-small', '2d67713f236afa48a18992566e7647f6ca848e13']
};
self.onmessage = async ({ data }) => {
  try {
    const [model, revision] = models[data.model] || models.base;
    let lastProgress = '', lastAt = 0;
    const progress = text => {
      if (text === lastProgress || (text.startsWith('Descargando') && performance.now() - lastAt < 250)) return;
      lastProgress = text; lastAt = performance.now();
      self.postMessage({ type: 'progress', text });
    };
    progress('Cargando Whisper en el dispositivo…');
    const transcriber = await pipeline('automatic-speech-recognition', model, {
      device: 'wasm', dtype: 'q8', revision,
      progress_callback(event) {
        if (event.status === 'progress') progress(`Descargando modelo · ${Math.round(event.progress || 0)} % del archivo`);
      }
    });
    progress('Transcribiendo en este dispositivo…');
    const result = await transcriber(data.audio, {
      language: data.language || undefined, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5,
      return_timestamps: false
    });
    self.postMessage({ type: 'result', text: result.text });
    await transcriber.dispose();
  } catch (error) { console.warn('Whisper local:', error.message); self.postMessage({ type: 'error' }); }
};
