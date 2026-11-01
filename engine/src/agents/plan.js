// El plan de un spawn_agents: ids, dependencias, oleadas, avisos y los fallos que
// hacen inútil lanzarlo. Puro: sin red, sin DOM, sin agentes.
import { MAX_AGENTS, DEFAULT_MINUTES, slug } from './common.js';
import { effortFor, stepCapFor } from './effort.js';

// No \b after an accented letter (it is not a \w in JS regexps): an explicit end instead.
const VAGUE = /(?:^|[^\wáéíóúñ])(arriba|antes|esta conversaci[oó]n|lo que te pas[eé]|above|previous)(?![\wáéíóúñ])/i;
// A task that leans on this conversation cannot work (the agents never saw it), so
// it is stricter than VAGUE: «antes» alone is an ordinary word in a good task.
const CONVERSATION = /(?:^|[^\wáéíóúñ])(arriba|esta conversaci[oó]n|lo que te pas[eé]|el mensaje anterior|above|previous message)(?![\wáéíóúñ])/i;
const MIN_TASK_CHARS = 40;
// File paths named in a task (a known extension, so "e.g." or "v1.2" are not paths).
const PATH_IN_TEXT = /(?:^|[\s`'"(«])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:m?js|cjs|jsx|tsx?|css|scss|html?|md|json|ya?ml|toml|txt|py|rb|go|rs|java|kts?|swift|c|cc|cpp|h|hpp|cs|php|sh|sql|vue|svelte|xml|svg|csv|tex|bib|gradle|docx|xlsx|pptx|pdf))(?=$|[\s`'")»,:;!?]|\.(?:\s|$))/g;

// planAgents(list, { context }) → { nodes, waves, warnings, blockers }. Throws when a
// dependency does not exist or the graph has a cycle (the model fixes the call and
// retries). `blockers` are what makes a plan not worth running as it stands (the
// tool refuses it once, before spending anything); `warnings` only travel with the
// result.
export function planAgents(list, options) {
  const hasContext = !!String((options && options.context) || '').trim();
  const raw = (Array.isArray(list) ? list : []).filter((agent) => agent && String(agent.task || '').trim()).slice(0, MAX_AGENTS);
  if (!raw.length) throw new Error('Pasa al menos un agente con su tarea.');
  const used = new Set();
  const given = new Map(); // id the model wrote → id it ended with (first wins)
  const nodes = raw.map((agent, index) => {
    const name = String(agent.name || '').trim().slice(0, 60) || 'Agente ' + (index + 1);
    const wanted = String(agent.id == null ? '' : agent.id).trim().slice(0, 40);
    let id = wanted && !used.has(wanted) ? wanted : '';
    if (!id) {
      const base = slug(name) || 'agente-' + (index + 1);
      id = base;
      for (let n = 2; used.has(id); n++) id = base + '-' + n;
    }
    used.add(id);
    if (wanted && !given.has(wanted)) given.set(wanted, id);
    if (!given.has(id)) given.set(id, id);
    const minutes = Math.max(1, Math.min(30, Math.round(Number(agent.max_minutes)) || DEFAULT_MINUTES));
    const role = agent.role === 'explore' ? 'explore' : 'build';
    return {
      id, name, index,
      task: String(agent.task).trim(),
      role,
      effort: effortFor(role, agent.effort),
      maxSteps: stepCapFor(role, agent.max_steps),
      rawDeps: (Array.isArray(agent.depends_on) ? agent.depends_on : []).map((dep) => String(dep).trim()).filter(Boolean),
      files: (Array.isArray(agent.files) ? agent.files : []).map((glob) => String(glob).trim()).filter(Boolean).slice(0, 20),
      returns: String(agent.returns || '').trim(),
      maxMinutes: minutes,
      deps: [], wave: 1
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node) => {
    node.deps = Array.from(new Set(node.rawDeps.map((dep) => {
      const id = given.get(dep) || (byId.has(dep) ? dep : '');
      if (!id) throw new Error('depends_on «' + dep + '» no existe');
      return id;
    })));
    if (node.deps.includes(node.id)) throw new Error('Hay un ciclo: ' + node.id + ' → ' + node.id);
    delete node.rawDeps;
  });
  // Cycle check and wave = longest path from a root + 1.
  const state = new Map();
  const trail = [];
  const depth = (node) => {
    if (state.get(node.id) === 2) return node.wave;
    if (state.get(node.id) === 1) {
      const from = trail.indexOf(node.id);
      throw new Error('Hay un ciclo: ' + trail.slice(from).concat(node.id).join(' → '));
    }
    state.set(node.id, 1);
    trail.push(node.id);
    node.wave = 1 + node.deps.reduce((max, dep) => Math.max(max, depth(byId.get(dep))), 0);
    trail.pop();
    state.set(node.id, 2);
    return node.wave;
  };
  nodes.forEach(depth);
  const waves = nodes.reduce((max, node) => Math.max(max, node.wave), 0);
  // Lint: what makes a sub-agent fail most often is a task that leans on a
  // conversation it never saw, or two agents rewriting the same file.
  const warnings = [];
  nodes.forEach((node) => {
    if (node.task.length < 120) warnings.push('La tarea de «' + node.name + '» es muy corta (' + node.task.length + ' caracteres): cada agente empieza de cero; di qué hacer, dónde y qué devolver.');
    const vague = VAGUE.exec(node.task);
    if (vague) warnings.push('«' + node.name + '» menciona «' + vague[1] + '», pero no ve esta conversación: pon eso en context o en su tarea.');
  });
  const ancestors = new Map();
  const ancestorsOf = (node) => {
    if (ancestors.has(node.id)) return ancestors.get(node.id);
    const set = new Set();
    node.deps.forEach((dep) => { set.add(dep); ancestorsOf(byId.get(dep)).forEach((id) => set.add(id)); });
    ancestors.set(node.id, set);
    return set;
  };
  const pathsOf = (node) => {
    const set = new Set(node.files.filter((glob) => !/[*?]/.test(glob)).map((path) => path.replace(/^\.?\/+/, '')));
    let match;
    PATH_IN_TEXT.lastIndex = 0;
    while ((match = PATH_IN_TEXT.exec(node.task))) if (!/^\d+(\.\d+)+$/.test(match[1]) && !/^https?:/i.test(match[1])) set.add(match[1].replace(/^\.?\/+/, ''));
    return set;
  };
  const paths = nodes.map(pathsOf);
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      if (ancestorsOf(nodes[a]).has(nodes[b].id) || ancestorsOf(nodes[b]).has(nodes[a].id)) continue;
      const shared = Array.from(paths[a]).filter((path) => paths[b].has(path));
      if (shared.length) warnings.push('«' + nodes[a].name + '» y «' + nodes[b].name + '» nombran los dos ' + shared.slice(0, 3).join(', ') + ' y ninguno depende del otro: dáselo a uno solo (files) o haz que uno dependa del otro.');
    }
  }
  // Blockers: with no shared context, a task of a few words or one that points at
  // «lo de arriba» gives an agent nothing to work with. The tool refuses such a plan
  // once, before any agent starts, so the model rewrites it instead of paying for it.
  const blockers = [];
  if (!hasContext) {
    nodes.forEach((node) => {
      if (node.task.length < MIN_TASK_CHARS) blockers.push('La tarea de «' + node.name + '» tiene ' + node.task.length + ' caracteres y no hay context: un agente empieza de cero y con tan poco no sabrá qué hacer. Di qué hacer, dónde y qué devolver (o pon lo común en context).');
      const ref = CONVERSATION.exec(node.task);
      if (ref) blockers.push('«' + node.name + '» dice «' + ref[1] + '», pero los agentes no ven esta conversación: pon eso en context o en su tarea.');
    });
  }
  return { nodes, waves, warnings, blockers };
}
