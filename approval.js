/* ─── Aprobación de cambios ─────────────────────────────────────────────
   El botón del compositor decide cuánto le pregunta la app al modelo antes
   de cada cambio:

   • Preguntar: pide permiso para escribir o borrar archivos del chat y para
     hacer commits, pull requests o comentarios en GitHub.
   • Auto: los archivos del chat se guardan sin preguntar; en GitHub se le
     pregunta igual que siempre.
   • Acceso total: no se pregunta nada, tampoco en GitHub.

   El modo es de cada chat (chat.approvalMode) y se guarda con él. La app es
   quien aprueba: GitHub llama a ctx.confirm() (engine/src/github.js) y aquí
   se decide si se enseña el diálogo o se aprueba solo; las herramientas de
   archivos del chat se envuelven para pasar por el mismo sitio.

   Loaded before the main script of index.html; uses its globals at call
   time (getActiveChat, confirmDialog, saveState, showToast, escapeHtml…). */

const APPROVAL_MODES = [
  {
    id: 'ask',
    label: 'Preguntar',
    hint: 'Te pregunta antes de cada cambio',
    description: 'Pide permiso para escribir o borrar archivos del chat y para hacer commits, pull requests o comentarios en GitHub.',
    icon: 'shield'
  },
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Aprueba los cambios de este chat',
    description: 'Escribe y borra archivos del chat sin preguntar. En GitHub te sigue preguntando.',
    icon: 'zap'
  },
  {
    id: 'full',
    label: 'Acceso total',
    hint: 'No pregunta nada',
    description: 'Aprueba todo solo: también los commits, los pull requests y los comentarios de GitHub.',
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

/* ─── Botón y menú ──────────────────────────────────────────────────── */

function approvalMarkup() {
  return [
    '<div class="approval-wrap" id="approval-wrap">',
    '  <button class="approval-trigger" id="approval-btn" type="button" aria-haspopup="listbox" aria-expanded="false" data-mode="auto" title="Aprobación de cambios">',
    '    <span class="approval-trigger-icon" id="approval-trigger-icon" aria-hidden="true"></span>',
    '    <span class="approval-trigger-label" id="approval-trigger-label">Auto</span>',
    '    <svg class="approval-trigger-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>',
    '  </button>',
    '  <div class="topbar-popover approval-popover hidden" id="approval-popup" role="listbox" aria-label="Aprobación de cambios">',
    '    <div class="approval-popover-title">Aprobación de cambios</div>',
    '    <div class="approval-popover-status">Cuánto le preguntas al modelo antes de que cambie algo.</div>',
    '    <div class="approval-options" id="approval-options"></div>',
    '  </div>',
    '</div>'
  ].join('');
}

function mountApprovalButton() {
  if (document.getElementById('approval-btn')) return;
  const row = document.querySelector('.composer-row');
  const spacer = row && row.querySelector('.composer-spacer');
  if (!row || !spacer) return;
  const template = document.createElement('template');
  template.innerHTML = approvalMarkup();
  row.insertBefore(template.content.firstElementChild, spacer);
  bindApprovalUi();
}

function bindApprovalUi() {
  const btn = document.getElementById('approval-btn');
  const popup = document.getElementById('approval-popup');
  if (!btn || !popup || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    setApprovalMenu(popup.classList.contains('hidden'));
  });
  popup.addEventListener('click', (event) => {
    const option = event.target.closest('[data-approval-mode]');
    if (!option) return;
    setApprovalMode(option.getAttribute('data-approval-mode'));
  });
}

function setApprovalMenu(open) {
  const popup = document.getElementById('approval-popup');
  const btn = document.getElementById('approval-btn');
  if (!popup || !btn) return;
  popup.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) return;
  // Solo un menú abierto a la vez.
  if (typeof closeModelMenu === 'function') closeModelMenu();
  if (typeof setPlusMenu === 'function') setPlusMenu(false);
  renderApprovalUi();
}

function closeApprovalMenu() {
  setApprovalMenu(false);
}

function renderApprovalUi() {
  const chat = getActiveChat();
  const mode = approvalModeOf(chat);
  const info = approvalModeInfo(mode);
  const btn = document.getElementById('approval-btn');
  if (btn) {
    btn.dataset.mode = mode;
    btn.title = 'Aprobación de cambios: ' + info.hint;
    btn.setAttribute('aria-label', 'Aprobación de cambios: ' + info.label);
  }
  const icon = document.getElementById('approval-trigger-icon');
  if (icon) icon.innerHTML = approvalIconSvg(mode);
  const label = document.getElementById('approval-trigger-label');
  if (label) label.textContent = info.label;
  const options = document.getElementById('approval-options');
  if (options) {
    options.innerHTML = APPROVAL_MODES.map((item) => (
      '<button type="button" class="approval-option' + (item.id === mode ? ' active' : '') + '" role="option" aria-selected="' + (item.id === mode ? 'true' : 'false') + '" data-approval-mode="' + item.id + '">' +
      '<span class="approval-option-icon">' + approvalIconSvg(item.id) + '</span>' +
      '<span class="approval-option-text"><b>' + escapeHtml(item.label) + '</b><small>' + escapeHtml(item.description) + '</small></span>' +
      '<svg class="approval-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12 10 17 19 7"/></svg>' +
      '</button>'
    )).join('');
  }
}

function setApprovalMode(mode) {
  const chat = getActiveChat();
  const next = normalizeApprovalMode(mode);
  closeApprovalMenu();
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
  if (approvalModeOf(chat) === 'full') {
    showToast('Acceso total', (options.title || 'Cambio') + ': aprobado automáticamente.');
    return true;
  }
  return confirmDialog({
    title: options.title || 'Confirmar',
    message: options.summary || options.message || '',
    items: options.items || [],
    confirmText: options.confirmText || 'Aprobar',
    cancelText: options.cancelText || 'No'
  });
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
    return '- Aprobación de cambios: el usuario te pide permiso antes de cada cambio (archivos del chat y commits, pull requests o comentarios en GitHub). Pídele lo que necesites y, si lo rechaza, no repitas el cambio.';
  }
  return '- Aprobación de cambios: los archivos del chat se guardan sin preguntar, pero GitHub (commits, pull requests y comentarios) se lo preguntas al usuario.';
}

document.addEventListener('click', (event) => {
  const popup = document.getElementById('approval-popup');
  const btn = document.getElementById('approval-btn');
  if (!popup || !btn || popup.classList.contains('hidden')) return;
  if (popup.contains(event.target) || btn.contains(event.target)) return;
  closeApprovalMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeApprovalMenu();
});

mountApprovalButton();
