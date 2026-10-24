/**
 * app.js
 * -----------------------------------------------------------------------------
 * MÓDULO PRINCIPAL DE LA INTERFAZ.
 *
 *   - Pide el estado inicial al proceso principal y pinta la pantalla.
 *   - Escucha los eventos en vivo (progreso, cambios de estado, portapapeles,
 *     peticiones del navegador...) y actualiza solo lo necesario.
 *   - Gestiona la selección de filas, la barra de herramientas, el menú
 *     contextual, los atajos de teclado y el arrastrar-y-soltar de enlaces.
 *
 * Rendimiento: el progreso llega varias veces por segundo. En vez de repintar
 * toda la tabla cada vez, "parcheamos" solo las celdas de la fila afectada.
 * Solo repintamos todo cuando cambia algo estructural (estado, filtros...).
 * -----------------------------------------------------------------------------
 */

import { state, STATUS_VIEWS, matchesFilters, visibleItems, selectedItems } from './state.js';
import { icon, hydrateIcons } from './icons.js';
import { formatBytes, formatSpeed, formatEta, formatDate, formatDateLong, percentOf, escapeHtml, STATUS_LABELS, STATUS_ICONS } from './format.js';
import { toast, setupModals, confirmDialog, showContextMenu } from './ui.js';
import { setupDialogs, openAddDialog, openScheduleDialog, openSettingsDialog, renderServerStatus, renderUpdateStatus } from './dialogs.js';

const $ = (id) => document.getElementById(id);
const api = window.api;

/** Agrupaciones de estados usadas para habilitar botones. */
const CAN_RESUME = ['paused', 'error', 'canceled', 'scheduled'];
const CAN_PAUSE = ['downloading', 'queued', 'scheduled'];
const CAN_CANCEL = ['downloading', 'queued', 'scheduled', 'paused', 'error'];
const CAN_SCHEDULE = ['paused', 'error', 'canceled', 'queued', 'scheduled'];

/**
 * Ejecuta una acción asíncrona y, si falla, muestra el error en un aviso.
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    toast({ title: 'Algo salió mal', text: err.message, type: 'error' });
    return undefined;
  }
}

/* ===================================================================== */
/*                               PINTADO                                  */
/* ===================================================================== */

let renderQueued = false;

/**
 * Pide un repintado completo en el próximo fotograma. Si se piden varios en
 * el mismo instante, solo se hace uno (requestAnimationFrame los agrupa).
 * @returns {void}
 */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll();
  });
}

/** Repinta todas las zonas de la pantalla. */
function renderAll() {
  renderSidebar();
  renderHeader();
  renderTable();
  renderToolbar();
  renderDetails();
  renderStatusbar();
}

/**
 * Barra lateral: vistas por estado y categorías, con sus contadores.
 * @returns {void}
 */
function renderSidebar() {
  const all = [...state.items.values()];
  $('status-nav').innerHTML = STATUS_VIEWS.map((view) => {
    const count = all.filter(view.match).length;
    return `<button class="nav-item ${state.statusFilter === view.id ? 'active' : ''}" data-status="${view.id}">
        ${icon(view.icon, 17)}<span>${view.label}</span><span class="count">${count}</span></button>`;
  }).join('');

  $('category-nav').innerHTML = state.categories.map((cat) => {
    const count = all.filter((i) => i.category === cat.id).length;
    return `<button class="nav-item cat-${cat.id} ${state.categoryFilter === cat.id ? 'active' : ''}" data-category="${cat.id}">
        <span class="file-icon" style="width:24px;height:24px;border-radius:7px">${icon(cat.icon, 14)}</span>
        <span>${escapeHtml(cat.label)}</span><span class="count">${count}</span></button>`;
  }).join('');
}

/**
 * Título de la vista y "chips" de filtros activos.
 * @returns {void}
 */
