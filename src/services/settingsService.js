/**
 * settingsService.js
 * -----------------------------------------------------------------------------
 * Define la CONFIGURACIÓN de la aplicación: sus valores por defecto y cómo
 * validar los cambios que llegan desde la pantalla de Configuración.
 *
 * Validar es importante: nunca debemos confiar ciegamente en datos que llegan
 * de la interfaz (por ejemplo, alguien podría enviar "conexiones = 9999").
 * -----------------------------------------------------------------------------
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { CATEGORIES } = require('../utils/categories');
const { COOKIE_BROWSERS } = require('./mediaTools');

/** Colores de acento disponibles (cada uno tiene sus reglas en styles.css). */
const ACCENTS = ['blue', 'green', 'red', 'purple', 'orange', 'pink', 'teal', 'slate'];

/**
 * Genera un token aleatorio y difícil de adivinar para la extensión del navegador.
 * @returns {string} 32 caracteres hexadecimales.
 */
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Crea la configuración por defecto.
 * @param {string} downloadsPath - Carpeta "Descargas" del usuario.
 * @returns {object} Configuración completa con valores iniciales.
 */
function createDefaultSettings(downloadsPath) {
  return {
    downloadDir: path.join(downloadsPath, 'LibreDescarga'), // Carpeta base
    categoryDirs: Object.fromEntries(CATEGORIES.map((c) => [c.id, ''])), // '' = subcarpeta automática
    connections: 8, // Conexiones por descarga (1-16)
    maxConcurrent: 3, // Descargas simultáneas (1-10)
    speedLimitKBps: 0, // Límite global en KB/s (0 = sin límite)
    maxRetries: 5, // Reintentos automáticos por conexión
    theme: 'system', // 'system' | 'light' | 'dark'
    accent: 'blue', // Color de la aplicación (ver ACCENTS)
    clipboardWatch: true, // Detectar URLs copiadas
    minimizeToTray: true, // Al cerrar la ventana, ir a la bandeja
    notifications: true, // Avisar al terminar cada descarga
    serverEnabled: true, // Servidor local para la extensión
    serverPort: 6801, // Puerto del servidor local
    serverToken: generateToken(), // Contraseña compartida con la extensión
    browserConfirm: true, // Mostrar diálogo antes de añadir descargas del navegador
    autoUpdateCheck: true, // Buscar versiones nuevas al abrir la app
    cookiesBrowser: '', // Navegador del que yt-dlp lee las cookies ('' = ninguno)
  };
}

/**
 * Convierte un valor a entero y lo encierra entre un mínimo y un máximo.
 * @param {*} value - Valor recibido.
 * @param {number} min
 * @param {number} max
 * @param {number} fallback - Valor si `value` no es un número.
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Mezcla los cambios recibidos con la configuración actual, validando cada campo.
 * Los campos desconocidos se ignoran.
 * @param {object} changes - Cambios propuestos (puede ser parcial).
 * @param {object} current - Configuración actual completa.
 * @returns {object} Nueva configuración completa y válida.
 */
function sanitizeSettings(changes, current) {
  const next = { ...current };
  const c = changes || {};
  const isText = (v) => typeof v === 'string';

  if (isText(c.downloadDir) && c.downloadDir.trim()) next.downloadDir = path.resolve(c.downloadDir.trim());
  if (c.categoryDirs && typeof c.categoryDirs === 'object') {
    next.categoryDirs = { ...current.categoryDirs };
    for (const { id } of CATEGORIES) {
      const value = c.categoryDirs[id];
      if (isText(value)) next.categoryDirs[id] = value.trim() ? path.resolve(value.trim()) : '';
    }
  }
  if ('connections' in c) next.connections = clampInt(c.connections, 1, 16, current.connections);
  if ('maxConcurrent' in c) next.maxConcurrent = clampInt(c.maxConcurrent, 1, 10, current.maxConcurrent);
  if ('speedLimitKBps' in c) next.speedLimitKBps = clampInt(c.speedLimitKBps, 0, 10_000_000, current.speedLimitKBps);
  if ('maxRetries' in c) next.maxRetries = clampInt(c.maxRetries, 0, 20, current.maxRetries);
  if (['system', 'light', 'dark'].includes(c.theme)) next.theme = c.theme;
  if (ACCENTS.includes(c.accent)) next.accent = c.accent;
  if ('serverPort' in c) next.serverPort = clampInt(c.serverPort, 1024, 65535, current.serverPort);
  if (isText(c.cookiesBrowser) && (c.cookiesBrowser === '' || COOKIE_BROWSERS.includes(c.cookiesBrowser))) next.cookiesBrowser = c.cookiesBrowser;
  if (isText(c.serverToken) && /^[a-zA-Z0-9_-]{16,128}$/.test(c.serverToken)) next.serverToken = c.serverToken;

  for (const key of ['clipboardWatch', 'minimizeToTray', 'notifications', 'serverEnabled', 'browserConfirm', 'autoUpdateCheck']) {
    if (typeof c[key] === 'boolean') next[key] = c[key];
  }
  return next;
}

module.exports = { createDefaultSettings, sanitizeSettings, generateToken, ACCENTS };
