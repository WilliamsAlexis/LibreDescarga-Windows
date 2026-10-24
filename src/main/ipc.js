/**
 * ipc.js
 * -----------------------------------------------------------------------------
 * CANALES IPC (Inter-Process Communication).
 *
 * En Electron hay dos mundos separados por seguridad:
 *   - Proceso principal (este): tiene Node.js, disco, red...
 *   - Renderer (la interfaz): es como una página web, SIN acceso a Node.
 *
 * El renderer pide cosas llamando a funciones de `window.api` (definidas en
 * preload.js), que a su vez envían mensajes con ipcRenderer.invoke(). Aquí
 * los recibimos con ipcMain.handle(), VALIDAMOS los datos y respondemos.
 *
 * Regla de oro: nunca confiar en lo que llega del renderer. Por eso cada
 * canal comprueba tipos y el remitente.
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const { ipcMain, shell, dialog, clipboard, app } = require('electron');
const { probe } = require('../utils/http');
const { CATEGORIES } = require('../utils/categories');
const { generateToken } = require('../services/settingsService');

/**
 * Comprueba que el mensaje viene de NUESTRA ventana (un archivo local de la
 * app) y no de contenido externo.
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {void}
 * @throws {Error} Si el remitente no es de confianza.
 */
function assertTrustedSender(event) {
  const url = event.senderFrame?.url || '';
  if (!url.startsWith('file://')) throw new Error('Remitente IPC no autorizado');
}

/**
 * Valida una lista de ids que llega del renderer.
 * @param {*} ids
 * @returns {string[]}
 */
function validIds(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id) => typeof id === 'string' && id.length <= 64).slice(0, 10000);
}

/**
 * Registra un canal con validación de remitente y manejo de errores.
 * Los errores se devuelven al renderer como { error: 'mensaje' } en vez de
 * lanzarse, para poder mostrarlos amigablemente.
 * @param {string} channel - Nombre del canal.
 * @param {(...args: any[]) => any} handler - Función que atiende el canal.
 * @returns {void}
 */
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedSender(event);
      return { data: await handler(...args) };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });
}

/**
 * Registra todos los canales IPC de la aplicación.
 * @param {object} ctx - Contexto con todo lo necesario.
 * @param {import('../services/downloadManager').DownloadManager} ctx.manager
 * @param {() => object} ctx.getSettings
 * @param {(changes: object) => Promise<object>} ctx.updateSettings - Guarda y aplica la configuración.
 * @param {() => Electron.BrowserWindow|null} ctx.getWindow
 * @param {() => object} ctx.getServerStatus - Estado del servidor del navegador.
 * @param {(requestId: string) => object|undefined} ctx.takeBrowserRequest - Recupera cabeceras de una petición del navegador.
 * @param {import('./clipboardWatcher').ClipboardWatcher} ctx.clipboardWatcher
 * @param {string} ctx.extensionDir - Carpeta de la extensión del navegador.
 * @returns {void}
 */
