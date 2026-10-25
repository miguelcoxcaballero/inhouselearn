// Short hints the engine adds to tool results so the model recovers from
// failures and checks its own work, instead of repeating a broken call or
// declaring something finished without looking at it.
//
// Used as pi-agent-core's afterToolCall hook: it receives every finished call
// ({ toolCall, args, result, isError }) and may return a replacement content.
// A hint is a final text block that starts with NOTE_MARK, so the engine can
// keep it out of what the user sees (step.output) while the model reads it.
// One coach per run: its memory (failed calls, notes already given) is the turn's.

export const NOTE_MARK = '⁣nota:';

// Tools whose results the app owns (Guided Learning, plans, questions) or that
// are pure bookkeeping: a hint there would only confuse the model.
const SILENT = new Set(['set_course_plan', 'quiz', 'final_exam', 'check_diagram', 'think', 'update_plan', 'ask_user', 'submit_result']);

export const COACH_NOTES = {
  repeat: 'Esta misma llamada ya ha fallado con estos argumentos. No la repitas igual: cambia los argumentos, usa otra herramienta o explica qué te bloquea.',
  firstFailure: 'La herramienta ha fallado. Lee el error, corrige la causa y reintenta una vez; si no se puede, dilo en vez de suponer el resultado.',
  manyErrors: (n) => 'Llevas ' + n + ' errores de herramientas en este turno: para, resume lo que sabes y lo que falta.',
  webFetch: 'Prueba otra fuente de web_search en vez de insistir con esta página.',
  reviewDocument: 'Antes de decir que está listo, revísalo con doc_view.',
  testCode: 'Si es código, pruébalo con run_js.',
  checkCi: 'Si el repositorio tiene CI, mira github_ci_status antes de decir que funciona.'
};

// Same arguments in any key order → same key.
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}

const isNote = (block) => block && block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(NOTE_MARK);

/** Text blocks of a tool result without the coach's notes. */
export function withoutNotes(content) {
  return (Array.isArray(content) ? content : []).filter((block) => !isNote(block));
}

/**
 * createToolCoach() → afterToolCall(context) for pi's Agent.
 * The returned function also exposes .errors (tool errors so far in the run).
 */
export function createToolCoach() {
  const failed = new Set();
  const failedTools = new Set();
  const succeeded = new Set();
  let errors = 0;
  let warnedMany = false;

  const notesFor = (name, args, isError) => {
    const notes = [];
    if (isError) {
      errors++;
      const key = name + ' ' + stable(args || {});
      if (failed.has(key)) notes.push(COACH_NOTES.repeat);
      else if (!failedTools.has(name)) notes.push(COACH_NOTES.firstFailure);
      failed.add(key);
      failedTools.add(name);
      if (name === 'web_fetch') notes.push(COACH_NOTES.webFetch);
      if (errors >= 4 && !warnedMany) {
        warnedMany = true;
        notes.push(COACH_NOTES.manyErrors(errors));
      }
      return notes;
    }
    const once = (tag, note) => {
      if (succeeded.has(tag)) return;
      succeeded.add(tag);
      notes.push(note);
    };
    if (name === 'doc_edit' || name === 'latex_compile') once(name, COACH_NOTES.reviewDocument);
    else if ((name === 'write_file' || name === 'edit_file') && /\.(m?js|json)$/i.test(String((args && args.path) || ''))) once(name, COACH_NOTES.testCode);
    else if (name === 'github_write_files' || name === 'github_edit_file') once(name, COACH_NOTES.checkCi);
    return notes;
  };

  const afterToolCall = async (context) => {
    const name = context && context.toolCall && context.toolCall.name;
    if (!name || SILENT.has(name)) return undefined;
    const notes = notesFor(name, context.args != null ? context.args : context.toolCall.arguments, !!context.isError);
    if (!notes.length) return undefined;
    const content = (context.result && Array.isArray(context.result.content) ? context.result.content : []).concat([{ type: 'text', text: NOTE_MARK + ' ' + notes.join(' ') }]);
    return { content };
  };
  Object.defineProperty(afterToolCall, 'errors', { get: () => errors });
  return afterToolCall;
}
