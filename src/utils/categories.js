/**
 * categories.js
 * -----------------------------------------------------------------------------
 * Define las CATEGORÍAS de descarga (Videos, Música, Documentos, Programas,
 * Comprimidos y Otros) y sabe a cuál pertenece un archivo según su extensión.
 *
 * Cada categoría tiene su propia carpeta de destino (por ejemplo, los .mp4
 * van a "Descargas/LibreDescarga/Videos").
 * -----------------------------------------------------------------------------
 */

const path = require('node:path');

/**
 * Lista de categorías. El orden es el que se muestra en la barra lateral.
 * - id:      identificador interno (no cambia nunca).
 * - label:   nombre visible y nombre de la subcarpeta por defecto.
 * - icon:    nombre del icono de Lucide que usa la interfaz.
 * - extensions: extensiones (sin punto, en minúsculas) que pertenecen a ella.
 */
const CATEGORIES = [
  {
    id: 'video',
    label: 'Videos',
    icon: 'film',
    extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'vob'],
  },
  {
    id: 'music',
    label: 'Música',
    icon: 'music',
    extensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'opus', 'aiff', 'mid', 'midi'],
  },
  {
    id: 'documents',
    label: 'Documentos',
    icon: 'file-text',
    extensions: [
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'rtf', 'csv',
      'epub', 'mobi', 'md', 'json', 'xml', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tif', 'tiff', 'psd',
    ],
  },
  {
    id: 'programs',
    label: 'Programas',
    icon: 'app-window',
    extensions: ['exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'apk', 'xapk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'jar'],
  },
  {
    id: 'compressed',
    label: 'Comprimidos',
    icon: 'file-archive',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'img', 'cab'],
  },
  {
    id: 'other',
    label: 'Otros',
    icon: 'file',
    extensions: [],
  },
];

/**
 * Diccionario "extensión -> id de categoría" construido una sola vez para
 * que buscar sea instantáneo (en vez de recorrer todas las listas cada vez).
 */
const EXTENSION_MAP = new Map();
for (const category of CATEGORIES) {
  for (const ext of category.extensions) EXTENSION_MAP.set(ext, category.id);
}

/**
 * Obtiene la extensión de un nombre de archivo, en minúsculas y sin punto.
 * @param {string} fileName - Por ejemplo "Película.MP4".
 * @returns {string} Por ejemplo "mp4" (o "" si no tiene extensión).
 */
function getExtension(fileName) {
  return path.extname(fileName || '').slice(1).toLowerCase();
}

/**
 * Decide la categoría de un archivo según su extensión.
 * @param {string} fileName - Nombre del archivo.
 * @returns {string} id de la categoría ("video", "music", ..., u "other").
 */
function categorize(fileName) {
  return EXTENSION_MAP.get(getExtension(fileName)) || 'other';
}

/**
 * Devuelve la carpeta donde se guardan los archivos de una categoría.
 * Si el usuario configuró una carpeta específica para esa categoría se usa
 * esa; si no, se usa una subcarpeta con el nombre de la categoría dentro de
 * la carpeta de descargas por defecto.
 * @param {string} categoryId - id de la categoría.
 * @param {object} settings - Configuración actual (downloadDir y categoryDirs).
 * @returns {string} Ruta absoluta de la carpeta.
 */
function getCategoryDirectory(categoryId, settings) {
  const custom = settings.categoryDirs?.[categoryId];
  if (custom) return custom;
  const category = CATEGORIES.find((c) => c.id === categoryId) || CATEGORIES.at(-1);
  return path.join(settings.downloadDir, category.label);
}

/**
 * ¿Parece esta URL un archivo descargable? Se usa para la detección
 * automática del portapapeles: solo avisamos si la URL termina en una
 * extensión conocida (no queremos saltar con cada página web copiada).
 * @param {string} text - Texto a comprobar.
 * @returns {boolean}
 */
function looksLikeDownloadUrl(text) {
  try {
    const url = new URL(String(text).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return EXTENSION_MAP.has(getExtension(decodeURIComponent(url.pathname)));
  } catch {
    // new URL() lanza un error si el texto no es una URL válida.
    return false;
  }
}

module.exports = { CATEGORIES, categorize, getExtension, getCategoryDirectory, looksLikeDownloadUrl };
