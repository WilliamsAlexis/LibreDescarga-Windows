/**
 * main.js
 * -----------------------------------------------------------------------------
 * PUNTO DE ENTRADA de la aplicación (proceso principal de Electron).
 *
 * Responsabilidades:
 *   1. Garantizar que solo haya UNA instancia abierta.
 *   2. Crear la ventana con opciones de seguridad estrictas.
 *   3. Crear los servicios: almacenamiento, gestor de descargas, limitador,
 *      programador, vigilante del portapapeles y servidor del navegador.
 *   4. Conectar los eventos de los servicios con la interfaz, la bandeja y
 *      las notificaciones.
 *   5. Cerrar todo de forma ordenada (guardando el progreso) al salir.
 * -----------------------------------------------------------------------------
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, Menu, nativeTheme, shell } = require('electron');

const { createStores } = require('./stores');
const { registerIpc } = require('./ipc');
const { createTray } = require('./tray');
const { showNotification } = require('./notifications');
const { ClipboardWatcher } = require('./clipboardWatcher');
const { DownloadManager } = require('../services/downloadManager');
const { SpeedLimiter } = require('../services/speedLimiter');
const { Scheduler } = require('../services/scheduler');
const { BrowserServer } = require('../services/browserServer');
const { Updater } = require('../services/updater');
const { MediaTools } = require('../services/mediaTools');
const { MediaService } = require('../services/mediaService');
const { formatBytes, formatSpeed } = require('../utils/format');
const { looksLikeVideoPageUrl } = require('../utils/categories');

// Red de seguridad: si algún error se escapa sin capturar, lo registramos.
// Sin esto, Electron muestra un cuadro de diálogo modal que congela la app
// (y las descargas) hasta que alguien pulse "Aceptar".
process.on('uncaughtException', (err) => console.error('Error no capturado:', err));
process.on('unhandledRejection', (reason) => console.error('Promesa rechazada sin capturar:', reason));

/** Estado global del proceso principal (todo en un único objeto para que sea fácil de seguir). */
const state = {
  window: null,
  tray: null,
  addWindow: null, // Ventana pequeña "Agregar descarga" (para la extensión y los avisos)
  stores: null,
  manager: null,
  scheduler: null,
  updater: null,
  updateTimer: null,
  engineTimer: null,
  server: null,
  serverError: null,
  clipboardWatcher: null,
  statsTimer: null,
  browserRequests: new Map(), // requestId -> { headers, createdAt }
  startHidden: process.argv.includes('--hidden'), // Windows nos abrió al iniciar sesión: arrancamos en la bandeja
  isQuitting: false, // true cuando el usuario eligió salir de verdad
  quitReady: false, // true cuando ya guardamos todo y podemos cerrar
  trayHintShown: false,
};

/** Carpeta de la extensión: dentro de "resources" en la app instalada, o en el proyecto en desarrollo. */
const EXTENSION_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'extension')
  : path.join(__dirname, '../../extension');

/* ---------------------------------------------------------------------------
 * Utilidades de ventana
 * ------------------------------------------------------------------------- */

/**
 * Envía un mensaje a la interfaz (si la ventana existe).
 * @param {string} channel - Nombre del canal.
 * @param {*} payload - Datos.
 * @returns {void}
 */
function send(channel, payload) {
  const win = state.window;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Muestra la ventana (la crea si no existe) y la trae al frente.
 * @returns {void}
 */
function showWindow() {
  if (!state.window || state.window.isDestroyed()) createWindow();
  if (state.window.isMinimized()) state.window.restore();
  state.window.show();
  state.window.focus();
}

/**
 * Abre la ventana PEQUEÑA "Agregar descarga" sin mostrar la aplicación completa.
 * La usan la extensión del navegador y los avisos de enlaces copiados: la app
 * puede seguir oculta en la bandeja. Si la ventana ya está abierta, la reutiliza
 * (cambia el enlace que muestra) en vez de abrir otra.
 * Es la misma interfaz (index.html) en "modo ventana": solo enseña el diálogo.
 * @param {object} [options]
 * @param {string} [options.url] - Enlace a analizar.
 * @param {string} [options.fileName] - Nombre sugerido.
 * @param {string} [options.requestId] - Petición de la extensión (guarda cookies y cabeceras).
 * @returns {void}
 */
function openAddWindow({ url = '', fileName = '', requestId = '' } = {}) {
  const existing = state.addWindow;
  if (existing && !existing.isDestroyed()) {
    existing.webContents.send('browser:request', { requestId, url, fileName });
    bringToFront(existing);
    return;
  }
  const win = new BrowserWindow({
    width: 660,
    height: 780,
    minWidth: 520,
    minHeight: 460,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7fb',
    icon: path.join(__dirname, '../../assets/icon.png'),
    title: 'Agregar descarga · LibreDescarga',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { popup: 'add', url, fileName, requestId } });
  win.once('ready-to-show', () => bringToFront(win));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('closed', () => {
    state.addWindow = null;
  });
  state.addWindow = win;
}

/**
 * Trae una ventana al frente. Windows no deja que una app en segundo plano
 * "robe" el foco, así que la ponemos un instante siempre-encima.
 * @param {Electron.BrowserWindow} win
 * @returns {void}
 */
function bringToFront(win) {
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  setTimeout(() => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(false);
  }, 800);
}

