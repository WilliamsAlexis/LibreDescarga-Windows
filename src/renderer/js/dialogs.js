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
import { formatBytes, escapeHtml, toDateTimeLocal, formatDateLong, formatDuration } from './format.js';
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
 * Resultado del análisis de la URL actual cuando es un vídeo o una lista
 * (null = archivo directo o aún sin analizar). Ver mediaService.js.
 */
let media = null;
let analyzing = false; // true mientras se analiza la URL (se bloquea el botón Descargar).
let analysisFailed = false; // true si el análisis dio error.

/** Sitios de vídeo conocidos: si su análisis falla no dejamos descargar la "página" como si fuera un archivo. */
const MEDIA_SITE = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|soundcloud\.com|bandcamp\.com)$/i;

/** Alturas que se ofrecen en una lista (no se sabe la de cada vídeo hasta descargarlo). */
const PLAYLIST_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

/**
 * Valor del botón de opción marcado de un grupo.
 * @param {string} name - Atributo name de los radios.
 * @returns {string|undefined}
 */
function radioValue(name) {
  return document.querySelector(`input[name=${name}]:checked`)?.value;
}

/**
 * Muestra u oculta el campo que solo vale para archivos directos
 * (el nombre) y el panel de vídeo/audio.
 * @param {'direct'|'media'} mode
 * @returns {void}
 */
function setAddMode(mode) {
  document.querySelectorAll('#form-add [data-direct-only]').forEach((el) => (el.hidden = mode === 'media'));
  $('add-media').hidden = mode !== 'media';
}

/**
 * Activa o desactiva los botones de descargar.
 * @param {boolean} disabled
 * @returns {void}
 */
function setAddButtonsDisabled(disabled) {
  $('add-submit').disabled = disabled;
  $('add-paused').disabled = disabled;
}

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
  $('add-schedule-at').disabled = true;
  $('add-probe').hidden = true;
  media = null;
  analyzing = false;
  analysisFailed = false;
  probeCounter++; // Descarta análisis pendientes del uso anterior del diálogo.
  setAddMode('direct');
  setAddButtonsDisabled(false);
  showFormError('add-error', '');
  openModal('modal-add');
  if (prefill.url) probeUrl(prefill.url);
}

/**
 * Analiza la URL y muestra lo que hay detrás: archivo directo, vídeo o lista.
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.playlist=false] - true = cargar la lista completa.
 * @returns {Promise<void>}
 */
async function probeUrl(url, { playlist = false } = {}) {
  const box = $('add-probe');
  let parsed;
  try {
    parsed = new URL(url); // Si no es una URL válida, no analizamos.
  } catch {
    box.hidden = true;
    media = null;
    analyzing = false;
    setAddMode('direct');
    setAddButtonsDisabled(false);
    return;
  }
  const myTurn = ++probeCounter;
  media = null;
  analyzing = true;
  analysisFailed = false;
  setAddMode('direct');
  setAddButtonsDisabled(true);
  box.className = 'probe-info';
  box.innerHTML = `${icon('loader-circle', 16, 'spin')}<span>Analizando el enlace…</span>`;
  box.hidden = false;

  try {
    const info = await window.api.resolveUrl(url, { playlist });
    if (myTurn !== probeCounter) return; // Llegó tarde: el usuario ya cambió la URL.
    analyzing = false;
    setAddButtonsDisabled(false);

    if (info.kind === 'direct') {
      const resumeTag = info.resumable
        ? `<span class="tag">Reanudable · descarga por partes</span>`
        : `<span class="tag no">Sin reanudación · 1 conexión</span>`;
      box.innerHTML = `${icon('file-check', 16)}<span><strong>${escapeHtml(info.fileName)}</strong> · ${formatBytes(info.totalBytes)}</span>${resumeTag}`;
      $('add-name').placeholder = info.fileName;
      return;
    }

    media = info;
    box.hidden = true;
    renderMedia(info);
  } catch (err) {
    if (myTurn !== probeCounter) return;
    analyzing = false;
    analysisFailed = true;
    box.className = 'probe-info error';
    box.innerHTML = `${icon('circle-alert', 16)}<span>${escapeHtml(err.message)}</span>`;
    // Una página de vídeo no se puede descargar como si fuera un archivo.
    setAddButtonsDisabled(MEDIA_SITE.test(parsed.hostname));
  }
}

