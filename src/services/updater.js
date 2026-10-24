/**
 * updater.js
 * -----------------------------------------------------------------------------
 * ACTUALIZACIONES AUTOMÁTICAS con electron-updater.
 *
 * ¿Cómo funciona?
 *   1. Cuando publicas una versión nueva en GitHub (Releases), subes también el
 *      archivo "latest.yml" que genera electron-builder. Ese archivo dice cuál
 *      es la última versión y su huella (hash) para comprobar que no se corrompió.
 *   2. La app instalada lee ese archivo, compara versiones y, si hay una más
 *      nueva, avisa al usuario. NO descarga nada sin que el usuario lo pida.
 *   3. Al terminar de descargar, el usuario decide cuándo reiniciar e instalar.
 *
 * Esta clase solo se ocupa de la lógica y de emitir el ESTADO actual; quien la
 * usa (main.js) se encarga de enseñárselo a la interfaz.
 *
 * Estados posibles (campo `status`):
 *   unavailable | idle | checking | available | none | downloading | downloaded | error
 * -----------------------------------------------------------------------------
 */

const { EventEmitter } = require('node:events');

class Updater extends EventEmitter {
  /**
   * @param {object} options
   * @param {boolean} options.enabled - false en desarrollo (la app no está empaquetada).
   * @param {string} options.currentVersion - Versión instalada, p. ej. "1.0.0".
   * @param {object} [options.autoUpdater] - Inyectable para las pruebas; por defecto el de electron-updater.
   */
  constructor({ enabled, currentVersion, autoUpdater = null }) {
    super();
    this.currentVersion = currentVersion;
    this.state = {
      status: enabled ? 'idle' : 'unavailable',
      currentVersion,
      version: null, // Versión nueva encontrada
      notes: '', // Notas de la versión
      percent: 0, // Progreso de la descarga (0-100)
      error: null,
    };
    this.au = null;
    if (!enabled) return;

    // Se carga aquí y no arriba del archivo para no exigir el módulo en desarrollo.
    this.au = autoUpdater || require('electron-updater').autoUpdater;
    this.au.autoDownload = false; // El usuario decide si descarga.
    this.au.autoInstallOnAppQuit = true; // Si ya se descargó, se instala al cerrar la app.
    this.au.logger = null;
    this.#wire();
  }

  /**
   * Conecta los eventos de electron-updater con nuestro estado.
   * @returns {void}
   */
  #wire() {
    this.au.on('checking-for-update', () => this.#set({ status: 'checking', error: null }));
    this.au.on('update-available', (info) => this.#set({
      status: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
    }));
    this.au.on('update-not-available', () => this.#set({ status: 'none', version: null }));
    this.au.on('download-progress', (p) => this.#set({ status: 'downloading', percent: Math.round(p.percent) }));
    this.au.on('update-downloaded', (info) => this.#set({ status: 'downloaded', version: info.version, percent: 100 }));
    this.au.on('error', (err) => this.#set({ status: 'error', error: Updater.friendlyError(err) }));
  }

  /**
   * Actualiza el estado y avisa a quien escuche.
   * @param {object} patch - Campos a cambiar.
   * @returns {void}
   */
  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.state);
  }

  /**
   * Convierte los errores técnicos de red/GitHub en mensajes entendibles.
   * @param {Error} err
   * @returns {string}
   */
  static friendlyError(err) {
    const text = String(err?.message || err);
    if (/404|latest\.yml|Cannot find/i.test(text)) return 'Todavía no hay versiones publicadas en GitHub.';
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::/i.test(text)) return 'No se pudo conectar. Revisa tu conexión a internet.';
    if (/sha512|checksum/i.test(text)) return 'La descarga está dañada (la huella no coincide). Inténtalo de nuevo.';
    return text.split('\n')[0].slice(0, 200);
  }

  /**
   * Busca si hay una versión nueva. Nunca lanza: los errores quedan en el estado.
   * @returns {Promise<object>} Estado resultante.
   */
  async check() {
    if (!this.au) return this.state;
    // Si ya se está comprobando o descargando, no repetimos.
    if (['checking', 'downloading', 'downloaded'].includes(this.state.status)) return this.state;
    try {
      await this.au.checkForUpdates();
    } catch (err) {
      this.#set({ status: 'error', error: Updater.friendlyError(err) });
    }
    return this.state;
  }

  /**
   * Descarga la versión encontrada (solo si hay una disponible).
   * @returns {Promise<object>} Estado resultante.
   */
  async download() {
    if (!this.au || this.state.status !== 'available') return this.state;
    this.#set({ status: 'downloading', percent: 0 });
    try {
      await this.au.downloadUpdate();
    } catch (err) {
      this.#set({ status: 'error', error: Updater.friendlyError(err) });
    }
    return this.state;
  }

  /**
   * Cierra la app e instala la versión ya descargada.
   * @returns {boolean} true si se pidió instalar.
   */
  install() {
    if (!this.au || this.state.status !== 'downloaded') return false;
    // (isSilent=false: se ve el instalador; isForceRunAfter=true: reabre la app al terminar)
    this.au.quitAndInstall(false, true);
    return true;
  }
}

module.exports = { Updater };
