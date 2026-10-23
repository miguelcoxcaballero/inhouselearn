/* ─── Smooth streaming ───────────────────────────────────────────────
   An answer is markdown cut into top-level blocks (splitMarkdownBlocks).
   While it streams, every finished block is rendered once (math, LaTeX
   previews and visuals included) and never touched again; only the last,
   growing block is redrawn, at most once per animation frame. The text is
   revealed at a steady pace that follows the network (revealRate), math or
   a visual that is still arriving waits until it is complete instead of
   flashing as source, and the thread follows the answer only while the
   reader is at the bottom (threadFollow). The final render cuts the same
   blocks, so nothing moves when the answer ends.

   Loaded before the main script of index.html; uses its globals at call
   time (renderMarkdown, enhanceRichContent, renderReasoningMarkup…). */

const STREAM_FENCE_PLACEHOLDER = /^(visual|widget|viz|interactive|visualization|mermaid|plot|graph|formula|chart|flashcards|steps|timeline|compare|cards|check|match|order|categorize|fill|estimate|truefalse)$/i;

function isListStart(line) {
  return /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/.test(line || '');
}

// Top-level markdown blocks: split at blank lines, never inside a code fence
// or display math, and not before the indented continuation of a list item.
// A fence or a $$ block is its own block and is marked closed once it ends.
function splitMarkdownBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let buf = [];
  let fence = null;
  let math = '';
  const flush = (closed) => {
    if (buf.some((line) => line.trim())) blocks.push({ src: buf.join('\n'), closed: !!closed });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      buf.push(line);
      if (fence.close.test(line)) { fence = null; flush(true); }
      continue;
    }
    if (math) {
      buf.push(line);
      if (math === '$$' ? /\$\$/.test(line) : /\\\]/.test(line)) { math = ''; flush(true); }
      continue;
    }
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/);
    if (open) {
      flush();
      fence = { close: new RegExp('^\\s{0,3}' + (open[1][0] === '`' ? '`' : '~') + '{' + open[1].length + ',}\\s*$'), lang: open[2] };
      buf.push(line);
      continue;
    }
    if ((line.match(/\$\$/g) || []).length % 2 === 1) {
      flush();
      math = '$$';
      buf.push(line);
      continue;
    }
    if (/^\s*\\\[/.test(line) && !/\\\]/.test(line)) {
      flush();
      math = '\\[';
      buf.push(line);
      continue;
    }
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      // Nothing after the blank line yet: undecided, it stays with this block.
      if (j >= lines.length) { buf.push(line); continue; }
      const first = buf.find((item) => item.trim()) || '';
      if (/^\s{2,}\S/.test(lines[j]) && isListStart(first)) { buf.push(line); continue; }
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function renderMarkdownBlocks(text) {
  return splitMarkdownBlocks(text).map((block) => renderMarkdown(block.src)).join('');
}

