// Keeping a long turn inside the model's context window.
//
// A turn with many tool rounds (reading files, web pages, library pages,
// screenshots) can grow past what the model accepts, and every request pays
// for everything that came before. Old tool results are rarely needed word
// for word once the model has acted on them, so before each request the
// engine trims them: the newest rounds stay intact, older results keep their
// head and tail with a marker that says how to get the rest back, and older
// pictures become a short line. Nothing is removed and every toolCall keeps
// its toolResult, so providers still accept the transcript.
//
// The function is pure (it never mutates its input), deterministic and
// idempotent: aging an already aged transcript with the same options returns
// the same content.

// Rough size of a picture in the context, in characters (≈1.6k tokens).
const IMAGE_CHARS = 6000;
const MIN_OLD_MAX = 400;
const MARKER_RE = /\n… \[recortado: \d+ de \d+ caracteres\./;

const blockChars = (block) => {
  if (!block || typeof block !== 'object') return 0;
  if (block.type === 'text') return String(block.text || '').length;
  if (block.type === 'thinking') return String(block.thinking || '').length;
  if (block.type === 'image') return IMAGE_CHARS;
  if (block.type === 'toolCall') return JSON.stringify(block.arguments || {}).length + String(block.name || '').length;
  return 0;
};

/** Estimated size of a transcript in characters (pictures count as IMAGE_CHARS). */
export function estimateContextChars(messages) {
  let total = 0;
  for (const message of messages || []) {
    if (!message) continue;
    if (typeof message.content === 'string') total += message.content.length;
    else if (Array.isArray(message.content)) for (const block of message.content) total += blockChars(block);
  }
  return total;
}

function marker(dropped, total, toolName) {
  return '\n… [recortado: ' + dropped + ' de ' + total + ' caracteres. Si lo necesitas, vuelve a llamar a ' + (toolName || 'la herramienta') + ' con los mismos argumentos]\n';
}

// Head 70% + marker + tail 30%, the whole thing no longer than max (so a
// second pass with the same max leaves it alone even without the marker check).
function trimText(text, max, toolName) {
  if (text.length <= max || MARKER_RE.test(text)) return text;
  // The marker's own length depends on the numbers; reserve the worst case.
  const room = Math.max(0, max - marker(text.length, text.length, toolName).length);
  const head = Math.floor(room * 0.7);
  const tail = room - head;
  const dropped = text.length - head - tail;
  return text.slice(0, head) + marker(dropped, text.length, toolName) + (tail ? text.slice(text.length - tail) : '');
}

function imagePlaceholder(toolName) {
  return '[imagen retirada para ahorrar contexto. Si la necesitas, vuelve a llamar a ' + (toolName || 'la herramienta') + ' con los mismos argumentos]';
}

// Index of the first message that belongs to the last `keepRounds` tool rounds
// (a round = an assistant message with tool calls and the results after it).
function protectedFrom(messages, keepRounds) {
  let rounds = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === 'assistant' && Array.isArray(message.content) && message.content.some((block) => block && block.type === 'toolCall')) {
      rounds++;
      if (rounds >= keepRounds) return i;
    }
  }
  return 0;
}

function agePass(messages, from, oldMax) {
  let changed = false;
  const out = messages.map((message, index) => {
    if (index >= from || !message || message.role !== 'toolResult' || !Array.isArray(message.content)) return message;
    let touched = false;
    const content = message.content.map((block) => {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        const text = trimText(block.text, oldMax, message.toolName);
        if (text !== block.text) { touched = true; return { ...block, text }; }
        return block;
      }
      if (block && block.type === 'image') {
        touched = true;
        return { type: 'text', text: imagePlaceholder(message.toolName) };
      }
      return block;
    });
    if (!touched) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}

/**
 * Trim old tool results.
 * opts: { keepRounds = 2 (newest tool rounds left intact), oldMax = 6000
 * (characters an old result keeps), budget (optional, characters: if given,
 * oldMax halves step by step down to 400 until the estimate fits) }.
 * Returns the same array when nothing changes, otherwise a new one with new
 * objects only for the messages that changed.
 */
export function ageToolResults(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const keepRounds = Math.max(1, Math.floor(Number(opts.keepRounds) || 2));
  let oldMax = Math.max(MIN_OLD_MAX, Math.floor(Number(opts.oldMax) || 6000));
  const budget = Number(opts.budget);
  const from = protectedFrom(list, keepRounds);
  let aged = agePass(list, from, oldMax);
  if (Number.isFinite(budget) && budget > 0) {
    // Each pass starts again from the input: a text cut once carries the
    // marker and is never cut a second time.
    while (estimateContextChars(aged) > budget && oldMax > MIN_OLD_MAX) {
      oldMax = Math.max(MIN_OLD_MAX, Math.floor(oldMax / 2));
      aged = agePass(list, from, oldMax);
    }
  }
  return aged;
}