function renderHeader() {
  const view = STATUS_VIEWS.find((v) => v.id === state.statusFilter);
  const category = state.categories.find((c) => c.id === state.categoryFilter);
  $('view-title').textContent = state.statusFilter === 'all' ? (category ? category.label : 'Todas las descargas') : view.label;

  const visible = visibleItems();
  const bytes = visible.reduce((sum, i) => sum + (i.totalBytes || 0), 0);
  $('view-subtitle').textContent = `${visible.length} descarga${visible.length === 1 ? '' : 's'} · ${formatBytes(bytes)}`;

  const chips = [];
  if (category && state.statusFilter !== 'all') chips.push({ key: 'category', label: category.label });
  if (state.search) chips.push({ key: 'search', label: `“${state.search}”` });
  $('active-filters').innerHTML = chips
    .map((c) => `<span class="chip">${escapeHtml(c.label)}<button data-clear="${c.key}" title="Quitar filtro">${icon('x', 12)}</button></span>`)
    .join('');
}

/**
 * HTML de la celda de progreso.
 * @param {object} item
 * @returns {string}
 */
function progressHtml(item) {
  const pct = percentOf(item);
  const indeterminate = pct === null && item.status === 'downloading';
  return `<div class="progress-cell">
      <div class="progress"><div class="progress-bar s-${item.status} ${indeterminate ? 'indeterminate' : ''}" style="width:${pct ?? 0}%"></div></div>
      <span class="pct num">${pct === null ? '' : `${Math.floor(pct)}%`}</span></div>`;
}

/**
 * HTML de la celda de estado (píldora + línea secundaria con error/reintento/hora).
 * @param {object} item
 * @returns {string}
 */
function statusHtml(item) {
  const spinning = item.status === 'downloading' ? 'spin' : '';
  let pill = `<span class="pill s-${item.status}">${icon(STATUS_ICONS[item.status], 13, spinning)}${STATUS_LABELS[item.status]}</span>`;
  let sub = '';
  if (item.retryInfo) sub = `<div class="status-sub" title="${escapeHtml(item.retryInfo)}">${escapeHtml(item.retryInfo)}</div>`;
  else if (item.status === 'error') sub = `<div class="status-sub error" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</div>`;
  else if (item.status === 'scheduled') sub = `<div class="status-sub">${formatDate(item.scheduledAt)}</div>`;
  return pill + sub;
}

/**
 * Texto de la columna Tamaño ("12 MB / 40 MB" mientras descarga).
 * @param {object} item
 * @returns {string}
 */
function sizeText(item) {
  if (item.status === 'completed') return formatBytes(item.totalBytes);
  if (!item.downloadedBytes) return formatBytes(item.totalBytes);
  return `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)}`;
}

/**
 * Texto secundario bajo el nombre: servidor y conexiones.
 * @param {object} item
 * @returns {string}
 */
function subText(item) {
  let host = '';
  try {
    host = new URL(item.url).host;
  } catch {
    host = item.url;
  }
  const parts = [host];
  if (item.kind === 'media') {
    // Vídeo o audio de una página: mostramos lo elegido en vez de las conexiones.
    const m = item.media || {};
    if (m.mode === 'audio') parts.push(`${(m.audioFormat || 'mp3').toUpperCase()}${m.audioQuality ? ` · ${m.audioQuality} kbps` : ''}`);
    else parts.push(m.height ? `MP4 · hasta ${m.height}p` : 'MP4 · mejor calidad');
  } else if (item.probed) parts.push(item.resumable ? `${item.segments.length} ${item.segments.length === 1 ? 'conexión' : 'conexiones'}` : 'sin reanudación');
  if (item.source === 'browser') parts.push('desde el navegador');
  return parts.join(' · ');
}

/**
 * HTML completo de una fila de la tabla.
 * @param {object} item
 * @returns {string}
 */
function rowHtml(item) {
  const category = state.categories.find((c) => c.id === item.category) || state.categories.at(-1);
  const isActive = item.status === 'downloading';
  return `<tr data-id="${item.id}" class="${state.selected.has(item.id) ? 'selected' : ''}">
    <td class="col-name"><div class="name-cell">
      <span class="file-icon cat-${item.category}">${icon(category.icon, 18)}</span>
      <div class="name-text"><div class="file-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</div>
      <div class="file-sub" data-cell="sub">${escapeHtml(subText(item))}</div></div></div></td>
    <td class="num" data-cell="size">${sizeText(item)}</td>
    <td data-cell="progress">${progressHtml(item)}</td>
    <td class="num" data-cell="speed">${isActive ? formatSpeed(item.speed) : '—'}</td>
    <td class="num" data-cell="eta">${isActive ? formatEta(item.eta) : '—'}</td>
    <td data-cell="status">${statusHtml(item)}</td>
    <td class="num muted" title="${escapeHtml(formatDateLong(item.createdAt))}">${formatDate(item.createdAt)}</td>
  </tr>`;
}

