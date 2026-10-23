/* ─── Aprobación de cambios ─────────────────────────────────────────────
   La sección «Aprobación de cambios» del menú + decide cuánto le pregunta la
   app al modelo antes de cada cambio:

   • Preguntar: pide permiso para escribir o borrar archivos del chat y para
     subir a GitHub (commit, pull request o comentario).
   • Auto: los archivos del chat se guardan sin preguntar; cada subida a
     GitHub se pregunta una vez, con todos sus archivos.
   • Acceso total: no se pregunta nada, tampoco en GitHub.

   El modo es de cada chat (chat.approvalMode) y se guarda con él. La app es
   quien aprueba: GitHub llama a ctx.confirm() (engine/src/github.js) y aquí
   se decide si se enseña la tarjeta de aprobación encima del cuadro de texto
   (dockApprove, composer-dock.js) o se aprueba solo; las herramientas de
   archivos del chat se envuelven para pasar por el mismo sitio.

   Loaded before the main script of index.html; uses its globals at call
   time (getActiveChat, confirmDialog, saveState, showToast, escapeHtml…). */

const APPROVAL_MODES = [
  {
    id: 'ask',
    label: 'Preguntar',
    hint: 'Te pregunta antes de cada cambio',
    description: 'Pide permiso para guardar o borrar archivos del chat y para subir a GitHub.',
    icon: 'shield'
  },
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Aprueba los cambios de este chat',
    description: 'Guarda archivos del chat sin preguntar; para subir a GitHub te pregunta una vez.',
    icon: 'zap'
  },
  {
    id: 'full',
    label: 'Acceso total',
    hint: 'No pregunta nada',
    description: 'No pregunta nada, tampoco para subir a GitHub.',
    icon: 'lock'
  }
];
const DEFAULT_APPROVAL_MODE = 'auto';
const APPROVAL_ICON_PATHS = {
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'
};
// Herramientas que cambian los archivos del chat: en «Preguntar» las aprueba el usuario.
const APPROVAL_FILE_TOOLS = {
  write_file: 'Guardar archivo',
  edit_file: 'Editar archivo',
  delete_file: 'Borrar archivo'
};
// Nombres legibles de los pasos de las herramientas de GitHub.
const APPROVAL_GITHUB_LABELS = {
  github_list_repos: 'GitHub: repositorios',
  github_list_files: 'GitHub: archivos',
  github_read_file: 'GitHub: leer archivo',
  github_search_code: 'GitHub: buscar código',
  github_grep: 'GitHub: buscar en los archivos',
  github_write_files: 'GitHub: preparar archivos',
  github_edit_file: 'GitHub: preparar edición',
  github_discard: 'GitHub: descartar preparado',
  github_push: 'GitHub: subir',
  github_ci_status: 'GitHub: estado de la CI',
  github_create_pull_request: 'GitHub: abrir PR',
  github_list_issues: 'GitHub: issues y PRs',
  github_comment: 'GitHub: comentar'
};

function approvalIconSvg(id) {
  const mode = APPROVAL_MODES.find((item) => item.id === id) || APPROVAL_MODES[0];
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (APPROVAL_ICON_PATHS[mode.icon] || '') + '</svg>';
}

function normalizeApprovalMode(value) {
  const id = String(value || '').trim();
  return APPROVAL_MODES.some((mode) => mode.id === id) ? id : DEFAULT_APPROVAL_MODE;
}

function approvalModeOf(chat) {
  return normalizeApprovalMode(chat && chat.approvalMode);
}

function approvalModeInfo(id) {
  return APPROVAL_MODES.find((mode) => mode.id === id) || APPROVAL_MODES[1];
}

/* ─── En el menú «+» ────────────────────────────────────────────────── */

function approvalMarkup() {
  return [
    '<div class="plus-approval" id="approval-section" role="radiogroup" aria-label="Aprobación de cambios">',
    '  <div class="plus-approval-head">',
    '    <span class="plus-approval-icon" id="approval-trigger-icon" aria-hidden="true"></span>',
    '    <span class="plus-item-text"><b>Aprobación de cambios</b><small id="approval-hint"></small></span>',
    '  </div>',
    '  <div class="plus-approval-options" id="approval-options"></div>',
    '</div>'
  ].join('');
}

function mountApprovalButton() {
  if (document.getElementById('approval-section')) return;
  const menu = document.getElementById('plus-menu');
  if (!menu) return;
  const template = document.createElement('template');
  template.innerHTML = approvalMarkup();
  menu.appendChild(template.content.firstElementChild);
  const options = document.getElementById('approval-options');
  options.addEventListener('click', (event) => {
    const option = event.target.closest('[data-approval-mode]');
    if (!option) return;
    event.stopPropagation();
    setApprovalMode(option.getAttribute('data-approval-mode'));
  });
}