function registerIpc(ctx) {
  const { manager } = ctx;

  // --- Estado inicial completo para pintar la interfaz al arrancar ---
  handle('app:get-state', () => ({
    items: manager.getAll(),
    settings: ctx.getSettings(),
    categories: CATEGORIES.map(({ id, label, icon }) => ({ id, label, icon })),
    version: app.getVersion(),
    server: ctx.getServerStatus(),
    stats: manager.getStats(),
    update: ctx.updater.state,
  }));

  // --- Descargas ---
  handle('downloads:add', (data) => {
    if (!data || typeof data !== 'object') throw new Error('Datos no válidos');
    // Si viene del navegador, recuperamos sus cabeceras (cookies, referer)
    // guardadas en el proceso principal: nunca pasan por la interfaz.
    const browser = typeof data.browserRequestId === 'string' ? ctx.takeBrowserRequest(data.browserRequestId) : null;
    return manager.add({
      url: data.url,
      fileName: typeof data.fileName === 'string' ? data.fileName : '',
      directory: typeof data.directory === 'string' ? data.directory : '',
      connections: data.connections,
      expectedHash: typeof data.expectedHash === 'string' ? data.expectedHash : '',
      scheduledAt: data.scheduledAt,
      startNow: data.startNow !== false,
      headers: browser?.headers,
      source: browser ? 'browser' : data.source,
    });
  });

  handle('downloads:probe', async (url) => {
    if (typeof url !== 'string') throw new Error('URL no válida');
    // AbortSignal.timeout corta el sondeo si el servidor tarda más de 15 s.
    const info = await probe(url.trim(), { signal: AbortSignal.timeout(15000) });
    return { fileName: info.fileName, totalBytes: info.totalBytes, resumable: info.resumable };
  });

  handle('downloads:action', async (action, ids) => {
    const list = validIds(ids);
    for (const id of list) {
      switch (action) {
        case 'pause': manager.pause(id); break;
        case 'resume': manager.resume(id); break;
        case 'cancel': await manager.cancel(id); break;
        case 'remove': await manager.remove(id, false); break;
        case 'remove-with-file': await manager.remove(id, true); break;
        default: throw new Error(`Acción desconocida: ${action}`);
      }
    }
    return true;
  });

  handle('downloads:schedule', (ids, timestamp) => {
    for (const id of validIds(ids)) manager.schedule(id, timestamp);
    return true;
  });

  handle('downloads:pause-all', () => manager.pauseAll());
  handle('downloads:resume-all', () => manager.resumeAll());
  handle('downloads:clear-completed', () => manager.clearCompleted());

  handle('downloads:open-file', async (id) => {
    const item = manager.get(id);
    if (!item?.savePath || item.status !== 'completed') throw new Error('La descarga aún no ha terminado.');
    if (!fs.existsSync(item.savePath)) throw new Error('El archivo ya no existe (¿se movió o se borró?).');
    // openPath devuelve '' si todo fue bien, o un texto de error.
    const error = await shell.openPath(item.savePath);
    if (error) throw new Error(error);
    return true;
  });

  handle('downloads:open-folder', async (id) => {
    const item = manager.get(id);
    if (!item) throw new Error('Descarga no encontrada');
    if (item.savePath && fs.existsSync(item.savePath)) {
      shell.showItemInFolder(item.savePath); // Abre el Explorador con el archivo seleccionado.
    } else {
      fs.mkdirSync(item.directory, { recursive: true });
      const error = await shell.openPath(item.directory);
      if (error) throw new Error(error);
    }
    return true;
  });

  handle('downloads:copy-url', async (id) => {
    const item = manager.get(id);
    if (!item) throw new Error('Descarga no encontrada');
    ctx.clipboardWatcher.ignore(item.url); // Que no salte la detección automática.
    await clipboard.writeText(item.url); // En Electron 44 es asíncrono (devuelve una Promise).
    return true;
  });

  // --- Configuración ---
  handle('settings:save', (changes) => ctx.updateSettings(changes));
  handle('settings:regenerate-token', () => ctx.updateSettings({ serverToken: generateToken() }));

  handle('dialog:choose-folder', async (defaultPath) => {
    const result = await dialog.showOpenDialog(ctx.getWindow(), {
      title: 'Elegir carpeta',
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('update:check', () => ctx.updater.check());
  handle('update:download', () => ctx.updater.download());
  handle('update:install', () => ctx.installUpdate());

  handle('extension:open-folder', async () => {
    const error = await shell.openPath(ctx.extensionDir);
    if (error) throw new Error(error);
    return ctx.extensionDir;
  });

  handle('shell:open-external', async (url) => {
    // Solo permitimos enlaces web (por ejemplo, la página de extensiones).
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Enlace no permitido');
    await shell.openExternal(url);
    return true;
  });
}

module.exports = { registerIpc };