/**
 * Actualiza solo las celdas que cambian con el progreso (sin recrear la fila).
 * La barra de progreso se modifica in situ para que su transición CSS anime suave.
 * @param {HTMLTableRowElement} tr
 * @param {object} item
 * @returns {void}
 */
function patchRow(tr, item) {
  const isActive = item.status === 'downloading';
  tr.querySelector('.file-name').textContent = item.fileName;
  tr.querySelector('[data-cell=sub]').textContent = subText(item);
  tr.querySelector('[data-cell=size]').textContent = sizeText(item);
  tr.querySelector('[data-cell=speed]').textContent = isActive ? formatSpeed(item.speed) : '—';
  tr.querySelector('[data-cell=eta]').textContent = isActive ? formatEta(item.eta) : '—';

  const pct = percentOf(item);
  const bar = tr.querySelector('.progress-bar');
  bar.className = `progress-bar s-${item.status} ${pct === null && isActive ? 'indeterminate' : ''}`;
  bar.style.width = `${pct ?? 0}%`;
  tr.querySelector('.pct').textContent = pct === null ? '' : `${Math.floor(pct)}%`;

  // La celda de estado solo cambia si hay mensaje de reintento.
  const statusCell = tr.querySelector('[data-cell=status]');
  const html = statusHtml(item);
  if (statusCell.dataset.html !== html) {
    statusCell.innerHTML = html;
    statusCell.dataset.html = html;
  }
}

/**
 * Tabla completa de descargas (filtrada y ordenada).
 * @returns {void}
 */
function renderTable() {
  const items = visibleItems();
  $('downloads-body').innerHTML = items.map(rowHtml).join('');
  $('empty-state').hidden = items.length > 0;

  // Marcamos la columna por la que se ordena.
  document.querySelectorAll('thead th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.classList.toggle('asc', state.sort.dir === 'asc');
  });
}

/**
 * Habilita/deshabilita los botones según lo seleccionado.
 * @returns {void}
 */
function renderToolbar() {
  const items = selectedItems();
  const any = (statuses) => items.some((i) => statuses.includes(i.status));
  $('btn-resume').disabled = !any(CAN_RESUME);
  $('btn-pause').disabled = !any(CAN_PAUSE);
  $('btn-cancel').disabled = !any(CAN_CANCEL);
  $('btn-delete').disabled = items.length === 0;
  $('btn-schedule').disabled = !any(CAN_SCHEDULE);
}

/**
 * Panel de detalles de la descarga seleccionada (si hay exactamente una).
 * @returns {void}
 */
function renderDetails() {
  const panel = $('details');
  const items = selectedItems();
  if (items.length !== 1) {
    panel.hidden = true;
    return;
  }
  const item = items[0];
  const row = (label, value, extra = '') =>
    `<div class="detail-row ${extra}"><div class="detail-label">${label}</div><div class="detail-value ${extra.includes('mono') ? 'mono' : ''}" title="${escapeHtml(value)}">${escapeHtml(value)}</div></div>`;


  // Mini-barras por segmento: muestran cómo avanza cada conexión.
  const segments = (item.segments || [])
    .map((seg, index) => {
      const length = seg.end === null ? null : seg.end - seg.start + 1;
      const pct = item.status === 'completed' ? 100 : length ? Math.min(100, (seg.downloaded / length) * 100) : 0;
      return `<div class="segment"><span>#${index + 1}</span>
        <div class="progress"><div class="progress-bar s-${item.status}" style="width:${pct}%"></div></div>
        <span class="num">${formatBytes(seg.downloaded)} / ${formatBytes(length)}</span></div>`;
    })
    .join('');

  panel.innerHTML = `
    ${row('URL', item.url, 'detail-wide mono')}
    ${row(item.status === 'completed' ? 'Guardado en' : 'Se guardará en', item.savePath || item.directory, 'detail-wide')}
    ${row('Descargado', `${formatBytes(item.downloadedBytes)} de ${formatBytes(item.totalBytes)}`)}
    ${row('Añadida', formatDateLong(item.createdAt))}
    ${row(item.completedAt ? 'Completada' : item.scheduledAt ? 'Programada para' : 'Reanudable', item.completedAt ? formatDateLong(item.completedAt) : item.scheduledAt ? formatDateLong(item.scheduledAt) : item.probed ? (item.resumable ? 'Sí' : 'No (el servidor no admite rangos)') : 'Se sabrá al empezar')}
    ${item.error ? row('Error', item.error, 'detail-wide') : ''}
    ${segments ? `<div class="detail-row detail-wide"><div class="detail-label">Conexiones (${item.segments.length})</div><div class="segments">${segments}</div></div>` : ''}`;
  panel.hidden = false;
}

