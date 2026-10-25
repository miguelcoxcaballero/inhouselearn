// Ultra code: el modelo reparte un trabajo grande entre varios agentes de pi
// que corren a la vez, cada uno con su propia tarea, y recibe sus resultados
// para integrarlos. La app crea cada agente (ctx.runSubAgent: mismo modelo,
// mismas herramientas salvo esta, la misma puerta de aprobación) y enseña en
// el chat qué hace cada uno y lo que va gastando.
//
// ctx: { runSubAgent({ name, task, signal, onUpdate({ doing, cost, steps }) }) → { text, cost } }
import { Type } from '@earendil-works/pi-ai';

const MAX_AGENTS = 6;

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

export function createAgentTools(ctx) {
  return [
    {
      name: 'spawn_agents',
      label: 'Agentes en paralelo',
      description: 'Ultra code: split a big job into independent parts and run them at the same time, one agent each (up to ' + MAX_AGENTS + '). Every agent starts from zero and does not see this conversation: put what they all need (the goal of the user, decisions taken, files, repository, branch, conventions) in context once, and give each a self-contained task that says what to return. Agents have the same tools as you except this one. Use it for work that really splits (several files or modules, several sources to research, several documents); then check and integrate what they return. Do not use it for a single small task.',
      parameters: Type.Object({
        context: Type.Optional(Type.String({ description: 'Shared brief every agent receives before its task: the goal, what was decided, where things are.' })),
        agents: Type.Array(Type.Object({
          name: Type.String({ description: 'Short name for the agent, e.g. "Tests", "Investigación precios".' }),
          task: Type.String({ description: 'The complete, self-contained task for this agent and what it must return.' })
        }), { minItems: 1, maxItems: MAX_AGENTS })
      }),
      executionMode: 'sequential',
      execute: async (id, params, signal, onUpdate) => {
        const list = (params.agents || []).slice(0, MAX_AGENTS).filter((agent) => agent && String(agent.task || '').trim());
        if (!list.length) throw new Error('Pasa al menos un agente con su tarea.');
        const state = list.map((agent, index) => ({ name: String(agent.name || 'Agente ' + (index + 1)).slice(0, 60), status: 'running', doing: 'Empezando', cost: 0, steps: 0 }));
        let last = 0;
        const push = (force) => {
          if (typeof onUpdate !== 'function') return;
          const now = Date.now();
          if (!force && now - last < 250) return;
          last = now;
          const total = state.reduce((sum, agent) => sum + agent.cost, 0);
          onUpdate(textResult(state.map((agent) => (agent.status === 'done' ? '✓ ' : agent.status === 'error' ? '✕ ' : '… ') + agent.name + ': ' + agent.doing + ' · $' + agent.cost.toFixed(4)).join('\n') + '\nTotal $' + total.toFixed(4), { agents: state.map((agent) => Object.assign({}, agent)) }));
        };
        push(true);
        const results = await Promise.all(list.map(async (agent, index) => {
          const own = state[index];
          try {
            const result = await ctx.runSubAgent({
              name: own.name,
              task: (String(params.context || '').trim() ? 'Contexto común (lo mismo para todos los agentes):\n' + String(params.context).trim() + '\n\nTu tarea:\n' : '') + String(agent.task),
              signal,
              onUpdate: (update) => {
                if (update.doing) own.doing = String(update.doing).slice(0, 120);
                if (Number.isFinite(update.cost)) own.cost = Math.max(own.cost, update.cost);
                if (Number.isFinite(update.steps)) own.steps = update.steps;
                push(false);
              }
            });
            own.status = 'done';
            own.doing = 'Terminado';
            if (Number.isFinite(result.cost)) own.cost = result.cost;
            push(true);
            return '## ' + own.name + '\n' + (String(result.text || '').trim() || '(sin respuesta)');
          } catch (error) {
            if (error && error.name === 'AbortError') throw error;
            own.status = 'error';
            own.doing = String(error && error.message || error).slice(0, 160);
            if (error && error.usage && Number.isFinite(error.usage.cost)) own.cost = Math.max(own.cost, error.usage.cost);
            push(true);
            return '## ' + own.name + '\nHa fallado: ' + own.doing;
          }
        }));
        const total = state.reduce((sum, agent) => sum + agent.cost, 0);
        return textResult(results.join('\n\n') + '\n\n(' + state.length + ' agentes, $' + total.toFixed(4) + ' en total. Revisa e integra lo que han hecho antes de responder.)', { agents: state });
      }
    }
  ];
}
