/**
 * sleep.js
 * -----------------------------------------------------------------------------
 * Pequeña utilidad para "esperar" un tiempo sin bloquear el programa.
 * Se puede cancelar con un AbortSignal (útil cuando el usuario pausa una
 * descarga mientras estamos esperando para reintentar).
 * -----------------------------------------------------------------------------
 */

/**
 * Espera `ms` milisegundos.
 * @param {number} ms - Tiempo a esperar en milisegundos.
 * @param {AbortSignal} [signal] - Si se aborta, la espera termina con un error.
 * @returns {Promise<void>} Se resuelve al terminar la espera.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    // Si ya estaba abortado, ni siquiera empezamos a esperar.
    if (signal?.aborted) return reject(signal.reason ?? new Error('Abortado'));

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    // Si alguien aborta mientras esperamos, cancelamos el temporizador.
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Abortado'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { sleep };
