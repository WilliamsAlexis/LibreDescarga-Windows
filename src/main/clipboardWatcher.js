/**
 * clipboardWatcher.js
 * -----------------------------------------------------------------------------
 * DETECCIÓN AUTOMÁTICA DEL PORTAPAPELES.
 *
 * Cada segundo leemos el texto del portapapeles. Si cambió y parece la URL
 * de un archivo descargable (termina en .zip, .mp4, .pdf...), avisamos para
 * que la interfaz ofrezca descargarlo.
 *
 * Electron no tiene un evento "el portapapeles cambió", por eso consultamos
 * periódicamente (es una operación muy barata).
 *
 * OJO: desde Electron 44, clipboard.readText() es ASÍNCRONO (devuelve una
 * Promise), así que siempre usamos `await`.
 * -----------------------------------------------------------------------------
 */

const { clipboard } = require('electron');
const { looksLikeDownloadUrl } = require('../utils/categories');

class ClipboardWatcher {
  /**
   * @param {(url: string) => void} onUrl - Se llama con cada URL descargable nueva.
   * @param {number} [intervalMs=1000] - Cada cuánto mirar el portapapeles.
   */
  constructor(onUrl, intervalMs = 1000) {
    this.onUrl = onUrl;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastText = null; // null = aún no hemos leído el contenido inicial
    this.checking = false; // Evita solapar lecturas si una tarda más de 1 s
  }

  /**
   * Empieza a vigilar. Lo que ya hubiera copiado antes NO dispara aviso.
   * @returns {void}
   */
  start() {
    if (this.timer) return;
    this.lastText = null;
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.check(); // Primera lectura: solo memoriza el contenido actual.
  }

  /** Deja de vigilar. */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Indica que el texto lo copió la propia app (p. ej. "Copiar URL"),
   * para no avisar de algo que el usuario ya tiene en la lista.
   * @param {string} text
   * @returns {void}
   */
  ignore(text) {
    this.lastText = text;
  }

  /**
   * Lee el portapapeles sin lanzar errores.
   * @returns {Promise<string>}
   */
  async read() {
    try {
      return (await clipboard.readText()) || '';
    } catch {
      return ''; // Otro programa puede tener el portapapeles bloqueado un instante.
    }
  }

  /**
   * Una comprobación: ¿hay texto nuevo con pinta de descarga?
   * @returns {Promise<void>}
   */
  async check() {
    if (this.checking) return;
    this.checking = true;
    try {
      const text = await this.read();
      const isFirstRead = this.lastText === null;
      if (text === this.lastText) return;
      this.lastText = text;
      if (isFirstRead || !this.timer) return; // No avisamos de lo que ya estaba copiado.
      const trimmed = text.trim();
      if (looksLikeDownloadUrl(trimmed)) this.onUrl(trimmed);
    } catch (err) {
      console.error('Error leyendo el portapapeles:', err);
    } finally {
      this.checking = false;
    }
  }
}

module.exports = { ClipboardWatcher };
