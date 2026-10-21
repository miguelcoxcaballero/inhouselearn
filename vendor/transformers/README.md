# Local speech recognition

Transformers.js 3.7.2, Apache-2.0 (LICENSE), from the published npm dist files:
https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/

`transformers.min.js` and its matching `ort-wasm-simd-threaded.jsep.mjs`/`.wasm`
run Whisper in a dedicated worker. ONNX Runtime is MIT licensed:
https://github.com/microsoft/onnxruntime/blob/main/LICENSE

Whisper weights (MIT) download on first dictation from Xenova's Hugging Face
repositories and use the browser Cache API. No account, API key or audio upload.
