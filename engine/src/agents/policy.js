// Las reglas de decisión de Ultra code, sueltas y puras para poder probarlas sin
// agentes de verdad: cuándo verificar, cuándo no empezar otro agente, cuántos
// a la vez y cuántas rondas de arreglos.
import { MAX_PARALLEL, MIN_PARALLEL } from './common.js';

// Un verificador cuesta lo que un agente más: solo compensa cuando hay algo que
// comprobar. Con criterios, con quien escribe (y no es solo uno), o con un
// reparto grande. Dos que solo leen los integra el modelo principal.
export function shouldVerify(nodes, acceptance) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (acceptance && acceptance.length) return true;
  if (list.length >= 3) return true;
  return list.length >= 2 && list.some((node) => node.role === 'build');
}

// Rondas de arreglos tras la verificación: 0 a 3, una por defecto.
export function fixRoundsFrom(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 1;
}

// No empezar un agente que no va a poder acabar: el que se queda a medias por el
// presupuesto es dinero tirado. Con menos de la mitad de lo que ha costado de
// media uno terminado (o el 8 % final) no se empieza otro.
export function startVerdict({ spent, budget, finishedCosts }) {
  if (!(budget > 0)) return { ok: true };
  if (spent >= budget) return { ok: false, near: false };
  const costs = (finishedCosts || []).filter((cost) => cost > 0);
  const average = costs.length ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : 0;
  if (spent >= budget * 0.92 || (average > 0 && budget - spent < average * 0.5)) return { ok: false, near: true };
  return { ok: true };
}

// How many agents run at once. A provider that answers 429 / overloaded halves it
// (never below MIN_PARALLEL); after two agents in a row that end well it grows one back.
export function nextParallel(state, event) {
  const max = state.max || MAX_PARALLEL;
  if (event === 'limit') return { limit: Math.max(MIN_PARALLEL, Math.floor(state.limit / 2)), calm: 0, max, slowed: true };
  if (event === 'ok') {
    const calm = (state.calm || 0) + 1;
    return calm >= 2 && state.limit < max ? { limit: state.limit + 1, calm: 0, max, slowed: state.slowed } : { limit: state.limit, calm, max, slowed: state.slowed };
  }
  return state;
}

// Failed checks of a verdict as one comparable key: a fix round that leaves the same
// ones failing made no progress, and the rounds stop there.
export function failingKey(checks) {
  return (Array.isArray(checks) ? checks : []).filter((check) => check && !check.ok).map((check) => String(check.criterion || '')).sort().join('|');
}
