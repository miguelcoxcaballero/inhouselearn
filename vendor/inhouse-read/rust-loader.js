// A separate owner and memory for each independently versioned Rust module.
export function createRustLoader(coreUrl, earlyKey, domain, onReady) {
  let core = null
  let compiledModule = null
  let loading = null
  let retryAfter = 0
  const FAILED_RETRY_DELAY_MS = 30_000

  const get = () => core

  /** Load once per JS realm. A worker has its own memory; the hashed Vite URL
   * is cached with the offline shell. Never delay the first shelf or a gesture
   * on a network request. Existing kernels cover unavailable/older WebViews. */
  function load({ bytes, module, fetcher = globalThis.fetch } = {}) {
    if (core) return Promise.resolve(core)
    if (loading) return loading
    // A transient offline request must not disable acceleration for the whole
    // session. Only a later caller retries, at most once every 30 seconds; no
    // timer, polling or user interaction waits for this recovery.
    if (Date.now() < retryAfter) return Promise.resolve(null)
    // The page can compile in parallel with the large app modules. Consume its
    // promise once; workers and explicit byte callers retain their own instance.
    const early = !bytes && !module && fetcher === globalThis.fetch ? globalThis[earlyKey] : null
    if (early) delete globalThis[earlyKey]
    loading = (async () => {
      if (typeof WebAssembly !== 'object') return null
      let result
      if (module) result = { module, instance:await WebAssembly.instantiate(module) }
      else if (bytes) result = await WebAssembly.instantiate(bytes)
      else if (early) {
        result = await early
        if (!result) throw new Error('Early Rust core unavailable')
      } else {
        const response = await fetcher(coreUrl)
        if (!response.ok) throw new Error(`Rust core HTTP ${response.status}`)
        // Some local servers serve WASM with a generic MIME type. Streaming
        // works on Pages; the byte path keeps those servers functional too.
        if (typeof WebAssembly.instantiateStreaming === 'function'
            && response.headers.get('content-type')?.trim().toLowerCase() === 'application/wasm') {
          result = await WebAssembly.instantiateStreaming(response)
        } else result = await WebAssembly.instantiate(await response.arrayBuffer())
      }
      const exports = (result.instance || result).exports
      if (exports.core_abi_version?.() !== 1 || exports.core_domain?.() !== domain || !(exports.memory instanceof WebAssembly.Memory)
          || typeof exports.alloc_f64 !== 'function' || typeof exports.free_f64 !== 'function') {
        throw new Error('Incompatible Rust core')
      }
      compiledModule = result.module || null
      core = exports
      // Optional owners adopt the same compiled instance synchronously. An
      // observer cannot invalidate compilation or introduce another Promise.
      try { onReady?.(core) } catch {}
      retryAfter = 0
      return core
    })().catch(() => {
      retryAfter = Date.now() + FAILED_RETRY_DELAY_MS
      return null
    }).finally(() => { loading = null })
    return loading
  }

  return {get, load, module:() => compiledModule}
}