/**
 * Pinta las opciones de un vídeo o de una lista.
 * @param {object} info - Resultado de resolveUrl (kind 'video' o 'playlist').
 * @returns {void}
 */
function renderMedia(info) {
  setAddMode('media');
  const isList = info.kind === 'playlist';

  // --- Tarjeta con miniatura y datos ---
  const thumb = $('media-thumb');
  thumb.hidden = !info.thumbnail;
  if (info.thumbnail) thumb.src = info.thumbnail;
  $('media-title').textContent = info.title;
  const bits = isList
    ? [info.uploader, `${info.count} vídeos`]
    : [info.uploader, formatDuration(info.duration)];
  $('media-meta').textContent = bits.filter(Boolean).join(' · ');

  // --- Aviso: "este vídeo también está en una lista" ---
  $('media-playlist-hint').hidden = isList || !info.hasPlaylist;

  // --- Lista de elementos con casillas ---
  $('media-list').hidden = !isList;
  if (isList) {
    $('media-entries').innerHTML = info.entries
      .map(
        (e, i) => `<label class="media-entry">
          <input type="checkbox" data-index="${i}" checked />
          <span class="entry-title" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</span>
          <span class="entry-duration">${formatDuration(e.duration)}</span>
        </label>`,
      )
      .join('');
  }

  // --- Calidades de vídeo ---
  // Cada calidad es un botón de opción; la primera (la mejor) viene marcada.
  // Si hay muchas (hasta 8), se reparten en varias filas.
  const chip = (value, label, small = '', bytes = '') =>
    `<label class="opt"><input type="radio" name="media-height" value="${value}" data-bytes="${bytes}" /><span>${label}${small ? ` <small>${small}</small>` : ''}</span></label>`;
  let chips = '';
  if (isList) {
    chips = chip('', 'La mejor') + PLAYLIST_HEIGHTS.map((h) => chip(h, `${h}p`, 'si existe')).join('');
  } else if (info.hasVideo) {
    chips = info.heights.length
      ? info.heights.map((h, i) => chip(h.height, i === 0 ? `${h.label} · la mejor` : h.label, h.approxBytes ? `~${formatBytes(h.approxBytes)}` : '', h.approxBytes || '')).join('')
      : chip('', 'La mejor disponible');
  }
  $('media-height-group').innerHTML = chips;
  const firstQuality = document.querySelector('input[name=media-height]');
  if (firstQuality) firstQuality.checked = true;

  // Si solo es audio (p. ej. SoundCloud), no se ofrece vídeo.
  const videoRadio = document.querySelector('input[name=media-mode][value=video]');
  const audioRadio = document.querySelector('input[name=media-mode][value=audio]');
  videoRadio.disabled = !isList && !info.hasVideo;
  (videoRadio.disabled ? audioRadio : videoRadio).checked = true;
  // Por defecto, en YouTube Music y similares tiene más sentido el audio.
  if (!videoRadio.disabled && /music\.youtube\.com/i.test(info.url || '')) audioRadio.checked = true;
  updateMediaMode();
}

/**
 * Muestra las opciones de vídeo o de audio según lo elegido y actualiza el botón.
 * @returns {void}
 */
function updateMediaMode() {
  const mode = document.querySelector('input[name=media-mode]:checked')?.value || 'video';
  $('media-video-opts').hidden = mode !== 'video';
  $('media-audio-opts').hidden = mode !== 'audio';
  $('media-audio-quality-field').hidden = radioValue('media-audio-format') === 'opus'; // OPUS no usa kbps.
  updateMediaButton();
}