/**
 * Aplica el color de la aplicación (el CSS lee el atributo data-accent).
 * @param {string} accent - 'blue', 'green', 'red'...
 * @returns {void}
 */
function applyAccent(accent) {
  document.documentElement.dataset.accent = accent || 'blue';
}

/**
 * Barra de estado inferior: velocidad total, contadores, límite y servidor.
 * @returns {void}
 */
function renderStatusbar() {
  const stats = state.stats || { totalSpeed: 0, active: 0, queued: 0 };
  $('sb-speed').textContent = stats.totalSpeed > 0 ? formatSpeed(stats.totalSpeed) : '0 B/s';
  $('sb-active').textContent = `${stats.active} activa${stats.active === 1 ? '' : 's'} · ${stats.queued} en cola`;
  const limit = state.settings?.speedLimitKBps;
  $('sb-limit').innerHTML = `${icon('gauge', 14)} ${limit ? `Límite: ${formatBytes(limit * 1024)}/s` : 'Sin límite de velocidad'}`;

  const server = state.server;
  let serverHtml = `<span class="dot-status"></span> Extensión desactivada`;
  if (server?.error) serverHtml = `<span class="dot-status err"></span> Extensión: error de puerto`;
  else if (server?.running) serverHtml = `<span class="dot-status on"></span> Extensión: puerto ${server.port}`;
  $('sb-server').innerHTML = serverHtml;
  $('sb-version').textContent = `v${state.version}`;
}

/* ===================================================================== */
/*                       ACCIONES SOBRE DESCARGAS                         */
/* ===================================================================== */

/**
 * ids seleccionados cuyo estado está en la lista dada.
 * @param {string[]} statuses
 * @returns {string[]}
 */
function selectedIdsWith(statuses) {
  return selectedItems().filter((i) => statuses.includes(i.status)).map((i) => i.id);
}

/** Pide confirmación y elimina las descargas seleccionadas. */
async function deleteSelected() {
  const items = selectedItems();
  if (!items.length) return;
  const hasCompleted = items.some((i) => i.status === 'completed');
  const { confirmed, checked } = await confirmDialog({
    title: items.length === 1 ? 'Eliminar descarga' : `Eliminar ${items.length} descargas`,
    text:
      items.length === 1
        ? `Se quitará «${items[0].fileName}» de la lista. Las partes temporales de una descarga sin terminar se borran.`
        : 'Se quitarán de la lista. Las partes temporales de descargas sin terminar se borran.',
    confirmLabel: 'Eliminar',
    checkboxLabel: hasCompleted ? 'Borrar también los archivos descargados del disco' : undefined,
  });
  if (!confirmed) return;
  await run(() => api.remove(items.map((i) => i.id), checked));
  state.selected.clear();
  scheduleRender();
}

/**
 * Menú de clic derecho sobre una fila.
 * @param {MouseEvent} event
 * @returns {void}
 */
