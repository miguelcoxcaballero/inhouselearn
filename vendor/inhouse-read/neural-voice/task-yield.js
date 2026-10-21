// Yield one real message task between inference segments. DOM/worker timers
// can be throttled after minutes with Android locked; microtasks alone would
// prevent cancellation messages from being handled. No polling or heartbeat.
let channel, sequence = 0
const pending = new Map()
export function yieldToMessages() {
  channel ||= new MessageChannel()
  channel.port1.onmessage ||= event => {
    const resolve = pending.get(event.data)
    if (!resolve) return
    pending.delete(event.data)
    if (!pending.size) channel.port1.unref?.() // Node tests; absent in browsers.
    resolve()
  }
  channel.port1.ref?.()
  const id = ++sequence
  return new Promise(resolve => { pending.set(id, resolve); channel.port2.postMessage(id) })
}
