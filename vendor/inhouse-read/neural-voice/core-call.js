// Calls into a raw-ABI Rust core (no imports, memory owned by the host): the arguments go into a fresh arena of `slots`
// eight-byte cells, `run(pointer)` calls the export and reads the result through views made AFTER the call (the memory may
// have grown), and the arena is always released, whatever happens inside.
export function withArena(core, slots, run) {
  const pointer = core.alloc_f64(slots)
  if (!pointer) throw new Error('Rust core: no memory for the call')
  try { return run(pointer) } finally { core.free_f64(pointer, slots) }
}

/** Eight-byte aligned byte offsets of consecutive regions of the given byte sizes, and the number of cells they take. */
export function layout(...sizes) {
  let end = 0
  const at = sizes.map(size => { const start = end; end += Math.ceil(size / 8) * 8; return start })
  return { at, cells: Math.max(1, end / 8) }
}

/** The string of a view of code points (lone surrogates stay as they are). */
export function textOf(codes) {
  const parts = []
  for (let i = 0; i < codes.length; i += 4096) parts.push(String.fromCodePoint(...codes.subarray(i, i + 4096)))
  return parts.join('')
}

/** Writes the UTF-16 code units of `text` at `pointer` (two-byte aligned). */
export function putText(core, pointer, text) {
  const units = new Uint16Array(core.memory.buffer, pointer, text.length)
  for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i)
}

/** The string made of the `count` UTF-16 code units at `pointer`. */
export function getText(core, pointer, count) {
  const units = new Uint16Array(core.memory.buffer, pointer, count), parts = []
  for (let i = 0; i < count; i += 8192) parts.push(String.fromCharCode.apply(null, units.subarray(i, i + 8192)))
  return parts.join('')
}
