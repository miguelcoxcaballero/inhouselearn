// Piezas pequeñas que comparten los módulos de Ultra code (plan, informes,
// esfuerzo, política y ejecución). Sin dependencias: se prueban sin navegador.

export const MAX_AGENTS = 12;
export const MAX_PARALLEL = 6;
export const MIN_PARALLEL = 2;
export const DEFAULT_MINUTES = 10;
export const DEFAULT_BUDGET = 1;
// Tope de gasto de TODOS los spawn_agents de una misma respuesta (una respuesta
// puede lanzar varias rondas): la app lo pasa como ctx.turnBudget.
export const DEFAULT_TURN_BUDGET = 8;
export const MIN_BUDGET = 0.05;

export function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

export function clip(text, max, note) {
  const value = String(text == null ? '' : text);
  return value.length > max ? value.slice(0, max).replace(/\s+\S*$/, '') + (note || '…') : value;
}

export const money = (value) => '$' + (Number(value) || 0).toFixed(4);
export const quoteList = (names) => names.map((name) => '«' + name + '»').join(', ');

export function abortError(message) {
  const error = new Error(message || 'Detenido.');
  error.name = 'AbortError';
  return error;
}

export function slug(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

// Small glob → RegExp (*, **, ?), only to tell an agent that a path belongs to another.
export function globRegExp(glob) {
  let out = '';
  const text = String(glob || '').trim().replace(/^\.?\/+/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '*') {
      if (text[i + 1] === '*') { out += '.*'; i++; if (text[i + 1] === '/') i++; } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + (/[*?]/.test(text) || /\.[^/]+$/.test(text) ? '' : '(?:/.*)?') + '$');
}

// Exported: the app enforces owned files with the same rules (a folder owns its subtree).
export const ownsPath = (globs, path) => (globs || []).some((glob) => { try { return globRegExp(glob).test(String(path || '').replace(/^\/+/, '')); } catch (_) { return false; } });
