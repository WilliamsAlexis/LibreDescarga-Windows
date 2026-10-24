/**
 * format.js (interfaz)
 * -----------------------------------------------------------------------------
 * Funciones para mostrar datos de forma legible: tamaños, velocidades,
 * tiempos restantes, fechas y textos de estado.
 * También incluye escapeHtml(), imprescindible para mostrar textos que vienen
 * de fuera (nombres de archivo, URLs) sin riesgo de inyectar HTML.
 * -----------------------------------------------------------------------------
 */

/**
 * Bytes a texto legible: 1536 -> "1.5 KB".
 * @param {number|null} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : value < 10 ? 2 : 1)} ${units[unit]}`;
}

/**
 * Bytes por segundo a texto: "2.4 MB/s".
 * @param {number} bytesPerSecond
 * @returns {string}
 */
export function formatSpeed(bytesPerSecond) {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '—';
}

/**
 * Segundos a texto corto: 75 -> "1 min 15 s", 7300 -> "2 h 1 min".
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min ${s % 60} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/**
 * Fecha corta: hoy -> "14:05"; otro día -> "24/10 14:05".
 * @param {number} timestamp - Milisegundos.
 * @returns {string}
 */
export function formatDate(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toDateString() === date.toDateString();
  return today ? time : `${date.toLocaleDateString('es', { day: '2-digit', month: '2-digit' })} ${time}`;
}

/**
 * Duración en formato de reloj: 213 -> "3:33", 3725 -> "1:02:05".
 * @param {number|null} seconds
 * @returns {string} Cadena vacía si no se conoce.
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * Fecha y hora completa: "sábado, 24 de octubre de 2026, 14:05".
 * @param {number} timestamp
 * @returns {string}
 */
export function formatDateLong(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString('es', { dateStyle: 'full', timeStyle: 'short' });
}

/**
 * Porcentaje completado (0-100) o null si el tamaño es desconocido.
 * @param {object} item
 * @returns {number|null}
 */
export function percentOf(item) {
  if (item.status === 'completed') return 100;
  if (!item.totalBytes) return null;
  return Math.min(100, (item.downloadedBytes / item.totalBytes) * 100);
}

/** Texto visible de cada estado. */
export const STATUS_LABELS = {
  queued: 'En cola',
  scheduled: 'Programada',
  downloading: 'Descargando',
  merging: 'Uniendo partes',
  paused: 'En pausa',
  completed: 'Completada',
  error: 'Error',
  canceled: 'Cancelada',
};

/** Icono de Lucide para cada estado. */
export const STATUS_ICONS = {
  queued: 'hourglass',
  scheduled: 'calendar-clock',
  downloading: 'loader-circle',
  merging: 'merge',
  paused: 'circle-pause',
  completed: 'circle-check',
  error: 'circle-alert',
  canceled: 'circle-x',
};

/**
 * Escapa los caracteres especiales de HTML. Ejemplo:
 *   '<img onerror=...>' -> '&lt;img onerror=...&gt;'
 * Así un nombre de archivo malicioso se muestra como texto y no se ejecuta.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/**
 * Convierte una fecha a formato de <input type="datetime-local"> ("2026-10-24T14:05").
 * @param {Date} date
 * @returns {string}
 */
export function toDateTimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
