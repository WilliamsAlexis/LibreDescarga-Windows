/**
 * format.js
 * -----------------------------------------------------------------------------
 * Funciones para mostrar números de forma legible en el proceso principal
 * (bandeja y notificaciones). La interfaz tiene su propia copia en
 * src/renderer/js/format.js porque, por seguridad, el renderer no puede
 * cargar archivos de Node con require().
 * -----------------------------------------------------------------------------
 */

/**
 * Convierte bytes a texto: 1536 -> "1.5 KB".
 * @param {number|null} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Convierte bytes por segundo a texto: 2097152 -> "2.0 MB/s".
 * @param {number} bytesPerSecond
 * @returns {string}
 */
function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond || 0)}/s`;
}

module.exports = { formatBytes, formatSpeed };
