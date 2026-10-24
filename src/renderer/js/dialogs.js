/**
 * dialogs.js
 * -----------------------------------------------------------------------------
 * Lógica de los DIÁLOGOS:
 *   - Agregar descarga (con sondeo automático de la URL para ver nombre/tamaño)
 *   - Programar descarga
 *   - Configuración (pestañas Carpetas, Conexiones, Apariencia, Navegador)
 *
 * Toda comunicación con el proceso principal pasa por `window.api`
 * (definido en preload.js).
 * -----------------------------------------------------------------------------
 */

import { state } from './state.js';
import { icon } from './icons.js';
import { formatBytes, escapeHtml, toDateTimeLocal, formatDateLong } from './format.js';
import { toast, openModal, closeModal } from './ui.js';

const $ = (id) => document.getElementById(id);

/**
 * Muestra (o esconde, si el texto está vacío) un mensaje de error en un formulario.
 * @param {string} id - id del contenedor de error.
 * @param {string} message
 * @returns {void}
 */
function showFormError(id, message) {
  $(id).textContent = message || '';
  $(id).hidden = !message;
}

/* ===================================================================== */
/*                         AGREGAR DESCARGA                               */
/* ===================================================================== */

let probeTimer = null; // Para esperar a que el usuario deje de escribir.
let probeCounter = 0; // Para descartar respuestas de sondeos antiguos.

/**
 * Abre el diálogo "Agregar descarga", opcionalmente con datos ya rellenos.
 * @param {object} [prefill]
 * @param {string} [prefill.url]
 * @param {string} [prefill.fileName]
 * @param {string} [prefill.browserRequestId] - Si viene de la extensión del navegador.
 * @returns {void}
 */
export function openAddDialog(prefill = {}) {
  const form = $('form-add');
  form.reset();
  form.dataset.browserRequestId = prefill.browserRequestId || '';
  $('add-url').value = prefill.url || '';
  $('add-name').value = prefill.fileName || '';
  $('add-name').placeholder = 'Se detecta automáticamente';
  $('add-dir').value = '';
  $('add-connections').value = state.settings.connections;
  $('add-connections-value').textContent = state.settings.connections;
  $('add-schedule-at').disabled = true;
  $('add-probe').hidden = true;
  showFormError('add-error', '');
  openModal('modal-add');
  if (prefill.url) probeUrl(prefill.url);
}

/**
 * Pide al proceso principal información sobre la URL y la muestra.
 * @param {string} url
 * @returns {Promise<void>}
 */
async function probeUrl(url) {
  const box = $('add-probe');
  try {
    new URL(url); // Si no es una URL válida, no sondeamos.
  } catch {
    box.hidden = true;
    return;
  }
  const myTurn = ++probeCounter;
  box.className = 'probe-info';
  box.innerHTML = `${icon('loader-circle', 16, 'spin')}<span>Obteniendo información del archivo…</span>`;
  box.hidden = false;

  try {
    const info = await window.api.probeUrl(url);
    if (myTurn !== probeCounter) return; // Llegó tarde: el usuario ya cambió la URL.
    const resumeTag = info.resumable
      ? `<span class="tag">Reanudable · descarga por partes</span>`
      : `<span class="tag no">Sin reanudación · 1 conexión</span>`;
    box.innerHTML = `${icon('file-check', 16)}<span><strong>${escapeHtml(info.fileName)}</strong> · ${formatBytes(info.totalBytes)}</span>${resumeTag}`;
    $('add-name').placeholder = info.fileName;
  } catch (err) {
    if (myTurn !== probeCounter) return;
    box.className = 'probe-info error';
    box.innerHTML = `${icon('circle-alert', 16)}<span>${escapeHtml(err.message)}</span>`;
  }
}

/**
 * Envía el formulario de "Agregar descarga".
 * @param {boolean} startNow - false = añadir en pausa.
 * @returns {Promise<void>}
 */