function openRowMenu(event) {
  const items = selectedItems();
  const single = items.length === 1 ? items[0] : null;
  const any = (statuses) => items.some((i) => statuses.includes(i.status));
  showContextMenu(event, [
    { label: 'Abrir archivo', icon: 'external-link', disabled: single?.status !== 'completed', onClick: () => run(() => api.openFile(single.id)) },
    { label: 'Abrir carpeta', icon: 'folder-open', disabled: !single, onClick: () => run(() => api.openFolder(single.id)) },
    'separator',
    { label: 'Reanudar / reintentar', icon: 'play', disabled: !any(CAN_RESUME), onClick: () => run(() => api.resume(selectedIdsWith(CAN_RESUME))) },
    { label: 'Pausar', icon: 'pause', disabled: !any(CAN_PAUSE), onClick: () => run(() => api.pause(selectedIdsWith(CAN_PAUSE))) },
    { label: 'Cancelar', icon: 'square', disabled: !any(CAN_CANCEL), onClick: () => run(() => api.cancel(selectedIdsWith(CAN_CANCEL))) },
    { label: 'Programar…', icon: 'alarm-clock', disabled: !any(CAN_SCHEDULE), onClick: () => openScheduleDialog(selectedIdsWith(CAN_SCHEDULE)) },
    'separator',
    {
      label: 'Copiar URL',
      icon: 'link',
      disabled: !single,
      onClick: () => run(async () => {
        await api.copyUrl(single.id);
        toast({ title: 'URL copiada', type: 'success', duration: 1800 });
      }),
    },
    'separator',
    { label: 'Eliminar…', icon: 'trash-2', danger: true, onClick: deleteSelected },
  ]);
}

/* ===================================================================== */
/*                         SELECCIÓN DE FILAS                             */
/* ===================================================================== */

/**
 * Gestiona el clic en una fila: normal (una), Ctrl (añadir/quitar) o Mayús (rango).
 * @param {MouseEvent} event
 * @param {string} id
 * @returns {void}
 */
function handleRowClick(event, id) {
  if (event.ctrlKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  } else if (event.shiftKey && state.lastClickedId) {
    const ids = visibleItems().map((i) => i.id);
    const [from, to] = [ids.indexOf(state.lastClickedId), ids.indexOf(id)].sort((a, b) => a - b);
    if (from >= 0) {
      state.selected = new Set(ids.slice(from, to + 1));
    }
  } else {
    state.selected = new Set([id]);
  }
  state.lastClickedId = id;
  updateSelectionClasses();
}

/** Aplica la clase .selected sin repintar la tabla entera. */
function updateSelectionClasses() {
  document.querySelectorAll('#downloads-body tr').forEach((tr) => tr.classList.toggle('selected', state.selected.has(tr.dataset.id)));
  renderToolbar();
  renderDetails();
}

/* ===================================================================== */
/*                        EVENTOS DE LA INTERFAZ                          */
/* ===================================================================== */