/**
 * Ajusta el texto del botón principal ("Descargar", "Descargar 5 vídeos"...).
 * @returns {void}
 */
function updateMediaButton() {
  if (!media) return;
  const label = $('add-submit').lastElementChild;
  if ($('add-schedule-on').checked) {
    label.textContent = 'Programar';
    return;
  }
  if (media.kind === 'playlist') {
    const n = selectedEntries().length;
    const noun = document.querySelector('input[name=media-mode]:checked')?.value === 'audio' ? 'canciones' : 'vídeos';
    label.textContent = n ? `Descargar ${n} ${n === 1 ? noun.slice(0, -1) : noun}` : 'Descargar';
    $('add-submit').disabled = n === 0 || analyzing;
    $('add-paused').disabled = n === 0 || analyzing;
    $('media-list-count').textContent = `${n} de ${media.count} seleccionados`;
  } else {
    label.textContent = 'Descargar';
  }
}

/**
 * Elementos marcados de la lista.
 * @returns {Array<{url:string, title:string}>}
 */
function selectedEntries() {
  if (media?.kind !== 'playlist') return [];
  return [...document.querySelectorAll('#media-entries input:checked')].map((box) => media.entries[Number(box.dataset.index)]);
}

/**
 * Envía el formulario de "Agregar descarga".
 * @param {boolean} startNow - false = añadir en pausa.
 * @returns {Promise<void>}
 */
async function submitAdd(startNow) {
  showFormError('add-error', '');
  if (analyzing) return; // Aún no sabemos qué es el enlace.
  const form = $('form-add');
  const browserRequestId = form.dataset.browserRequestId || undefined;
  let scheduledAt;

  if ($('add-schedule-on').checked) {
    const when = new Date($('add-schedule-at').value).getTime();
    if (!Number.isFinite(when) || when <= Date.now()) {
      showFormError('add-error', 'Elige una fecha y hora futuras para programar la descarga.');
      return;
    }
    scheduledAt = when;
  }

  try {
    if (media) {
      await submitMedia({ startNow, scheduledAt, browserRequestId });
      return;
    }
    const data = {
      url: $('add-url').value.trim(),
      fileName: $('add-name').value.trim(),
      directory: $('add-dir').value.trim(),
      startNow,
      browserRequestId,
      source: browserRequestId ? 'browser' : 'manual',
      scheduledAt,
    };
    const item = await window.api.addDownload(data);
    closeModal('modal-add');
    const text = item.status === 'scheduled' ? `Empezará el ${formatDateLong(item.scheduledAt)}` : item.fileName;
    toast({ title: item.status === 'scheduled' ? 'Descarga programada' : 'Descarga añadida', text, type: 'success', duration: 3000 });
  } catch (err) {
    showFormError('add-error', err.message);
  }
}

/**
 * Añade el vídeo/audio (o los elegidos de una lista) con las opciones del formulario.
 * @param {object} extra
 * @param {boolean} extra.startNow
 * @param {number} [extra.scheduledAt]
 * @param {string} [extra.browserRequestId]
 * @returns {Promise<void>}
 */
