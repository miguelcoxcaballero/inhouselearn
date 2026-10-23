// Herramientas del aprendizaje guiado. El estado del curso (plan, lección
// actual, notas) lo lleva la app (guided.js); aquí solo se definen las
// herramientas de pi con las que el modelo lo maneja. Cada handler devuelve
// { text, isError } y la app pinta las tarjetas.
import { Type } from '@earendil-works/pi-ai';

const question = (extra) => Type.Object(Object.assign({
  question: Type.String({ description: 'The question. Markdown and LaTeX (\\( … \\)) allowed. No answer options here.' }),
  options: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 5, description: 'The answer options (2–5), plain text without letters or numbers in front. The app shuffles them, so order does not matter. Every wrong option must be as long, specific and plausible as the right one (a typical mistake or misconception); the right one must not stand out by length, detail or wording. Avoid "all/none of the above".' })),
  correct: Type.Optional(Type.Integer({ minimum: 0, maximum: 4, description: 'Index of the correct option in the list you wrote, starting at 0.' })),
  type: Type.Optional(Type.Union([Type.Literal('choice'), Type.Literal('numeric')], { description: 'Default choice. Use numeric for calculations: the learner enters a number, not an option.' })),
  answer: Type.Optional(Type.Number({ description: 'Correct finite numeric value in the requested unit; recompute it before emitting. Numeric questions only.' })),
  tolerance: Type.Optional(Type.Number({ minimum: 0, description: 'Absolute allowed error in that unit, reflecting the requested rounding. Required for numeric; 0 means exact.' })),
  unit: Type.Optional(Type.String({ description: 'Required answer unit (e.g. N or m/s). State it in the prompt; empty for dimensionless quantities. The learner enters only a number.' })),
  hint: Type.Optional(Type.String({ description: 'A strategy cue or missing first step; do not give the result. Available on request in practice, not exams.' })),
  skill: Type.Optional(Type.Union([Type.Literal('recall'), Type.Literal('apply'), Type.Literal('transfer')], { description: 'The thinking this question checks; transfer changes the context or assumptions.' })),
  explanation: Type.String({ description: 'Why the correct option is right, in 1–3 short sentences, without mentioning letters or positions (options are reordered). Shown after answering.' })
}, extra || {}));

function result(outcome) {
  const value = outcome || {};
  return { content: [{ type: 'text', text: String(value.text || '') }], details: value.details || {}, isError: !!value.isError };
}

export function createGuidedTools(handlers) {
  return [
    {
      name: 'check_diagram',
      label: 'Revisar esquema',
      description: 'Preflight a learning diagram in the real browser at phone and desktop widths. Accepts scene, explain or image with inline svg. Reports overlapping/clipped labels, tiny text and invalid scene expressions. It does not verify scientific correctness. Before publishing a new diagram, check it, fix issues and check the corrected version again (2–3 passes, maximum 3 calls per answer); then emit exactly the corrected specification as a visual block. No scripts or remote images run.',
      parameters: Type.Object({ spec: Type.String({ description: 'JSON string containing the complete visual specification to check.' }) }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => result(await handlers.checkDiagram(params))
    },
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
      description: 'Show a short mixed quiz (3–4 questions, choice or numeric) that checks the CURRENT lesson: understanding, independent application, and transfer. For numeric questions, omit options/correct and include answer, unit, and absolute tolerance. The app grades it and sends you the result in the student\'s next message. After calling it, stop: at most one short sentence.',
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