function renderApprovalUi() {
  const chat = typeof getActiveChat === 'function' ? getActiveChat() : null;
  const mode = approvalModeOf(chat);
  const info = approvalModeInfo(mode);
  const icon = document.getElementById('approval-trigger-icon');
  if (icon) {
    icon.innerHTML = approvalIconSvg(mode);
    icon.dataset.mode = mode;
  }
  const hint = document.getElementById('approval-hint');
  if (hint) hint.textContent = info.description;
  const options = document.getElementById('approval-options');
  if (options) {
    options.innerHTML = APPROVAL_MODES.map((item) => (
      '<button type="button" class="plus-approval-option' + (item.id === mode ? ' active' : '') + '" role="radio" aria-checked="' + (item.id === mode ? 'true' : 'false') + '" data-approval-mode="' + item.id + '" title="' + escapeHtml(item.hint) + '">' +
      approvalIconSvg(item.id) + '<span>' + escapeHtml(item.label) + '</span></button>'
    )).join('');
  }
  const plus = document.getElementById('plus-btn');
  if (plus) plus.classList.toggle('has-full-access', mode === 'full');
}

function setApprovalMode(mode) {
  const chat = getActiveChat();
  const next = normalizeApprovalMode(mode);
  if (approvalModeOf(chat) === next) {
    renderApprovalUi();
    return;
  }
  chat.approvalMode = next;
  saveState();
  renderApprovalUi();
  showToast('Aprobación de cambios', approvalModeInfo(next).hint + '.');
  if (typeof haptic === 'function') haptic('select');
}

/* ─── La puerta de entrada ──────────────────────────────────────────── */

// Un cambio de GitHub (commit, pull request, comentario) o del chat.
// En «Acceso total» se aprueba solo y se avisa con un aviso; si no, lo
// aprueba el usuario en el diálogo.
async function approveChange(chat, request) {
  const options = request || {};
  // Some actions (publishing an APK) reach other people's phones and cannot be
  // undone: they ask even in «Acceso total».
  if (approvalModeOf(chat) === 'full' && !options.always) {
    showToast('Acceso total', (options.title || 'Cambio') + ': aprobado automáticamente.');
    return true;
  }
  // Above the composer, not over the whole screen: the user can keep writing.
  const card = {
    title: options.title || 'Confirmar',
    message: options.summary || options.message || '',
    items: options.items || [],
    danger: !!options.mainBranch,
    confirmText: options.confirmText || 'Aprobar',
    cancelText: options.cancelText || 'No'
  };
  return typeof dockApprove === 'function' ? dockApprove(card) : confirmDialog(card);
}

function approvalFileRequest(toolName, params) {
  const path = String((params && params.path) || '').trim() || '(sin nombre)';
  if (toolName === 'delete_file') {
    return {
      title: 'Borrar archivo del chat',
      summary: path + '\nSe borra de este chat y de su copia en Drive.'
    };
  }
  const content = params && typeof params.content === 'string' ? params.content : '';
  return {
    title: toolName === 'edit_file' ? 'Editar archivo del chat' : 'Guardar archivo del chat',
    summary: path + (content ? '\n' + content.length + ' caracteres.' : '')
  };
}

// Envuelve las herramientas de archivos del chat: en «Preguntar» el usuario
// las aprueba una a una. run_js solo pregunta si su código guarda archivos.
function approvalWorkspaceTools(chat, tools) {
  return (tools || []).map((tool) => {
    if (tool.name === 'run_js') {
      return Object.assign({}, tool, {
        execute: async (id, params, ...rest) => {
          if (approvalModeOf(chat) === 'ask' && typeof params.code === 'string' && /\bwriteFile\s*\(/.test(params.code)) {
            const ok = await approveChange(chat, {
              title: 'Ejecutar JavaScript que guarda archivos',
              summary: 'El código va a guardar archivos en este chat.'
            });
            if (!ok) throw new Error('El usuario no ha aprobado la ejecución. No lo repitas sin preguntarle.');
          }
          return tool.execute(id, params, ...rest);
        }
      });
    }
    if (!APPROVAL_FILE_TOOLS[tool.name]) return tool;
    return Object.assign({}, tool, {
      execute: async (id, params, ...rest) => {
        if (approvalModeOf(chat) === 'ask') {
          const ok = await approveChange(chat, approvalFileRequest(tool.name, params));
          if (!ok) throw new Error('El usuario no ha aprobado este cambio. No lo repitas sin preguntarle qué quiere cambiar.');
        }
        return tool.execute(id, params, ...rest);
      }
    });
  });
}

// Lo que le decimos al modelo: sabe si el usuario le va a preguntar o no.
function approvalPromptText(chat) {
  const mode = approvalModeOf(chat);
  if (mode === 'full') {
    return '- Aprobación de cambios: el usuario ha dado acceso total. Haz los cambios (archivos del chat y GitHub) sin preguntarle y dile al final qué has hecho.';
  }
  if (mode === 'ask') {
    return '- Aprobación de cambios: el usuario aprueba cada archivo del chat que guardes o borres y cada subida a GitHub (preparar cambios no pregunta; github_push, el PR y los comentarios sí). Si rechaza algo, no lo repitas.';
  }
  return '- Aprobación de cambios: los archivos del chat se guardan sin preguntar; en GitHub el usuario aprueba cada subida (github_push o el PR, una vez con todos los archivos) y cada comentario. Preparar cambios no pregunta nada.';
}

// Los pasos de las herramientas de GitHub se enseñan con su nombre corto.
// The section is drawn by updateConfigUi (renderApprovalUi) once the chats are loaded.
document.addEventListener('DOMContentLoaded', () => {
  if (typeof TOOL_LABELS === 'object' && TOOL_LABELS) {
    Object.assign(TOOL_LABELS, APPROVAL_GITHUB_LABELS);
  }
  mountApprovalButton();
});