async function submitMedia({ startNow, scheduledAt, browserRequestId }) {
  const mode = document.querySelector('input[name=media-mode]:checked')?.value === 'audio' ? 'audio' : 'video';
  const heightOption = document.querySelector('input[name=media-height]:checked');
  const data = {
    mode,
    height: mode === 'video' && heightOption?.value ? Number(heightOption.value) : null,
    audioFormat: radioValue('media-audio-format') || 'mp3',
    audioQuality: Number(radioValue('media-audio-quality')) || 0,
    directory: $('add-dir').value.trim(),
    startNow,
    scheduledAt,
    browserRequestId,
    source: browserRequestId ? 'browser' : 'manual',
  };

  if (media.kind === 'playlist') {
    data.entries = selectedEntries().map((e) => ({ url: e.url, title: e.title }));
    if (!data.entries.length) throw new Error('Marca al menos un vídeo de la lista.');
  } else {
    data.url = media.url;
    data.title = media.title;
    // Tamaño aproximado para que el porcentaje sea fiable desde el principio.
    data.estimatedBytes = mode === 'audio' ? media.audioApproxBytes : Number(heightOption?.dataset.bytes) || null;
  }

  const result = await window.api.addMedia(data);
  closeModal('modal-add');
  const many = result.count > 1;
  toast({
    title: scheduledAt ? 'Descarga programada' : many ? `${result.count} descargas añadidas` : 'Descarga añadida',
    text: many ? media.title : result.first.fileName,
    type: 'success',
    duration: 3000,
  });
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

  $('add-schedule-on').addEventListener('change', (e) => {
    const input = $('add-schedule-at');
    input.disabled = !e.target.checked;
    if (e.target.checked && !input.value) input.value = toDateTimeLocal(new Date(Date.now() + 3600_000));
    // Si se programa, el botón principal cambia de texto.
    $('add-submit').lastElementChild.textContent = e.target.checked ? 'Programar' : 'Descargar';
    updateMediaButton();
  });

  // --- Vídeo y audio ---
  document.querySelectorAll('input[name=media-mode]').forEach((r) => r.addEventListener('change', updateMediaMode));
  $('media-audio-opts').addEventListener('change', updateMediaMode);
  $('media-entries').addEventListener('change', updateMediaButton);
  $('media-select-all').addEventListener('click', () => {
    document.querySelectorAll('#media-entries input').forEach((box) => (box.checked = true));
    updateMediaButton();
  });
  $('media-select-none').addEventListener('click', () => {
    document.querySelectorAll('#media-entries input').forEach((box) => (box.checked = false));
    updateMediaButton();
  });
  // "Ver la lista completa": vuelve a analizar el enlace como lista.
  $('media-load-playlist').addEventListener('click', () => probeUrl($('add-url').value.trim(), { playlist: true }));

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
 * Pide la versión del motor de vídeo y la muestra en Configuración.
 * @returns {Promise<void>}
 */
async function loadEngineInfo() {
  const box = $('engine-text');
  box.textContent = 'Comprobando…';
  try {
    const info = await window.api.engineInfo();
    box.textContent = info.available
      ? `yt-dlp ${info.version || '(versión desconocida)'} · ffmpeg incluido`
      : 'No se encontraron yt-dlp/ffmpeg. Reinstala la aplicación o ejecuta "npm run tools".';
  } catch (err) {
    box.textContent = err.message;
  }
}

/**
 * Cambia de pestaña en Configuración.
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
  document.querySelectorAll('input[name=accent]').forEach((r) => (r.checked = r.value === (s.accent || 'blue')));
  $('set-cookies-browser').value = s.cookiesBrowser || '';
  renderUpdateStatus();
  loadEngineInfo();
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

  // Color de la aplicación: se aplica y guarda al momento (el evento 'settings:changed' lo pinta).
  $('accent-swatches').addEventListener('change', async (event) => {
    try {
      await window.api.saveSettings({ accent: event.target.value });
    } catch (err) {
      toast({ title: 'No se pudo cambiar el color', text: err.message, type: 'error' });
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

  // Motor de vídeo (yt-dlp): actualizar a la última versión.
  $('engine-update').addEventListener('click', async () => {
    const button = $('engine-update');
    button.disabled = true;
    $('engine-text').textContent = 'Actualizando… (puede tardar un minuto)';
    try {
      const result = await window.api.updateEngine();
      toast({ title: result.message, type: 'success', duration: 3500 });
    } catch (err) {
      toast({ title: 'No se pudo actualizar el motor', text: err.message, type: 'error' });
    }
    button.disabled = false;
    loadEngineInfo();
  });

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
      cookiesBrowser: $('set-cookies-browser').value,
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