/** Conecta todos los eventos de botones, tabla, teclado y arrastre. */
function setupEvents() {
  // --- Barra de herramientas ---
  $('btn-add').addEventListener('click', () => openAddDialog());
  $('btn-add-empty').addEventListener('click', () => openAddDialog());
  $('btn-resume').addEventListener('click', () => run(() => api.resume(selectedIdsWith(CAN_RESUME))));
  $('btn-pause').addEventListener('click', () => run(() => api.pause(selectedIdsWith(CAN_PAUSE))));
  $('btn-cancel').addEventListener('click', () => run(() => api.cancel(selectedIdsWith(CAN_CANCEL))));
  $('btn-delete').addEventListener('click', deleteSelected);
  $('btn-resume-all').addEventListener('click', () => run(() => api.resumeAll()));
  $('btn-pause-all').addEventListener('click', () => run(() => api.pauseAll()));
  $('btn-schedule').addEventListener('click', () => openScheduleDialog(selectedIdsWith(CAN_SCHEDULE)));
  $('btn-settings').addEventListener('click', () => openSettingsDialog());
  $('btn-clear-completed').addEventListener('click', () => run(() => api.clearCompleted()));

  // Tema: Sistema -> Claro -> Oscuro -> Sistema...
  $('btn-theme').addEventListener('click', () =>
    run(async () => {
      const order = ['system', 'light', 'dark'];
      const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
      await api.saveSettings({ theme: next });
      toast({ title: `Tema: ${{ system: 'según el sistema', light: 'claro', dark: 'oscuro' }[next]}`, duration: 1600 });
    }),
  );

  // Búsqueda en vivo.
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    scheduleRender();
  });

  // --- Barra lateral (delegación de eventos: un solo listener para todos los botones) ---
  $('status-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-status]');
    if (!btn) return;
    state.statusFilter = btn.dataset.status;
    scheduleRender();
  });
  $('category-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-category]');
    if (!btn) return;
    // Clic en la categoría activa = quitar el filtro.
    state.categoryFilter = state.categoryFilter === btn.dataset.category ? null : btn.dataset.category;
    scheduleRender();
  });
  $('active-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clear]');
    if (!btn) return;
    if (btn.dataset.clear === 'category') state.categoryFilter = null;
    if (btn.dataset.clear === 'search') {
      state.search = '';
      $('search').value = '';
    }
    scheduleRender();
  });

  // --- Tabla ---
  const body = $('downloads-body');
  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) handleRowClick(e, tr.dataset.id);
  });
  body.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-id]');
    const item = tr && state.items.get(tr.dataset.id);
    if (!item) return;
    if (item.status === 'completed') run(() => api.openFile(item.id));
    else if (CAN_RESUME.includes(item.status)) run(() => api.resume([item.id]));
  });
  body.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    // Si se hace clic derecho fuera de la selección, se selecciona solo esa fila.
    if (!state.selected.has(tr.dataset.id)) {
      state.selected = new Set([tr.dataset.id]);
      state.lastClickedId = tr.dataset.id;
      updateSelectionClasses();
    }
    openRowMenu(e);
  });
  // Clic en zona vacía de la tabla = deseleccionar.
  $('table-wrap').addEventListener('click', (e) => {
    if (!e.target.closest('tr[data-id]') && !e.target.closest('thead') && !e.target.closest('button')) {
      state.selected.clear();
      updateSelectionClasses();
    }
  });
  // Ordenar por columna (segundo clic invierte el orden).
  document.querySelector('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'desc' ? 'asc' : 'desc' };
    scheduleRender();
  });

  // --- Atajos de teclado ---
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea');
    const modalOpen = document.querySelector('.modal-backdrop:not([hidden])');
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openAddDialog();
    }
    if (typing || modalOpen) return;
    if (e.key === 'Delete') deleteSelected();
    if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      state.selected = new Set(visibleItems().map((i) => i.id));
      updateSelectionClasses();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // Ctrl+V fuera de un campo con una URL = abrir "Agregar descarga" con ella.
  document.addEventListener('paste', (e) => {
    if (e.target.matches('input, textarea') || document.querySelector('.modal-backdrop:not([hidden])')) return;
    const text = e.clipboardData.getData('text').trim();
    if (/^https?:\/\//i.test(text)) openAddDialog({ url: text });
  });

  // --- Arrastrar y soltar un enlace sobre la ventana ---
  document.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) {
      e.preventDefault();
      document.body.classList.add('drag-over');
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('drag-over');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('drag-over');
    const text = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split('\n')[0].trim();
    if (/^https?:\/\//i.test(text)) openAddDialog({ url: text });
    else if (text) toast({ title: 'Eso no parece un enlace http(s)', type: 'warning' });
  });
}

/* ===================================================================== */
/*                  EVENTOS QUE LLEGAN DEL PROCESO PRINCIPAL              */
/* ===================================================================== */

/**
 * Se suscribe a los eventos en vivo. Se hace ANTES de pedir el estado
 * inicial para no perder ningún mensaje.
 * @returns {void}
 */
