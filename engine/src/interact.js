// Preguntar al usuario con opciones (ask_user) y llevar la lista de pasos de un
// trabajo largo (update_plan). La app dibuja la pregunta encima del cuadro de
// texto y el plan en el hilo; aquí solo se definen las herramientas de pi.
//
// ctx: { ask({ question, options, multiple }, signal) → { answer, chosen: [labels], other } | null }
import { Type } from '@earendil-works/pi-ai';

const STATUSES = ['pending', 'in_progress', 'done'];

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

export function createInteractTools(ctx) {
  const tools = [
    {
      name: 'update_plan',
      label: 'Plan',
      description: 'Keep a short checklist of the steps of a long task (three steps or more: a document, a project, a multi-part exercise), shown to the user in the chat. Call it once with the whole plan, then again each time a step starts or ends, always sending the full list. Only one step in_progress at a time; mark a step done right after finishing it. Not for simple questions.',
      parameters: Type.Object({
        items: Type.Array(Type.Object({
          text: Type.String({ description: 'The step, a few words.' }),
          status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('done')])
        }), { description: 'Every step, in order.' })
      }),
      execute: async (id, params) => {
        const items = (Array.isArray(params.items) ? params.items : []).slice(0, 20).map((item) => ({
          text: String((item && item.text) || '').trim().slice(0, 160),
          status: STATUSES.includes(item && item.status) ? item.status : 'pending'
        })).filter((item) => item.text);
        if (!items.length) throw new Error('El plan está vacío: pasa al menos un paso.');
        const done = items.filter((item) => item.status === 'done').length;
        const next = items.find((item) => item.status !== 'done');
        return textResult('Plan: ' + done + '/' + items.length + ' hechos.' + (next ? ' Siguiente: ' + next.text + '.' : ' Todo hecho.'), { plan: items });
      }
    }
  ];
  if (ctx && typeof ctx.ask === 'function') {
    tools.push({
      name: 'ask_user',
      label: 'Preguntar',
      description: 'Ask the user one short question with 2-4 answers to tap (they can also write their own) and wait for the answer. Use it only when you cannot go on well without their choice (which of two very different approaches, a missing fact, what to prioritise), not to confirm what they already asked for, and never for things you can decide or find out yourself. One question per call; put the option you recommend first.',
      parameters: Type.Object({
        question: Type.String({ description: 'The question, one sentence.' }),
        options: Type.Array(Type.String({ description: 'An answer, a few words.' }), { description: '2 to 4 answers.' }),
        multiple: Type.Optional(Type.Boolean({ description: 'true: the user may choose several.' }))
      }),
      executionMode: 'sequential',
      execute: async (id, params, signal) => {
        const question = String(params.question || '').trim();
        const options = (Array.isArray(params.options) ? params.options : []).map((option) => String(option || '').trim().slice(0, 120)).filter(Boolean).slice(0, 4);
        if (!question) throw new Error('Falta la pregunta.');
        if (options.length < 2) throw new Error('Pasa entre 2 y 4 respuestas para elegir.');
        const reply = await ctx.ask({ question, options, multiple: !!params.multiple }, signal);
        if (!reply || !String(reply.answer || '').trim()) {
          return { content: [{ type: 'text', text: 'El usuario no ha contestado. Sigue con lo más razonable y dile qué has supuesto, o pregúntaselo en tu respuesta.' }], details: { question, options }, isError: true };
        }
        return textResult('El usuario responde: ' + String(reply.answer).trim(), { question, options, answer: String(reply.answer).trim() });
      }
    });
  }
  return tools;
}
