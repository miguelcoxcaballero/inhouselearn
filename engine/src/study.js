// Estudio: memoria del usuario, asignaturas con examen y temas, resultados de
// práctica, errores y búsqueda en todos los chats. La app guarda y calcula
// (study.js: dominio, plan, lagunas); el modelo solo informa y consulta.
//
// ctx: {
//   overview(spaceRef) → text, saveSpace(input) → { space, declined }, result(space, topic, correct, note) → text,
//   remember(input) → { item, declined }, forget(ref) → item|null,
//   recall(query, limit) → [{ chatId, title, date, role, snippet, score }]
// }
import { Type } from '@earendil-works/pi-ai';

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

export function createStudyTools(ctx) {
  return [
    {
      name: 'memory_save',
      label: 'Recordar',
      description: 'Remember something lasting about the user for every future chat: a goal ("examen de Análisis II el 15 de diciembre"), a preference ("prefiere un dibujo antes de la fórmula"), a fact about their studies ("2º de Ingeniería Industrial") or how they learn best. Save it when the user tells you or when it is clearly stable; one short sentence each, in the third person. Never save health, money, passwords or other sensitive data, nor things that only matter in this chat. The user sees and deletes everything in «Lo que sé de ti».',
      parameters: Type.Object({
        text: Type.String({ description: 'One short sentence.' }),
        kind: Type.Union([Type.Literal('objetivo'), Type.Literal('preferencia'), Type.Literal('dato'), Type.Literal('aprendizaje')]),
        subject_only: Type.Optional(Type.Boolean({ description: 'true: only for chats of this chat\'s subject.' }))
      }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const out = await ctx.remember({ text: params.text, kind: params.kind, subjectOnly: !!params.subject_only });
        if (out.declined) return { content: [{ type: 'text', text: 'El usuario no ha querido que lo recuerdes. No insistas.' }], details: {}, isError: true };
        return textResult('Recordado: ' + out.item.text, { memory: out.item.id });
      }
    },
    {
      name: 'memory_forget',
      label: 'Olvidar',
      description: 'Forget a saved memory (its id from the memory list in your instructions, or words of it) when the user asks or when it is no longer true.',
      parameters: Type.Object({ ref: Type.String({ description: 'Memory id (the 5 characters in brackets) or words of it.' }) }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const item = await ctx.forget(String(params.ref || '').trim());
        if (!item) throw new Error('No encuentro ese recuerdo.');
        return textResult('Olvidado: ' + item.text);
      }
    },
    {
      name: 'study_overview',
      label: 'Ver el estudio',
      description: 'See the user\'s subjects (exam date, hours a week, every topic with its weight and state: sin tocar / frágil / en camino / sólido), the gaps in order (what to study first), the plan of the coming days (study sessions, spaced reviews, mock exam) and their most expensive mistakes. space: one subject (name), or empty for all. Use it before planning, before a review session and whenever the user asks what to study.',
      parameters: Type.Object({ space: Type.Optional(Type.String({ description: 'Subject name. Empty: every subject.' })) }),
      execute: async (id, params) => textResult(await ctx.overview(String(params.space || '').trim()))
    },
    {
      name: 'study_space',
      label: 'Guardar asignatura',
      description: 'Create or update a subject the user is studying: name, exam date (YYYY-MM-DD), hours a week they can study, and its topics with a weight (how much each counts in the exam, e.g. 1-5). Topics keep their progress when their name stays the same. This chat joins the subject. Use it when the user tells you about an exam or a subject to organise; the app then computes the study plan and the reviews.',
      parameters: Type.Object({
        name: Type.String({ description: 'Subject name, e.g. "Análisis II".' }),
        exam_date: Type.Optional(Type.String({ description: 'YYYY-MM-DD, if there is an exam.' })),
        hours_week: Type.Optional(Type.Number({ description: 'Hours a week for this subject.' })),
        topics: Type.Optional(Type.Array(Type.Object({ name: Type.String(), weight: Type.Optional(Type.Number()) }), { description: 'Every topic, in order.' })),
        rules: Type.Optional(Type.String({ description: 'How the user wants to be taught in this subject (e.g. "solo pistas, nunca la solución").' }))
      }),
      executionMode: 'sequential',
      execute: async (id, params) => {
        const out = await ctx.saveSpace({ name: params.name, examDate: params.exam_date, hoursWeek: params.hours_week, topics: params.topics, rules: params.rules });
        if (out.declined) return { content: [{ type: 'text', text: 'El usuario no ha aprobado guardar la asignatura.' }], details: {}, isError: true };
        return textResult(out.text, { space: out.space.id });
      }
    },
    {
      name: 'study_result',
      label: 'Resultado de práctica',
      description: 'Report the result of one question or exercise the user just answered on a topic of a subject (correct or not), so the app updates how well they master it and when to review it. Report every real answer during practice, reviews and mock exams; never invent results, and never report a hint as a correct answer. When wrong, say briefly why in mistake (the cause, e.g. "olvida el signo al pasar de miembro").',
      parameters: Type.Object({
        space: Type.String({ description: 'Subject name.' }),
        topic: Type.String({ description: 'Topic name, as in study_overview.' }),
        correct: Type.Boolean(),
        mistake: Type.Optional(Type.String({ description: 'If wrong: the cause, one short sentence.' }))
      }),
      executionMode: 'sequential',
      execute: async (id, params) => textResult(await ctx.result(params.space, params.topic, !!params.correct, params.mistake))
    },
    {
      name: 'recall',
      label: 'Buscar en mis chats',
      description: 'Search everything the user and you said in all their other chats (old explanations, exercises, decisions, what they struggled with). Returns snippets with the chat, the date and a link. Use it when the user refers to something from before («lo que vimos de…», «como la otra vez») or when past work would help; cite what you use with its link, e.g. [12 abr · Derivadas](?c=ID).',
      parameters: Type.Object({
        query: Type.String({ description: 'Key words.' }),
        limit: Type.Optional(Type.Number({ description: 'How many results (default 6, max 12).' }))
      }),
      execute: async (id, params) => {
        const hits = await ctx.recall(String(params.query || ''), Math.min(12, Math.max(1, Number(params.limit) || 6)));
        if (!hits.length) return textResult('Nada en tus otros chats para «' + params.query + '».', { matches: 0 });
        return textResult(hits.map((hit, index) => (index + 1) + '. «' + hit.title + '» · ' + (hit.date ? hit.date.slice(0, 10) : '') + ' · ' + (hit.role === 'user' ? 'el usuario' : 'tú') + ' · enlace: ?c=' + hit.chatId + '\n   ' + hit.snippet).join('\n'), { matches: hits.length });
      }
    }
  ];
}