/**
 * Envía un mensaje cuando la interfaz esté lista (útil si la ventana se acaba de crear).
 * @param {string} channel
 * @param {*} payload
 * @returns {void}
 */
function sendWhenReady(channel, payload) {
  const contents = state.window?.webContents;
  if (!contents) return;
  if (contents.isLoading()) contents.once('did-finish-load', () => send(channel, payload));
  else send(channel, payload);
}

/**
 * Crea la ventana principal con la configuración de seguridad recomendada.
 * @returns {void}
 */
function createWindow() {
  const isDark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 920,
    minHeight: 560,
    show: false, // La mostramos cuando esté pintada (evita un parpadeo blanco).
    backgroundColor: isDark ? '#0f1115' : '#f6f7fb',
    icon: path.join(__dirname, '../../assets/icon.png'),
    title: 'LibreDescarga',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true, // La interfaz y el preload viven en mundos separados.
      nodeIntegration: false, // La interfaz NO puede usar require() ni Node.
      sandbox: true, // El renderer corre en la "caja de arena" de Chromium.
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // Si Windows nos abrió al iniciar sesión (--hidden), nos quedamos en la bandeja sin mostrar la ventana.
  win.once('ready-to-show', () => {
    if (state.startHidden) state.startHidden = false;
    else win.show();
  });

  // Seguridad: la interfaz nunca debe abrir ventanas nuevas ni navegar a otra página.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // En desarrollo, mostramos en la terminal los mensajes de consola de la interfaz.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (event, ...legacy) => {
      const message = event.message ?? legacy[1];
      const level = event.level ?? legacy[0];
      console.log(`[renderer:${level}] ${message}`);
    });
  }

  // Al pulsar la X: si está activado, escondemos la ventana en la bandeja.
  win.on('close', (event) => {
    if (state.isQuitting || !state.stores.getSettings().minimizeToTray) return;
    event.preventDefault();
    win.hide();
    if (!state.trayHintShown) {
      state.trayHintShown = true;
      showNotification({
        title: 'LibreDescarga sigue funcionando',
        body: 'La app continúa en la bandeja del sistema. Usa clic derecho en el icono para salir.',
        onClick: showWindow,
      });
    }
  });

  win.on('closed', () => {
    state.window = null;
  });
  state.window = win;
}

/* ---------------------------------------------------------------------------
 * Servicios
 * ------------------------------------------------------------------------- */

/** @returns {object} Configuración actual. */
const getSettings = () => state.stores.getSettings();

/** @returns {{running:boolean, port:number|null, error:string|null}} Estado del servidor local. */
function getServerStatus() {
  return { running: state.server?.running ?? false, port: state.server?.port ?? null, error: state.serverError };
}

/**
 * Arranca o detiene el servidor del navegador según la configuración.
 * @returns {Promise<void>}
 */
async function syncBrowserServer() {
  state.serverError = null;
  try {
    if (getSettings().serverEnabled) await state.server.start();
    else await state.server.stop();
  } catch (err) {
    state.serverError = err.message;
    console.error('Servidor del navegador:', err.message);
  }
  send('server:status', getServerStatus());
}

/**
 * Registra (o quita) la app en el inicio de Windows. Se abre con --hidden para
 * quedarse en la bandeja, sin ventana. Solo en la app instalada: en desarrollo
 * registraríamos electron.exe, que no es nuestra app.
 * @param {boolean} enabled
 * @returns {void}
 */
function applyStartupSetting(enabled) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
  } catch (err) {
    console.error('No se pudo configurar el inicio con Windows:', err.message);
  }
}

/**
 * Guarda la configuración y aplica sus efectos (tema, límites, servidor...).
 * @param {object} changes - Cambios parciales.
 * @returns {Promise<object>} Configuración resultante.
 */
async function updateSettings(changes) {
  const before = getSettings();
  const after = state.stores.saveSettings(changes);

  nativeTheme.themeSource = after.theme; // 'system' | 'light' | 'dark'
  state.manager.applySettings(); // límite de velocidad + tamaño de la cola

  if (after.clipboardWatch) state.clipboardWatcher.start();
  else state.clipboardWatcher.stop();

  if (before.launchAtStartup !== after.launchAtStartup) applyStartupSetting(after.launchAtStartup);

  if (before.serverEnabled !== after.serverEnabled || before.serverPort !== after.serverPort) {
    await syncBrowserServer();
  }
  send('settings:changed', after);
  return after;
}