async function submitAdd(startNow) {
  showFormError('add-error', '');
  const form = $('form-add');
  const data = {
    url: $('add-url').value.trim(),
    fileName: $('add-name').value.trim(),
    directory: $('add-dir').value.trim(),
    connections: Number($('add-connections').value),
    expectedHash: $('add-hash').value.trim(),
    startNow,
    browserRequestId: form.dataset.browserRequestId || undefined,
    source: form.dataset.browserRequestId ? 'browser' : 'manual',
  };

  if ($('add-schedule-on').checked) {
    const when = new Date($('add-schedule-at').value).getTime();
    if (!Number.isFinite(when) || when <= Date.now()) {
      showFormError('add-error', 'Elige una fecha y hora futuras para programar la descarga.');
      return;
    }
    data.scheduledAt = when;
  }

  try {
    const item = await window.api.addDownload(data);
    closeModal('modal-add');
    const text = item.status === 'scheduled' ? `Empezará el ${formatDateLong(item.scheduledAt)}` : item.fileName;
    toast({ title: item.status === 'scheduled' ? 'Descarga programada' : 'Descarga añadida', text, type: 'success', duration: 3000 });
  } catch (err) {
    showFormError('add-error', err.message);
  }
}

/** Conecta los eventos del diálogo "Agregar descarga". */
function setupAddDialog() {
  $('add-url').addEventListener('input', (event) => {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => probeUrl(event.target.value.trim()), 600);
  });

  $('add-paste').addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      $('add-url').value = text;
      probeUrl(text);
    } catch {
      toast({ title: 'No se pudo leer el portapapeles', type: 'error' });
    }
  });

  $('add-browse').addEventListener('click', async () => {
    try {
      const folder = await window.api.chooseFolder($('add-dir').value || state.settings.downloadDir);
      if (folder) $('add-dir').value = folder;
    } catch (err) {
      toast({ title: 'No se pudo abrir el selector', text: err.message, type: 'error' });
    }
  });

  $('add-connections').addEventListener('input', (e) => ($('add-connections-value').textContent = e.target.value));

  $('add-schedule-on').addEventListener('change', (e) => {
    const input = $('add-schedule-at');
    input.disabled = !e.target.checked;
    if (e.target.checked && !input.value) input.value = toDateTimeLocal(new Date(Date.now() + 3600_000));
    // Si se programa, el botón principal cambia de texto.
    $('add-submit').lastElementChild.textContent = e.target.checked ? 'Programar' : 'Descargar';
  });

  $('form-add').addEventListener('submit', (event) => {
    event.preventDefault(); // Evita que el formulario recargue la página.
    submitAdd(true);
  });
  $('add-paused').addEventListener('click', () => submitAdd(false));
}

/* ===================================================================== */
/*                              PROGRAMAR                                 */
/* ===================================================================== */

let scheduleIds = [];

/**
 * Abre el diálogo para programar las descargas indicadas.
 * @param {string[]} ids
 * @returns {void}
 */
export function openScheduleDialog(ids) {
  scheduleIds = ids;
  const names = ids.map((id) => state.items.get(id)?.fileName).filter(Boolean);
  $('schedule-summary').textContent =
    names.length === 1 ? `«${names[0]}» empezará automáticamente a la hora indicada.` : `${names.length} descargas empezarán automáticamente a la hora indicada.`;
  $('schedule-at').value = toDateTimeLocal(new Date(Date.now() + 3600_000));
  showFormError('schedule-error', '');
  openModal('modal-schedule');
}

/** Conecta los eventos del diálogo "Programar". */
function setupScheduleDialog() {
  document.querySelectorAll('[data-quick]').forEach((btn) =>
    btn.addEventListener('click', () => {
      let date;
      if (btn.dataset.quick === 'night') {
        // Próximas 02:00 (mañana si ya pasaron hoy).
        date = new Date();
        date.setHours(2, 0, 0, 0);
        if (date <= new Date()) date.setDate(date.getDate() + 1);
      } else {
        date = new Date(Date.now() + Number(btn.dataset.quick) * 60_000);
      }
      $('schedule-at').value = toDateTimeLocal(date);
    }),
  );

  $('form-schedule').addEventListener('submit', async (event) => {
    event.preventDefault();
    const when = new Date($('schedule-at').value).getTime();
    if (!Number.isFinite(when) || when <= Date.now()) {
      showFormError('schedule-error', 'La hora programada debe ser futura.');
      return;
    }
    try {
      await window.api.schedule(scheduleIds, when);
      closeModal('modal-schedule');
      toast({ title: 'Descarga programada', text: formatDateLong(when), type: 'success', duration: 3000 });
    } catch (err) {
      showFormError('schedule-error', err.message);
    }
  });
}

