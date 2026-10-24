/**
 * selfTest.js
 * -----------------------------------------------------------------------------
 * HERRAMIENTA DE DESARROLLO: autoprueba de la aplicación real.
 *
 * Solo se activa si se definen variables de entorno; en uso normal no hace
 * nada. Sirve para comprobar automáticamente que la app arranca, que la
 * interfaz se pinta bien y que una descarga real funciona dentro de Electron.
 *
 *   LD_USER_DATA=<carpeta>          Usa otra carpeta de datos (no toca tu historial).
 *   LD_SELFTEST_URL=<url>           Descarga esa URL y escribe el resultado.
 *   LD_SELFTEST_SCRIPT=<archivo.js> Ejecuta ese código en la interfaz (p. ej. abrir un diálogo).
 *   LD_SELFTEST_SCREENSHOT=<png>    Guarda una captura de la ventana.
 *   LD_SELFTEST_EXIT=0              No cerrar la app al terminar.
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const { sleep } = require('../utils/sleep');

/** Estados en los que una descarga ya no va a cambiar sola. */
const FINAL = new Set(['completed', 'error', 'canceled', 'paused']);

/**
 * Espera a que una descarga llegue a un estado final.
 * @param {import('../services/downloadManager').DownloadManager} manager
 * @param {string} id
 * @param {number} timeoutMs
 * @returns {Promise<object>} La descarga en su estado final.
 */
function waitForFinal(manager, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tiempo de espera agotado')), timeoutMs);
    const onUpdate = (item) => {
      if (item.id === id && FINAL.has(item.status)) {
        clearTimeout(timer);
        manager.off('item-updated', onUpdate);
        resolve(item);
      }
    };
    manager.on('item-updated', onUpdate);
  });
}

/**
 * Ejecuta la autoprueba si está activada.
 * @param {object} ctx
 * @param {Electron.App} ctx.app
 * @param {Electron.BrowserWindow} ctx.window
 * @param {import('../services/downloadManager').DownloadManager} ctx.manager
 * @returns {void}
 */
function runSelfTest({ app, window, manager }) {
  const { LD_SELFTEST_URL: url, LD_SELFTEST_SCRIPT: script, LD_SELFTEST_SCREENSHOT: shot } = process.env;
  if (!url && !script && !shot) return;
  const log = (...args) => console.log('[selftest]', ...args);

  const execute = async () => {
    try {
      if (url) {
        const item = manager.add({ url, connections: 8 });
        log('descarga añadida', item.id);
        const result = await waitForFinal(manager, item.id, 180000);
        log('resultado', JSON.stringify({
          status: result.status, fileName: result.fileName, totalBytes: result.totalBytes,
          downloadedBytes: result.downloadedBytes, segments: result.segments.length,
          resumable: result.resumable, savePath: result.savePath, error: result.error,
        }));
      }
      await sleep(1200); // Dejamos que la interfaz termine de pintar.
      if (script) {
        const value = await window.webContents.executeJavaScript(fs.readFileSync(script, 'utf8'));
        log('script ejecutado', value === undefined ? '' : JSON.stringify(value));
        await sleep(700);
      }
      if (shot) {
        const image = await window.webContents.capturePage();
        fs.writeFileSync(shot, image.toPNG());
        log('captura guardada', shot);
      }
    } catch (err) {
      log('ERROR', err.stack || err.message);
      process.exitCode = 1;
    } finally {
      if (process.env.LD_SELFTEST_EXIT !== '0') app.quit();
    }
  };

  // Si la página ya terminó de cargar, empezamos ya; si no, esperamos a que acabe.
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', execute);
  else execute();
}

module.exports = { runSelfTest };
