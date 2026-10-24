/**
 * hash.js
 * -----------------------------------------------------------------------------
 * Verificación de integridad: calcula el hash SHA-256 de un archivo para
 * compararlo con el que publica la página de descarga. Si coinciden, el
 * archivo llegó completo y sin alteraciones.
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

/**
 * Calcula el SHA-256 de un archivo leyéndolo por trozos (stream), así no
 * hace falta cargar archivos de varios GB en memoria.
 * @param {string} filePath - Ruta del archivo.
 * @returns {Promise<string>} Hash en hexadecimal (64 caracteres, minúsculas).
 */
async function sha256File(filePath) {
  try {
    const hash = crypto.createHash('sha256');
    // pipeline conecta el lector del archivo con el "hasheador" y espera
    // a que termine, propagando cualquier error de lectura.
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
  } catch (err) {
    throw new Error(`No se pudo calcular el hash de "${filePath}": ${err.message}`);
  }
}

/**
 * Limpia y valida un hash escrito por el usuario.
 * Acepta mayúsculas, espacios y el prefijo "sha256:".
 * @param {string} value - Texto introducido.
 * @returns {string|null} Hash normalizado, "" si está vacío, o null si no es válido.
 */
function normalizeSha256(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/^sha-?256:/, '').replace(/\s+/g, '');
  if (!clean) return '';
  return /^[a-f0-9]{64}$/.test(clean) ? clean : null;
}

module.exports = { sha256File, normalizeSha256 };