function setupLiveEvents() {
  api.on('downloads:updated', (item) => {
    const previous = state.items.get(item.id);
    state.items.set(item.id, item);
    if (!state.categories.length) return; // Aún no hemos cargado el estado inicial.

    const tr = document.querySelector(`#downloads-body tr[data-id="${item.id}"]`);
    const shouldShow = matchesFilters(item);
    // Cambios "estructurales" -> repintado completo; si no, solo parcheamos la fila.
    if (!previous || previous.status !== item.status || Boolean(tr) !== shouldShow) {
      scheduleRender();
      if (previous && previous.status !== 'completed' && item.status === 'completed') notifyCompleted(item);
    } else if (tr) {
      patchRow(tr, item);
      if (state.selected.size === 1 && state.selected.has(item.id)) renderDetails();
    }
  });

  api.on('downloads:removed', (id) => {
    state.items.delete(id);
    state.selected.delete(id);
    scheduleRender();
  });

  api.on('stats', (stats) => {
    state.stats = stats;
    renderStatusbar();
  });

  api.on('settings:changed', (settings) => {
    state.settings = settings;
    applyAccent(settings.accent);
    renderStatusbar();
  });

  // Actualizaciones: avisamos solo cuando hay algo que decidir.
  api.on('update:status', (update) => {
    const previous = state.update?.status;
    state.update = update;
    renderUpdateStatus();
    if (update.status === previous) return;
    if (update.status === 'available') {
      toast({
        title: `Nueva versión disponible: v${update.version}`,
        text: 'Descárgala cuando quieras; no se instalará sin tu permiso.',
        duration: 0,
        actions: [
          { label: 'Descargar', primary: true, onClick: () => api.downloadUpdate().catch(() => {}) },
          { label: 'Más tarde', onClick: () => {} },
        ],
      });
    } else if (update.status === 'downloaded') {
      toast({
        title: `v${update.version} lista para instalar`,
        text: 'Se reiniciará la app. Las descargas en curso se guardan.',
        type: 'success',
        duration: 0,
        actions: [
          { label: 'Reiniciar e instalar', primary: true, onClick: () => api.installUpdate().catch(() => {}) },
          { label: 'Más tarde', onClick: () => {} },
        ],
      });
    }
  });

  api.on('server:status', (server) => {
    state.server = server;
    renderStatusbar();
    renderServerStatus();
  });

  // Enlace copiado al portapapeles.
  api.on('clipboard:url', (url) => {
    const duplicate = [...state.items.values()].some((i) => i.url === url);
    const name = decodeURIComponent(url.split('?')[0].split('/').pop() || url);
    toast({
      title: 'Enlace de descarga detectado',
      text: duplicate ? `${name} (ya está en tu lista)` : name,
      duration: 9000,
      actions: [
        { label: 'Descargar', primary: true, onClick: () => openAddDialog({ url }) },
        { label: 'Ignorar', onClick: () => {} },
      ],
    });
  });

  // URL enviada por la extensión del navegador (con confirmación activada).
  api.on('browser:request', ({ requestId, url, fileName }) => openAddDialog({ url, fileName, browserRequestId: requestId }));

  // Petición de abrir el diálogo desde la bandeja o una notificación.
  api.on('ui:open-add', (prefill) => openAddDialog(prefill || {}));
}

/**
 * Aviso dentro de la app cuando termina una descarga.
 * @param {object} item
 * @returns {void}
 */
function notifyCompleted(item) {
  toast({
    title: 'Descarga completada',
    text: `${item.fileName} · ${formatBytes(item.totalBytes)}`,
    type: 'success',
    duration: 7000,
    actions: [
      { label: 'Abrir', primary: true, onClick: () => run(() => api.openFile(item.id)) },
      { label: 'Carpeta', onClick: () => run(() => api.openFolder(item.id)) },
    ],
  });
}

/* ===================================================================== */
/*                                ARRANQUE                                */
/* ===================================================================== */

/**
 * Inicializa la interfaz.
 * @returns {Promise<void>}
 */
async function init() {
  setupLiveEvents();
  hydrateIcons(document); // Rellena los <span data-icon> del HTML estático.
  setupModals();
  setupDialogs();
  setupEvents();

  try {
    const initial = await api.getState();
    state.settings = initial.settings;
    applyAccent(initial.settings.accent);
    state.categories = initial.categories;
    state.server = initial.server;
    state.stats = initial.stats;
    state.version = initial.version;
    state.update = initial.update;
    // Mezclamos con lo que haya llegado por eventos mientras esperábamos.
    for (const item of initial.items) if (!state.items.has(item.id)) state.items.set(item.id, item);
    renderAll();
  } catch (err) {
    toast({ title: 'No se pudo cargar el estado', text: err.message, type: 'error', duration: 0 });
  }
}

init();
