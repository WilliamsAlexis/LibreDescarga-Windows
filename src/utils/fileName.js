/**
 * fileName.js
 * -----------------------------------------------------------------------------
 * Todo lo relacionado con NOMBRES DE ARCHIVO:
 *   - Sacar el nombre de la cabecera HTTP "Content-Disposition" o de la URL.
 *   - Limpiar caracteres que Windows no permite (\ / : * ? " < > |).
 *   - Añadir la extensión correcta si falta (según el Content-Type).
 *   - Evitar sobrescribir archivos: "video.mp4" -> "video (1).mp4".
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');

/** Nombres reservados por Windows que no se pueden usar como archivo. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Extensiones típicas según el tipo MIME, por si la URL no trae extensión. */
const MIME_EXTENSIONS = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/gzip': 'gz',
  'application/x-msdownload': 'exe',
  'application/x-msi': 'msi',
  'application/vnd.android.package-archive': 'apk',
  'application/json': 'json',
  'application/x-iso9660-image': 'iso',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

/**
 * Quita de un nombre los caracteres que Windows no acepta y lo recorta.
 * @param {string} name - Nombre original.
 * @returns {string} Nombre seguro (nunca vacío: si queda vacío devuelve "descarga").
 */
function sanitizeFileName(name) {
  let clean = String(name || '')
    // Caracteres prohibidos en Windows y caracteres de control (0-31).
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    // Windows no permite que un nombre termine en punto o espacio.
    .replace(/[. ]+$/, '');

  // Limitamos la longitud (Windows tiene un máximo de ruta de ~260 caracteres).
  if (clean.length > 180) {
    const ext = path.extname(clean).slice(0, 16);
    clean = clean.slice(0, 180 - ext.length) + ext;
  }

  // Si el nombre (sin extensión) es reservado, le añadimos un guion bajo.
  const base = path.parse(clean).name;
  if (RESERVED_NAMES.test(base)) clean = `_${clean}`;

  return clean || 'descarga';
}

/**
 * Extrae el nombre de archivo de la cabecera Content-Disposition.
 * Ejemplos que entiende:
 *   attachment; filename="informe.pdf"
 *   attachment; filename*=UTF-8''informe%20final.pdf   (con acentos/espacios)
 * @param {string|undefined} header - Valor de la cabecera.
 * @returns {string|null} Nombre encontrado o null.
 */
function fileNameFromContentDisposition(header) {
  if (!header) return null;
  try {
    // 1) Forma moderna (RFC 5987): filename*=charset''valor-codificado
    const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
    if (star) return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));

    // 2) Forma clásica: filename="valor" o filename=valor
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
    if (plain) return (plain[2] ?? plain[1]).trim();
  } catch {
    // decodeURIComponent puede fallar con secuencias mal formadas: lo ignoramos.
  }
  return null;
}

/**
 * Obtiene un nombre a partir de la última parte de la ruta de la URL.
 * "https://ejemplo.com/archivos/mi%20video.mp4?x=1" -> "mi video.mp4"
 * @param {string} url - URL de descarga.
 * @returns {string|null} Nombre o null si la URL no tiene ruta útil.
 */
function fileNameFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return null;
  }
}

/**
 * Decide el nombre final del archivo combinando todas las pistas.
 * Prioridad: Content-Disposition > URL final (tras redirecciones) > "descarga".
 * Si el nombre no tiene extensión, se la añade según el Content-Type.
 * @param {object} info
 * @param {string} info.url - URL (final, tras redirecciones).
 * @param {string} [info.contentDisposition] - Cabecera Content-Disposition.
 * @param {string} [info.contentType] - Cabecera Content-Type.
 * @returns {string} Nombre limpio y con extensión si fue posible.
 */
function resolveFileName({ url, contentDisposition, contentType }) {
  let name = fileNameFromContentDisposition(contentDisposition) || fileNameFromUrl(url) || 'descarga';
  name = sanitizeFileName(name);

  if (!path.extname(name) && contentType) {
    // "video/mp4; charset=..." -> "video/mp4"
    const mime = contentType.split(';')[0].trim().toLowerCase();
    const ext = MIME_EXTENSIONS[mime];
    if (ext) name = `${name}.${ext}`;
  }
  return name;
}

/**
 * Busca una ruta libre: si "carpeta/video.mp4" ya existe (en disco o
 * reservada por otra descarga), prueba "video (1).mp4", "video (2).mp4"...
 * @param {string} directory - Carpeta de destino.
 * @param {string} fileName - Nombre deseado.
 * @param {(fullPath: string) => boolean} [isReserved] - Función opcional que dice
 *        si otra descarga ya "apartó" esa ruta.
 * @returns {string} Ruta completa disponible.
 */
function uniquePath(directory, fileName, isReserved = () => false) {
  const { name, ext } = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  let counter = 1;
  // También comprobamos la carpeta temporal de partes (".ldtmp") para no
  // mezclar las partes de dos descargas con el mismo nombre.
  while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.ldtmp`) || isReserved(candidate)) {
    candidate = path.join(directory, `${name} (${counter})${ext}`);
    counter++;
  }
  return candidate;
}

module.exports = {
  sanitizeFileName,
  fileNameFromUrl,
  resolveFileName,
  uniquePath,
};