/* ===================================================================== */
/*                            CONFIGURACIÓN                               */
/* ===================================================================== */

/**
 * Cambia la pestaña visible de la configuración.
 * @param {string} tab - data-tab de la pestaña.
 * @returns {void}
 */
function selectTab(tab) {
  document.querySelectorAll('#settings-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
}

/**
 * Pinta el estado del servidor del navegador dentro de la configuración.
 * @returns {void}
 */
export function renderServerStatus() {
  const box = $('set-server-status');
  if (!box || !state.server) return;
  const { running, port, error } = state.server;
  if (error) box.innerHTML = `<span class="dot-status err"></span><span>${escapeHtml(error)}</span>`;
  else if (running) box.innerHTML = `<span class="dot-status on"></span><span>Escuchando en <code>http://127.0.0.1:${port}</code></span>`;
  else box.innerHTML = `<span class="dot-status"></span><span>Servidor desactivado</span>`;
}

/** Textos de cada estado del actualizador. */
const UPDATE_TEXT = {
  unavailable: 'Las actualizaciones solo funcionan en la app instalada (no en modo desarrollo).',
  idle: 'Pulsa el botón para comprobar si hay una versión nueva.',
  checking: 'Buscando actualizaciones…',
  none: 'Ya tienes la última versión.',
};

/**
 * Pinta el estado de las actualizaciones en la pestaña correspondiente.
 * @returns {void}
 */
export function renderUpdateStatus() {
  const u = state.update;
  if (!u || !$('upd-title')) return;
  const busy = ['checking', 'downloading'].includes(u.status);
  let title = `Versión instalada: v${u.currentVersion}`;
  let text = UPDATE_TEXT[u.status] || '';
  if (u.status === 'available') { title = `Hay una versión nueva: v${u.version}`; text = 'Puedes descargarla ahora; no se instalará hasta que tú quieras.'; }
  if (u.status === 'downloading') { title = `Descargando v${u.version || ''}…`; text = `${u.percent}%`; }
  if (u.status === 'downloaded') { title = `v${u.version} lista para instalar`; text = 'La app se cerrará, se instalará y se volverá a abrir. Tus descargas en curso se guardan y se pueden reanudar.'; }
  if (u.status === 'error') text = u.error || 'Error desconocido.';
  $('upd-title').textContent = title;
  $('upd-text').textContent = text;
  $('upd-progress').hidden = u.status !== 'downloading';
  $('upd-bar').style.width = `${u.percent || 0}%`;
  $('upd-check').disabled = busy || u.status === 'unavailable' || u.status === 'downloaded';
  $('upd-download').hidden = u.status !== 'available';
  $('upd-install').hidden = u.status !== 'downloaded';
}

/**
 * Abre la configuración rellenando cada campo con los valores actuales.
 * @param {string} [tab='general'] - Pestaña inicial.
 * @returns {void}
 */
export function openSettingsDialog(tab = 'general') {
  const s = state.settings;
  $('set-download-dir').value = s.downloadDir;

  // Una fila por categoría con su carpeta (vacía = automática).
  $('set-category-dirs').innerHTML = state.categories
    .map(
      (c) => `
      <div class="category-dir cat-${c.id}">
        <span class="cat-label">${icon(c.icon, 16)} ${escapeHtml(c.label)}</span>
        <input type="text" data-category="${c.id}" value="${escapeHtml(s.categoryDirs[c.id] || '')}"
               placeholder="${escapeHtml(`${s.downloadDir}\\${c.label}`)}" />
        <button type="button" class="btn" data-browse-category="${c.id}" title="Elegir carpeta">${icon('folder-open', 16)}</button>
      </div>`,
    )
    .join('');

  $('set-connections').value = s.connections;
  $('set-connections-value').textContent = s.connections;
  $('set-max-concurrent').value = s.maxConcurrent;
  $('set-max-retries').value = s.maxRetries;
  $('set-speed-limit').value = s.speedLimitKBps;
  document.querySelectorAll('input[name=theme]').forEach((r) => (r.checked = r.value === s.theme));
  $('set-tray').checked = s.minimizeToTray;
  $('set-notifications').checked = s.notifications;
  $('set-clipboard').checked = s.clipboardWatch;
  $('set-auto-update').checked = s.autoUpdateCheck;
  renderUpdateStatus();
  $('set-server-enabled').checked = s.serverEnabled;
  $('set-server-port').value = s.serverPort;
  $('set-server-token').value = s.serverToken;
  $('set-browser-confirm').checked = s.browserConfirm;
  renderServerStatus();
  showFormError('settings-error', '');
  selectTab(tab);
  openModal('modal-settings');
}

/**
 * Abre el selector de carpetas y escribe el resultado en un campo.
 * @param {HTMLInputElement} input
 * @returns {Promise<void>}
 */
async function browseInto(input) {
  try {
    const folder = await window.api.chooseFolder(input.value || input.placeholder || state.settings.downloadDir);
    if (folder) input.value = folder;
  } catch (err) {
    toast({ title: 'No se pudo abrir el selector', text: err.message, type: 'error' });
  }
}

/** Conecta los eventos del diálogo de configuración. */
function setupSettingsDialog() {
  document.querySelectorAll('#settings-tabs .tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  $('set-connections').addEventListener('input', (e) => ($('set-connections-value').textContent = e.target.value));

  // Botones "examinar" (usamos delegación porque las filas de categoría se crean dinámicamente).
  $('form-settings').addEventListener('click', (event) => {
    const general = event.target.closest('[data-browse]');
    if (general) browseInto($(general.dataset.browse));
    const category = event.target.closest('[data-browse-category]');
    if (category) browseInto(document.querySelector(`input[data-category="${category.dataset.browseCategory}"]`));
  });

  $('set-copy-token').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('set-server-token').value);
      toast({ title: 'Token copiado', type: 'success', duration: 2000 });
    } catch {
      toast({ title: 'No se pudo copiar', type: 'error' });
    }
  });

  $('set-new-token').addEventListener('click', async () => {
    try {
      const settings = await window.api.regenerateToken();
      $('set-server-token').value = settings.serverToken;
      toast({ title: 'Nuevo token generado', text: 'Actualízalo también en las opciones de la extensión.', type: 'warning' });
    } catch (err) {
      toast({ title: 'Error', text: err.message, type: 'error' });
    }
  });

  // Botones de actualización. Los cambios de estado llegan por el evento 'update:status'.
  const updateAction = (id, call) => $(id).addEventListener('click', async () => {
    try {
      await call();
    } catch (err) {
      toast({ title: 'No se pudo completar la acción', text: err.message, type: 'error' });
    }
  });
  updateAction('upd-check', () => window.api.checkUpdate());
  updateAction('upd-download', () => window.api.downloadUpdate());
  updateAction('upd-install', () => window.api.installUpdate());

  $('set-open-extension').addEventListener('click', async () => {
    try {
      await window.api.openExtensionFolder();
    } catch (err) {
      toast({ title: 'No se pudo abrir la carpeta', text: err.message, type: 'error' });
    }
  });

  $('form-settings').addEventListener('submit', async (event) => {
    event.preventDefault();
    const categoryDirs = {};
    document.querySelectorAll('input[data-category]').forEach((input) => (categoryDirs[input.dataset.category] = input.value.trim()));
    const changes = {
      downloadDir: $('set-download-dir').value.trim(),
      categoryDirs,
      connections: Number($('set-connections').value),
      maxConcurrent: Number($('set-max-concurrent').value),
      maxRetries: Number($('set-max-retries').value),
      speedLimitKBps: Number($('set-speed-limit').value),
      theme: document.querySelector('input[name=theme]:checked')?.value,
      minimizeToTray: $('set-tray').checked,
      notifications: $('set-notifications').checked,
      clipboardWatch: $('set-clipboard').checked,
      autoUpdateCheck: $('set-auto-update').checked,
      serverEnabled: $('set-server-enabled').checked,
      serverPort: Number($('set-server-port').value),
      browserConfirm: $('set-browser-confirm').checked,
    };
    try {
      await window.api.saveSettings(changes);
      closeModal('modal-settings');
      toast({ title: 'Configuración guardada', type: 'success', duration: 2500 });
    } catch (err) {
      showFormError('settings-error', err.message);
    }
  });
}

/**
 * Inicializa todos los diálogos (se llama una vez al arrancar).
 * @returns {void}
 */
export function setupDialogs() {
  setupAddDialog();
  setupScheduleDialog();
  setupSettingsDialog();
}
