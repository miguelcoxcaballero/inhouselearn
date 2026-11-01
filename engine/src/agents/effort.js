// Cuánto razona y cuánto trabaja cada agente de Ultra code.
//
// El agente principal va siempre al máximo; los que reparte no necesitan lo
// mismo. Quien solo lee y busca rinde igual con menos razonamiento (y es lo que
// más ahorra en un reparto grande); quien escribe o verifica piensa a fondo,
// pero no tanto como el que decide. El modelo puede cambiarlo agente a agente
// con `effort`. Puro: sin red ni DOM.

export const EFFORTS = ['low', 'medium', 'high', 'max'];
export const ROLE_EFFORT = { explore: 'medium', build: 'high', verify: 'high' };
// Pasos máximos por rol: leer y buscar acaba antes que escribir y comprobar.
export const STEP_CAPS = { explore: 25, build: 40, verify: 30 };
// Dónde cae cada esfuerzo en la escalera del modelo (0 = el nivel más bajo, 1 = el más hondo).
const SHARE = { low: 0.2, medium: 0.5, high: 0.8, max: 1 };
export const EFFORT_LABEL = { low: 'bajo', medium: 'medio', high: 'alto', max: 'máx' };

export function normalizeEffort(value) {
  const effort = String(value == null ? '' : value).trim().toLowerCase();
  return EFFORTS.includes(effort) ? effort : '';
}

// The effort an agent runs with: what the model asked for, else its role's.
export function effortFor(role, requested) {
  return normalizeEffort(requested) || ROLE_EFFORT[role] || 'high';
}

export function stepCapFor(role) {
  return STEP_CAPS[role] || STEP_CAPS.build;
}

// levels: the model's reasoning ladder (shallowest first; «off» is ignored).
// Returns the level to run an agent at, or '' for a model that does not reason.
export function pickLevel(levels, role, effort) {
  const ladder = (Array.isArray(levels) ? levels : []).filter((level) => level && level !== 'off');
  if (!ladder.length) return '';
  return ladder[Math.round(SHARE[effortFor(role, effort)] * (ladder.length - 1))];
}