/**
 * Atiende una URL recibida desde la extensión del navegador.
 * @param {{url:string, fileName:string, referrer:string, cookies:string, userAgent:string}} payload
 * @returns {Promise<object>} Respuesta para la extensión.
 */
async function handleBrowserDownload(payload) {
  let url;
  try {
    url = new URL(payload.url);
  } catch {
    throw new Error('URL no válida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Solo se admiten URLs http(s)');

  // Cabeceras para que el servidor nos trate igual que al navegador.
  const headers = {};
  if (/^https?:\/\//.test(payload.referrer)) headers.Referer = payload.referrer;
  if (payload.cookies) headers.Cookie = payload.cookies;
  if (payload.userAgent) headers['User-Agent'] = payload.userAgent;

  // Las páginas de vídeo (payload.page) SIEMPRE pasan por el diálogo: hay que elegir calidad o formato.
  if (payload.page || getSettings().browserConfirm) {
    // Mostramos el diálogo "Agregar descarga" relleno. Las cabeceras se quedan
    // aquí guardadas con un id; la interfaz solo recibe el id.
    const requestId = crypto.randomUUID();
    state.browserRequests.set(requestId, { headers, createdAt: Date.now() });
    // Limpiamos peticiones abandonadas de hace más de 1 hora.
    for (const [id, req] of state.browserRequests) {
      if (Date.now() - req.createdAt > 3600_000) state.browserRequests.delete(id);
    }
    openAddWindow({ url: url.href, fileName: payload.fileName || '', requestId });
    return { pending: true };
  }

  const item = state.manager.add({ url: url.href, fileName: payload.fileName, headers, source: 'browser' });
  return { id: item.id, fileName: item.fileName };
}

/**
 * Conecta los eventos del gestor con la interfaz, las notificaciones y la bandeja.
 * @returns {void}
 */
function wireManagerEvents() {
  const { manager } = state;
  manager.on('item-updated', (item) => send('downloads:updated', item));
  manager.on('item-removed', (id) => send('downloads:removed', id));

  manager.on('completed', (item) => {
    if (!getSettings().notifications) return;
    showNotification({
      title: 'Descarga completada',
      body: `${item.fileName} (${formatBytes(item.totalBytes)})`,
      onClick: () => shell.showItemInFolder(item.savePath),
    });
  });

  manager.on('failed', (item) => {
    if (!getSettings().notifications) return;
    showNotification({ title: 'Error en la descarga', body: `${item.fileName}: ${item.error}`, onClick: showWindow });
  });

  // Cada segundo: estadísticas para la barra de estado, la bandeja y la barra de tareas.
  state.statsTimer = setInterval(() => {
    const stats = manager.getStats();
    state.tray?.update(stats, formatSpeed);
    if (state.window && !state.window.isDestroyed()) {
      // Progreso verde en el icono de la barra de tareas (-1 = quitarlo).
      state.window.setProgressBar(stats.active && stats.progress !== null ? stats.progress : -1);
    }
    send('stats', stats);
  }, 1000);
}

/**
 * Instala la actualización ya descargada. Primero hacemos el cierre ordenado
 * (pausar descargas y guardar el progreso) y después dejamos que el instalador
 * cierre la app; así no se pierde nada de lo que había en curso.
 * @returns {Promise<boolean>} true si se inició la instalación.
 */
async function installUpdate() {
  if (state.updater?.state.status !== 'downloaded') return false;
  state.isQuitting = true;
  await shutdown();
  state.quitReady = true; // Evita que before-quit repita el cierre.
  return state.updater.install();
}

/**
 * Cierre ordenado: detiene servicios, pausa descargas y guarda todo.
 * @returns {Promise<void>}
 */
async function shutdown() {
  try {
    clearInterval(state.statsTimer);
    clearTimeout(state.updateTimer);
    clearTimeout(state.engineTimer);
    state.scheduler?.stop();
    state.clipboardWatcher?.stop();
    await state.server?.stop();
    await state.manager?.shutdown();
    state.tray?.tray.destroy();
  } catch (err) {
    console.error('Error al cerrar:', err);
  }
}

/* ---------------------------------------------------------------------------
 * Arranque
 * ------------------------------------------------------------------------- */

/**
 * Inicializa todo cuando Electron está listo.
 * @returns {Promise<void>}
 */
async function bootstrap() {
  // Necesario en Windows para que las notificaciones muestren el nombre de la app.
  app.setAppUserModelId(app.isPackaged ? 'com.libredescarga.app' : process.execPath);
  Menu.setApplicationMenu(null); // Sin la barra de menús clásica.

  state.stores = createStores(app.getPath('downloads'));
  nativeTheme.themeSource = getSettings().theme;
  applyStartupSetting(getSettings().launchAtStartup); // Mantiene el inicio con Windows al día (también tras actualizar).

  // Herramientas de vídeo/audio (yt-dlp + ffmpeg). Se copia yt-dlp a una carpeta escribible para poder actualizarlo.
  state.mediaTools = new MediaTools({
    bundledDir: app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(__dirname, '../../tools'),
    userDir: path.join(app.getPath('userData'), 'tools'),
  });
  await state.mediaTools.prepare();
  state.media = new MediaService({ tools: state.mediaTools, getSettings });

  state.manager = new DownloadManager({
    storage: state.stores.downloadsStorage,
    getSettings,
    limiter: new SpeedLimiter(),
    mediaTools: state.mediaTools,
  });
  state.manager.init();

  state.clipboardWatcher = new ClipboardWatcher((url) => {
    // Si estás usando la ventana (tiene el foco), el aviso sale dentro de la app.
    // En cualquier otro caso (oculta en la bandeja, minimizada o detrás de otra
    // ventana) lanzamos una notificación de Windows, que sí se ve.
    const win = state.window;
    if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()) {
      send('clipboard:url', url);
    } else {
      const isVideo = looksLikeVideoPageUrl(url);
      showNotification({
        title: isVideo ? 'Vídeo o música detectado' : 'Enlace de descarga detectado',
        body: `${url.length > 90 ? url.slice(0, 87) + '…' : url}\nHaz clic para elegir calidad y descargarlo.`,
        onClick: () => openAddWindow({ url }),
      });
    }
  });

  state.server = new BrowserServer({ getSettings, onDownload: handleBrowserDownload, version: app.getVersion() });

  // Solo la app instalada puede actualizarse (en desarrollo no hay instalador).
  state.updater = new Updater({ enabled: app.isPackaged, currentVersion: app.getVersion() });
  state.updater.on('status', (status) => send('update:status', status));

  registerIpc({
    notifyAdded: (text) => showNotification({ title: 'Descarga iniciada', body: text, onClick: showWindow }),
    media: state.media,
    mediaTools: state.mediaTools,
    updater: state.updater,
    installUpdate,
    manager: state.manager,
    getSettings,
    updateSettings,
    getWindow: () => state.window,
    getServerStatus,
    takeBrowserRequest: (id) => {
      const req = state.browserRequests.get(id);
      state.browserRequests.delete(id);
      return req;
    },
    clipboardWatcher: state.clipboardWatcher,
    extensionDir: EXTENSION_DIR,
  });

  createWindow();

  state.tray = createTray({
    onShow: showWindow,
    onAddUrl: () => {
      showWindow();
      sendWhenReady('ui:open-add', {});
    },
    onPauseAll: () => state.manager.pauseAll(),
    onResumeAll: () => state.manager.resumeAll(),
    onQuit: () => app.quit(),
  });

  wireManagerEvents();

  state.scheduler = new Scheduler(state.manager, (items) => {
    if (!getSettings().notifications) return;
    showNotification({
      title: 'Descargas programadas iniciadas',
      body: items.map((i) => i.fileName).join(', '),
      onClick: showWindow,
    });
  });
  state.scheduler.start();

  if (getSettings().clipboardWatch) state.clipboardWatcher.start();
  await syncBrowserServer();

  // Buscar actualizaciones poco después de arrancar (si el usuario no lo desactivó).
  // El aviso llega a la interfaz mediante el evento 'update:status'.
  if (state.updater.state.status !== 'unavailable') {
    state.updateTimer = setTimeout(() => {
      if (getSettings().autoUpdateCheck) state.updater.check();
    }, 15000);
  }

  // yt-dlp se rompe cuando YouTube cambia; lo actualizamos en silencio (como mucho cada 3 días).
  state.engineTimer = setTimeout(() => {
    if (getSettings().autoUpdateCheck && app.isPackaged) state.mediaTools.autoUpdate();
  }, 45000);
}

// Solo una instancia: si ya hay una abierta, le pedimos que se muestre y salimos.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('Error fatal al iniciar:', err);
    app.exit(1);
  });

  // Antes de salir: guardamos todo. La primera vez cancelamos la salida,
  // hacemos el cierre ordenado y luego volvemos a pedir salir.
  app.on('before-quit', (event) => {
    if (state.quitReady) return;
    event.preventDefault();
    if (state.isQuitting) return; // Ya estamos cerrando.
    state.isQuitting = true;
    shutdown().finally(() => {
      state.quitReady = true;
      app.quit();
    });
  });

  // Si se cierran todas las ventanas (bandeja desactivada), salimos.
  app.on('window-all-closed', () => {
    if (!state.isQuitting && !state.tray) app.quit(); // Con la bandeja, la app sigue en segundo plano.
  });
}
