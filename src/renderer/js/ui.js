/**
 * ui.js
 * -----------------------------------------------------------------------------
 * COMPONENTES REUTILIZABLES de la interfaz:
 *   - toast():        avisos flotantes en la esquina (con botones opcionales).
 *   - openModal() / closeModal(): mostrar y ocultar diálogos.
 *   - confirmDialog(): pregunta "¿Seguro?" que devuelve una promesa.
 *   - showContextMenu(): menú de clic derecho.
 * -----------------------------------------------------------------------------
 */

import { icon } from './icons.js';
import { escapeHtml } from './format.js';

/* ============================== AVISOS ============================== */

const TOAST_ICONS = { info: 'info', success: 'circle-check', error: 'circle-alert', warning: 'triangle-alert' };

/**
 * Muestra un aviso flotante.
 * @param {object} options
 * @param {string} options.title - Título.
 * @param {string} [options.text] - Texto secundario.
 * @param {'info'|'success'|'error'|'warning'} [options.type='info']
 * @param {number} [options.duration=4500] - Milisegundos visible (0 = hasta cerrarlo).
 * @param {Array<{label:string, primary?:boolean, onClick:() => void}>} [options.actions]
 * @returns {() => void} Función para cerrarlo manualmente.
 */
export function toast({ title, text = '', type = 'info', duration = 4500, actions = [] }) {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    ${icon(TOAST_ICONS[type] || 'info', 20)}
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${text ? `<div class="toast-text">${escapeHtml(text)}</div>` : ''}
      ${actions.length ? '<div class="toast-actions"></div>' : ''}
    </div>
    <button class="icon-btn" title="Cerrar">${icon('x', 16)}</button>`;

  const close = () => el.remove();
  el.querySelector('.icon-btn').addEventListener('click', close);

  // Creamos los botones con addEventListener (no con HTML) para pasar funciones.
  const actionsBox = el.querySelector('.toast-actions');
  for (const action of actions) {
    const button = document.createElement('button');
    button.className = `btn ${action.primary ? 'btn-primary' : ''}`;
    button.textContent = action.label;
    button.addEventListener('click', () => {
      close();
      action.onClick();
    });
    actionsBox.appendChild(button);
  }

  container.appendChild(el);
  // Máximo 4 avisos a la vez: quitamos los más antiguos.
  while (container.children.length > 4) container.firstElementChild.remove();
  if (duration) setTimeout(close, duration);
  return close;
}

/* ============================== DIÁLOGOS ============================== */

/**
 * Muestra un diálogo y pone el foco en su primer campo.
 * @param {string} id - id del elemento .modal-backdrop.
 * @returns {void}
 */
export function openModal(id) {
  const backdrop = document.getElementById(id);
  backdrop.hidden = false;
  // Preferimos el primer campo de texto; si no hay, el primer botón.
  const focusable =
    backdrop.querySelector('input:not([type=hidden]):not([disabled]):not([type=checkbox]):not([type=radio])') ||
    backdrop.querySelector('.modal-footer button');
  focusable?.focus();
}

/**
 * Oculta un diálogo.
 * @param {string} id
 * @returns {void}
 */
export function closeModal(id) {
  document.getElementById(id).hidden = true;
}

/**
 * Prepara el cierre de todos los diálogos: botones con data-close, clic en el
 * fondo oscuro y tecla Escape.
 * @returns {void}
 */
export function setupModals() {
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => (backdrop.hidden = true)));
    backdrop.addEventListener('mousedown', (event) => {
      // Solo si se hace clic en el fondo, no dentro del diálogo.
      if (event.target === backdrop) backdrop.hidden = true;
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal-backdrop:not([hidden])')].pop();
    if (open) open.hidden = true;
  });
}

/**
 * Pregunta de confirmación. Devuelve una promesa con la respuesta.
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.text
 * @param {string} [options.confirmLabel='Aceptar']
 * @param {string} [options.checkboxLabel] - Si se da, muestra una casilla extra.
 * @returns {Promise<{confirmed:boolean, checked:boolean}>}
 */
export function confirmDialog({ title, text, confirmLabel = 'Aceptar', checkboxLabel }) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('modal-confirm');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    const yes = document.getElementById('confirm-yes');
    const no = document.getElementById('confirm-no');
    const checkWrap = document.getElementById('confirm-check-wrap');
    const check = document.getElementById('confirm-check');
    yes.textContent = confirmLabel;
    checkWrap.hidden = !checkboxLabel;
    check.checked = false;
    document.getElementById('confirm-check-label').textContent = checkboxLabel || '';

    // finish() limpia los manejadores para no acumularlos entre usos.
    const finish = (confirmed) => {
      backdrop.hidden = true;
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      observer.disconnect();
      resolve({ confirmed, checked: check.checked });
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    // Si se cierra con Escape o clic fuera, cuenta como "No".
    const observer = new MutationObserver(() => backdrop.hidden && finish(false));
    observer.observe(backdrop, { attributes: true, attributeFilter: ['hidden'] });

    backdrop.hidden = false;
    yes.focus();
  });
}

/* ============================== MENÚ CONTEXTUAL ============================== */

/**
 * Muestra un menú contextual en la posición del ratón.
 * @param {MouseEvent} event - Evento del clic derecho.
 * @param {Array<{label:string, icon:string, onClick:() => void, disabled?:boolean, danger?:boolean}|'separator'>} entries
 * @returns {void}
 */
export function showContextMenu(event, entries) {
  event.preventDefault();
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  for (const entry of entries) {
    if (entry === 'separator') {
      menu.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>');
      continue;
    }
    const button = document.createElement('button');
    button.className = `menu-item ${entry.danger ? 'danger' : ''}`;
    button.disabled = Boolean(entry.disabled);
    button.innerHTML = `${icon(entry.icon, 16)}<span>${escapeHtml(entry.label)}</span>`;
    button.addEventListener('click', () => {
      hideContextMenu();
      entry.onClick();
    });
    menu.appendChild(button);
  }

  // Lo mostramos para medirlo y lo recolocamos si se sale de la ventana.
  menu.hidden = false;
  const { offsetWidth: w, offsetHeight: h } = menu;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - w - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - h - 8)}px`;
}

/** Oculta el menú contextual. */
export function hideContextMenu() {
  document.getElementById('context-menu').hidden = true;
}

// Cualquier clic fuera, scroll o Escape cierra el menú.
document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('#context-menu')) hideContextMenu();
});
document.addEventListener('keydown', (event) => event.key === 'Escape' && hideContextMenu());
window.addEventListener('blur', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);
