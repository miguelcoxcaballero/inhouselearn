import { createRustLoader } from './rust-loader.js';
const loader = createRustLoader(new URL('./inhouse_read_voice.wasm', import.meta.url).href, '__inhouseVoiceReady', 2);
export const loadRustVoiceCore = loader.load;
export async function requireRustVoiceCore() {
  const core = await loader.load();
  if (!core) throw new Error('No se pudo cargar el motor de voz.');
  return core;
}
export function loadedRustVoiceCore() {
  const core = loader.get();
  if (!core) throw new Error('El motor de voz no está cargado.');
  return core;
}