// The growing last block, made safe to draw: math, links and visuals that are
// still arriving are held back, and an open ** or ` is closed for now.
function prepareStreamingTail(src) {
  let text = String(src || '');
  const fence = text.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/);
  if (fence) {
    return STREAM_FENCE_PLACEHOLDER.test(fence[2]) ? { placeholder: fence[2].toLowerCase() } : { text };
  }
  // A lone -, = or * on the last line would turn the paragraph into a heading or a rule.
  text = text.replace(/\n\s{0,3}[-=*+_]{1,2}\s*$/, '');
  const cut = (index) => { if (index >= 0) text = text.slice(0, index); };
  if ((text.match(/\$\$/g) || []).length % 2 === 1) cut(text.lastIndexOf('$$'));
  if (text.lastIndexOf('\\[') > text.lastIndexOf('\\]')) cut(text.lastIndexOf('\\['));
  if (text.lastIndexOf('\\(') > text.lastIndexOf('\\)')) cut(text.lastIndexOf('\\('));
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  const singles = [];
  lastLine.replace(/\\\$|\$\$|\$/g, (match, offset) => { if (match === '$') singles.push(offset); return match; });
  if (singles.length % 2 === 1) {
    const at = singles[singles.length - 1];
    if (/^\$[^\s\d]/.test(lastLine.slice(at))) cut(text.length - lastLine.length + at);
  }
  text = text.replace(/\[([^\]\n]*)\]\([^)\s]*$/, '$1');
  text = text.replace(/[*_`]+$/, '');
  // Half-arrived syntax: a lone backslash, or a list number with nothing after it yet.
  text = text.replace(/\\+$/, '').replace(/(^|\n)\s{0,3}\d{1,3}[.)]?\s*$/, '$1');
  const code = text.replace(/```[\s\S]*?```/g, '');
  if ((code.match(/`/g) || []).length % 2 === 1) text += '`';
  const plain = text.replace(/`[^`]*`/g, '');
  if ((plain.match(/\*\*/g) || []).length % 2 === 1) text += '**';
  return { text };
}

/* ─── Following the thread ───────────────────────────────────────────── */

const threadFollow = { pinned: true, userAt: 0, wrap: null, jump: null };

function threadNearBottom(wrap) {
  return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 56;
}

function initThreadFollow() {
  const wrap = document.querySelector('.thread-wrap');
  if (!wrap || threadFollow.wrap) return;
  threadFollow.wrap = wrap;
  const mark = () => { threadFollow.userAt = performance.now(); };
  ['wheel', 'touchstart', 'touchmove', 'pointerdown'].forEach((type) => wrap.addEventListener(type, mark, { passive: true }));
  document.addEventListener('keydown', (event) => {
    if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(event.key) && !/input|textarea/i.test(document.activeElement && document.activeElement.tagName)) mark();
  });
  wrap.addEventListener('scroll', () => {
    const near = threadNearBottom(wrap);
    if (near) threadFollow.pinned = true;
    else if (performance.now() - threadFollow.userAt < 900) threadFollow.pinned = false;
    syncThreadJump();
  }, { passive: true });
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'thread-jump';
  jump.setAttribute('aria-label', 'Ir al final');
  jump.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg>';
  jump.addEventListener('click', () => {
    threadFollow.pinned = true;
    wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
  });
  const area = document.querySelector('.composer-area');
  if (area) area.appendChild(jump);
  threadFollow.jump = jump;
}

function syncThreadJump() {
  const { wrap, jump } = threadFollow;
  if (!wrap || !jump) return;
  jump.classList.toggle('show', !threadNearBottom(wrap) && wrap.scrollHeight > wrap.clientHeight + 200);
}

// Keep the end of the answer in view, only while the reader has not scrolled up.
function followThread() {
  const wrap = threadFollow.wrap;
  if (!wrap) return;
  if (typeof guidedStageActive === 'function' && guidedStageActive()) return;
  if (threadFollow.pinned) wrap.scrollTop = wrap.scrollHeight;
  syncThreadJump();
}

/* ─── A streaming answer ─────────────────────────────────────────────── */

// Characters per second: a steady follower of what has arrived (about a
// quarter of a second behind), much faster once the answer is complete.
function revealRate(backlog, done) {
  return done ? 700 + backlog * 9 : 40 + backlog * 3.4;
}

function renderBlockNodes(src, options) {
  const holder = document.createElement('div');
  holder.innerHTML = renderMarkdown(src);
  enhanceRichContent(holder, { renderMath: true, latexPreview: !!options.final, msgId: options.msgId });
  return Array.from(holder.childNodes);
}

function visualPlaceholderNodes(kind) {
  const holder = document.createElement('div');
  holder.innerHTML = '<div class="viz viz-wait"><span class="viz-wait-icon"></span><span>' +
    (kind === 'mermaid' ? 'Dibujando el diagrama…' : 'Preparando la vista interactiva…') + '</span></div>';
  return Array.from(holder.childNodes);
}

function placeCaret(nodes) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.nodeType !== 1) { if (String(node.textContent || '').trim()) return; continue; }
    if (/^(PRE|TABLE|HR|DIV)$/.test(node.tagName)) return;
    let target = node;
    while (target.lastElementChild && /^(UL|OL|LI|BLOCKQUOTE)$/.test(target.lastElementChild.tagName)) target = target.lastElementChild;
    if (target.lastElementChild && /^(P)$/.test(target.lastElementChild.tagName)) target = target.lastElementChild;
    const caret = document.createElement('span');
    caret.className = 'stream-caret';
    target.appendChild(caret);
    return;
  }
}

class StreamView {
  constructor(message, articleEl) {
    this.message = message;
    this.article = articleEl;
    this.target = '';
    this.shown = 0;
    this.done = false;
    this.raf = 0;
    this.lastFrame = 0;
    this.committed = [];
    this.tailNodes = [];
    this.tailKey = null;
    this.tailSrc = null;
    this.renderedText = null;
    this.thinkingAt = 0;
    this.thinkingShown = '';
    this.stepsKey = '';
    this.cardsKey = '';
    this.finishWaiters = [];
    this.mdRoot = articleEl.querySelector('.md-root');
    this.anchor = document.createComment('tail');
    this.mdRoot.innerHTML = '';
    this.mdRoot.appendChild(this.anchor);
    this.setTail(this.typingNodes(), 'typing');
  }

  attached() {
    return this.article.isConnected;
  }

  push(update) {
    if (typeof update.text === 'string' && update.text !== this.target) {
      if (!update.text.startsWith(this.target)) this.shown = Math.min(this.shown, update.text.length);
      this.target = update.text;
      // An answer from another device comes in bursts (Drive: every ~0.5 s):
      // learn the rhythm so each burst is spread until the next one is due.
      if (this.remote) {
        const now = performance.now();
        if (this.arrivedAt) {
          const gap = Math.min(1500, now - this.arrivedAt);
          this.gap = this.gap ? this.gap * 0.7 + gap * 0.3 : gap;
        }
        this.arrivedAt = now;
      }
    }
    this.schedule();
  }

  finish(finalText) {
    if (typeof finalText === 'string') {
      const shown = this.target.slice(0, Math.floor(this.shown));
      let same = 0;
      while (same < shown.length && shown[same] === finalText[same]) same++;
      this.shown = Math.min(this.shown, same);
      this.target = finalText;
    }
    this.done = true;
    // A hidden tab has no animation frames: draw the end at once.
    if (document.hidden || !this.attached()) this.shown = this.target.length;
    this.schedule();
    return new Promise((resolve) => {
      this.finishWaiters.push(resolve);
      window.setTimeout(() => { this.shown = this.target.length; this.frame(performance.now()); }, 2500);
    });
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.finishWaiters.splice(0).forEach((resolve) => resolve());
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame((now) => { this.raf = 0; this.frame(now); });
  }

  frame(now) {
    if (!this.attached()) { this.stop(); return; }
    const dt = Math.min(64, Math.max(0, now - (this.lastFrame || now - 16)));
    this.lastFrame = now;
    const length = this.target.length;
    if (this.shown < length) {
      const backlog = length - this.shown;
      let step = Math.max(1, revealRate(backlog, this.done) * dt / 1000);
      if (this.remote && !this.done && this.gap > 120) {
        // Finish this burst a little after the next one is due, at an even pace.
        const left = Math.max(dt, this.arrivedAt + this.gap * 1.25 - now);
        step = backlog * Math.min(1, dt / left);
      }
      this.shown = Math.min(length, this.shown + step);
    }
    this.renderSide();
    const visibleLength = Math.floor(this.shown);
    // A soft, steady texture while words appear (throttled in haptic()).
    if (visibleLength > (this.hapticAt || 0) + 2) { this.hapticAt = visibleLength; haptic('tick'); }
    this.renderText(this.target.slice(0, visibleLength), this.done && this.shown >= length);
    followThread();
    if (this.shown < this.target.length) { this.schedule(); return; }
    if (this.done) this.finishWaiters.splice(0).forEach((resolve) => resolve());
  }

  renderText(visible, complete) {
    if (visible === this.renderedText && !complete) return;
    if (!visible.trim()) {
      if (this.tailKey !== 'typing' && !complete) this.setTail(this.typingNodes(), 'typing');
      if (complete) this.setTail([], '');
      this.renderedText = visible;
      return;
    }
    const blocks = splitMarkdownBlocks(visible);
    let commitCount = blocks.length - 1;
    if (complete || (blocks.length && blocks[blocks.length - 1].closed)) commitCount = blocks.length;
    let keep = 0;
    while (keep < this.committed.length && keep < commitCount && this.committed[keep].src === blocks[keep].src) keep++;
    for (let i = this.committed.length - 1; i >= keep; i--) this.committed[i].nodes.forEach((node) => node.remove());
    this.committed.length = keep;
    for (let i = keep; i < commitCount; i++) {
      const nodes = renderBlockNodes(blocks[i].src, { final: true, msgId: this.message.id });
      nodes.forEach((node) => {
        if (node.classList && node.classList.contains('viz')) node.classList.add('appear');
        this.mdRoot.insertBefore(node, this.anchor);
      });
      this.committed.push({ src: blocks[i].src, nodes });
    }
    if (commitCount >= blocks.length) {
      this.setTail([], '');
    } else {
      const tail = blocks[blocks.length - 1].src;
      if (tail !== this.tailSrc) {
        const prepared = prepareStreamingTail(tail);
        if (prepared.placeholder) {
          // One steady placeholder while a visual arrives, not a new one per frame.
          if (this.tailKey !== 'wait:' + prepared.placeholder) this.setTail(visualPlaceholderNodes(prepared.placeholder), 'wait:' + prepared.placeholder);
        } else {
          const nodes = prepared.text.trim() ? renderBlockNodes(prepared.text, { final: false, msgId: this.message.id }) : [];
          placeCaret(nodes);
          this.setTail(nodes, 'text');
        }
        this.tailSrc = tail;
      }
    }
    this.renderedText = visible;
  }

  typingNodes() {
    const holder = document.createElement('div');
    holder.innerHTML = assistantTypingMarkup();
    return Array.from(holder.childNodes);
  }

  setTail(nodes, key) {
    this.tailNodes.forEach((node) => node.remove());
    this.tailNodes = nodes;
    // Finished blocks sit before the anchor, the growing one after it.
    let ref = this.anchor;
    nodes.forEach((node) => { ref.after(node); ref = node; });
    this.tailKey = key;
    this.tailSrc = null;
  }

  renderSide() {
    const message = this.message;
    // Reasoning: redrawn a few times per second, in place.
    const thinking = typeof message.thinking === 'string' ? message.thinking : '';
    const slot = this.article.querySelector('.slot-reasoning');
    if (slot && thinking !== this.thinkingShown && (performance.now() - this.thinkingAt > 140 || !this.thinkingShown)) {
      this.thinkingAt = performance.now();
      this.thinkingShown = thinking;
      const hasText = !!this.target.trim();
      let body = slot.querySelector('.reasoning-body');
      if (!body && thinking) {
        slot.innerHTML = renderReasoningMarkup(message, thinking, !hasText);
        bindThreadActions(slot);
        body = slot.querySelector('.reasoning-body');
      } else if (body) {
        const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
        body.innerHTML = renderMarkdown(thinking);
        if (atEnd) body.scrollTop = body.scrollHeight;
      }
    }
    const details = slot && slot.querySelector('details.reasoning');
    if (details && this.target.trim() && !details.dataset.autoClosed) {
      details.dataset.autoClosed = '1';
      let stored = null;
      try { stored = sessionStorage.getItem('reasoning::' + message.id); } catch (_) {}
      if (stored === null) details.open = false;
      const label = details.querySelector('.reasoning-summary span:last-child');
      if (label) label.textContent = 'Razonamiento';
    }
    // Tool steps: only when a step starts, ends or prints.
    const steps = Array.isArray(message.toolSteps) ? message.toolSteps : [];
    const stepsKey = steps.map((step) => step.id + step.status + (step.output ? step.output.length : 0)).join('|') + (this.target.trim() ? '|writing' : '');
    if (stepsKey !== this.stepsKey) {
      this.stepsKey = stepsKey;
      const stepsSlot = this.article.querySelector('.slot-steps');
      if (stepsSlot) {
        stepsSlot.innerHTML = visibleToolSteps(message).length ? renderToolStepsMarkup(message) : '';
        bindThreadActions(stepsSlot);
      }
    }
    // Course cards (plan, quiz, exam) appear as soon as their tool runs.
    const cards = message.guidedCards || [];
    const cardsKey = cards.map((card) => card.type + (card.quizId || '')).join('|');
    if (cardsKey !== this.cardsKey) {
      this.cardsKey = cardsKey;
      const cardsSlot = this.article.querySelector('.slot-cards');
      const chat = getActiveChat();
      if (cardsSlot && chat) {
        cardsSlot.innerHTML = renderGuidedCards(message, chat);
        cardsSlot.querySelectorAll('.g-card').forEach((card) => card.classList.add('appear'));
        refreshGuidedCardSlots(chat, message.id);
        enhanceRichContent(cardsSlot, { renderMath: true, latexPreview: false });
        syncGuidedBannerSlot(chat);
      }
    }
  }
}

// Live views by message id, so the end of a turn can reuse what is on screen.
const streamViews = new Map();

function streamViewFor(message) {
  const existing = streamViews.get(message.id);
  if (existing && existing.attached()) return existing;
  const article = findMessageElement(message.id);
  if (!article || !article.querySelector('.md-root')) return null;
  const view = new StreamView(message, article);
  // The thread was redrawn mid-answer (chat switch, Drive sync…): carry on
  // from what was already on screen instead of typing it all again.
  if (existing) {
    view.target = existing.target;
    view.shown = existing.shown;
    view.done = existing.done;
    view.remote = existing.remote;
    view.gap = existing.gap;
    view.arrivedAt = existing.arrivedAt;
    // The new element was drawn with the text as it is now (it may have grown
    // while this chat was not on screen): never type it again.
    const current = typeof message.content === 'string' ? message.content : '';
    if (current.length > view.target.length && current.startsWith(view.target)) view.target = current;
    view.shown = Math.max(existing.shown, Math.min(view.target.length, current.length));
    view.finishWaiters = existing.finishWaiters;
    existing.finishWaiters = [];
    existing.stop();
    view.schedule();
  }
  streamViews.set(message.id, view);
  return view;
}

function dropStreamView(message) {
  const view = streamViews.get(message.id);
  if (view) view.stop();
  streamViews.delete(message.id);
  return view || null;
}
