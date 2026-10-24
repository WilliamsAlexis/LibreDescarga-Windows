/**
 * speedLimiter.js
 * -----------------------------------------------------------------------------
 * LIMITADOR DE VELOCIDAD GLOBAL basado en el algoritmo "token bucket"
 * (cubo de fichas).
 *
 * Idea sencilla:
 *   - Imagina un cubo que se llena de "fichas" a un ritmo fijo: tantas fichas
 *     por segundo como bytes por segundo permitimos.
 *   - Cada vez que una conexión recibe N bytes, debe "pagar" N fichas.
 *   - Si no hay suficientes fichas, la conexión queda en DEUDA y espera el
 *     tiempo necesario para que el cubo se rellene.
 *
 * Como TODAS las conexiones de TODAS las descargas comparten el mismo cubo,
 * la suma de sus velocidades nunca supera el límite configurado.
 * -----------------------------------------------------------------------------
 */

const { sleep } = require('../utils/sleep');

class SpeedLimiter {
  /**
   * @param {number} [bytesPerSecond=0] - Límite en bytes/segundo (0 = sin límite).
   */
  constructor(bytesPerSecond = 0) {
    this.rate = 0;
    this.tokens = 0;
    this.lastRefill = Date.now();
    this.setRate(bytesPerSecond);
  }

  /**
   * Cambia el límite en caliente (sin reiniciar las descargas).
   * @param {number} bytesPerSecond - Nuevo límite (0 = sin límite).
   * @returns {void}
   */
  setRate(bytesPerSecond) {
    this.rate = Math.max(0, Number(bytesPerSecond) || 0);
    // Empezamos con el cubo vacío para que el límite se note desde ya.
    this.tokens = 0;
    this.lastRefill = Date.now();
  }

  /**
   * Añade al cubo las fichas generadas desde la última vez.
   * El cubo tiene un tamaño máximo (1/4 de segundo de datos) para evitar que,
   * tras un rato sin descargar, se acumulen fichas y haya un "pico" enorme.
   * @returns {void}
   */
  refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    const capacity = this.rate / 4;
    this.tokens = Math.min(capacity, this.tokens + elapsedSeconds * this.rate);
  }

  /**
   * "Paga" el paso de `bytes` bytes. Si hay deuda, espera lo necesario.
   * @param {number} bytes - Bytes que se acaban de recibir.
   * @param {AbortSignal} [signal] - Para dejar de esperar si se pausa la descarga.
   * @returns {Promise<void>} Se resuelve cuando la conexión puede continuar.
   */
  async consume(bytes, signal) {
    if (!this.rate) return; // Sin límite: no esperamos nunca.

    this.refill();
    this.tokens -= bytes;

    // Mientras haya deuda, dormimos en pasos cortos (máx. 250 ms) para poder
    // reaccionar rápido si el usuario cambia o quita el límite.
    while (this.rate && this.tokens < 0) {
      const waitMs = Math.min(250, (-this.tokens / this.rate) * 1000);
      await sleep(Math.max(1, waitMs), signal);
      this.refill();
    }
  }
}

module.exports = { SpeedLimiter };
