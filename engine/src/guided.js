// Herramientas del aprendizaje guiado. El estado del curso (plan, lección
// actual, notas) lo lleva la app (guided.js); aquí solo se definen las
// herramientas de pi con las que el modelo lo maneja. Cada handler devuelve
// { text, isError } y la app pinta las tarjetas.
import { Type } from '@earendil-works/pi-ai';

const question = (extra) => Type.Object(Object.assign({
  question: Type.String({ description: 'The question. Markdown and LaTeX (\\( … \\)) allowed. No answer options here.' }),
  options: Type.Array(Type.String(), { minItems: 2, maxItems: 5, description: 'The answer options (2–5), plain text without letters or numbers in front.' }),
  correct: Type.Integer({ minimum: 0, maximum: 4, description: 'Index of the correct option, starting at 0.' }),
  explanation: Type.String({ description: 'Why the correct option is right, in 1–3 short sentences. Shown after answering.' })
}, extra || {}));

function result(outcome) {
  const value = outcome || {};
  return { content: [{ type: 'text', text: String(value.text || '') }], details: value.details || {}, isError: !!value.isError };
}

export function createGuidedTools(handlers) {
  return [
    {
      name: 'set_course_plan',
      label: 'Plan del curso',
      description: 'Create or replace the course plan of this Guided Learning chat. The app shows it as a card with a "Start" button and tracks progress lesson by lesson. Group lessons in units (each with one emoji); each lesson teaches one concept, lists 2–4 concrete, checkable objectives and an estimate in minutes.',
      parameters: Type.Object({
        title: Type.String({ description: 'Short course title, e.g. "Derivadas desde cero".' }),
        goal: Type.String({ description: 'One sentence: what the student will be able to do at the end.' }),
        units: Type.Array(Type.Object({
          title: Type.String({ description: 'Unit title.' }),
          icon: Type.Optional(Type.String({ description: 'One emoji that represents the unit, e.g. "📐".' })),
          lessons: Type.Array(Type.Object({
            title: Type.String({ description: 'Lesson title.' }),
            objectives: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: '2–4 concrete objectives of the lesson.' }),
            minutes: Type.Optional(Type.Integer({ minimum: 3, maximum: 60, description: 'Estimated study minutes for the lesson.' }))
          }), { minItems: 1, maxItems: 8 })
        }), { minItems: 1, maxItems: 8 })
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => result(handlers.setPlan(params))
    },
    {
      name: 'quiz',
      label: 'Mini test',
      description: 'Show a short multiple-choice quiz (3–4 questions) that checks the CURRENT lesson. The app grades it and sends you the result in the student\'s next message. After calling it, stop: at most one short sentence.',
      parameters: Type.Object({
        questions: Type.Array(question(), { minItems: 2, maxItems: 6 })
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => result(handlers.quiz(params))
    },
    {
      name: 'final_exam',
      label: 'Examen final',
      description: 'Show the final exam of the course: about 2 questions per lesson, each tagged with the id of the lesson it checks. Only when the app says every lesson is done. The app grades it and sends you the result. After calling it, stop: at most one short sentence.',
      parameters: Type.Object({
        questions: Type.Array(question({
          lesson: Type.String({ description: 'Id of the lesson this question checks, e.g. "L3".' })
        }), { minItems: 4, maxItems: 30 })
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => result(handlers.exam(params))
    }
  ];
}
