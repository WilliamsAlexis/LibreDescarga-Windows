/**
 * scheduler.js
 * -----------------------------------------------------------------------------
 * PROGRAMADOR de descargas: cada pocos segundos mira si alguna descarga
 * programada ("scheduled") ya debe empezar y, si es así, la pone en la cola.
 *
 * ¿Por qué revisar periódicamente en vez de usar un setTimeout exacto por
 * descarga? Porque si el PC entra en suspensión los temporizadores largos
 * pueden retrasarse; revisando la hora real cada 5 s no se nos escapa ninguna.
 * -----------------------------------------------------------------------------
 */

class Scheduler {
  /**
   * @param {import('./downloadManager').DownloadManager} manager - Gestor de descargas.
   * @param {(items: object[]) => void} [onStarted] - Se llama con las descargas que acaban de arrancar.
   * @param {number} [intervalMs=5000] - Cada cuánto revisar.
   */
  constructor(manager, onStarted = () => {}, intervalMs = 5000) {
    this.manager = manager;
    this.onStarted = onStarted;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  /**
   * Empieza a revisar periódicamente (y hace una primera revisión inmediata,
   * por si alguna hora programada pasó mientras la app estaba cerrada).
   * @returns {void}
   */
  start() {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /** Deja de revisar. */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Una revisión: pide al gestor que arranque lo que ya toca.
   * @returns {void}
   */
  tick() {
    try {
      const started = this.manager.checkSchedule(Date.now());
      if (started.length) this.onStarted(started);
    } catch (err) {
      console.error('Error en el programador:', err);
    }
  }
}

module.exports = { Scheduler };
